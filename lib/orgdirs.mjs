// Per-organization working directories for the desktop runner.
//
// Each org's turns run in a dedicated local folder (default ~/adania/<github-org-slug>) instead of $HOME, so
// one org's repos/files live apart from another's. The map persists to ~/.adania/settings.json (0600, beside
// the shared session credential) keyed by organizationId — the only stable id present in BOTH the org list
// (at prompt time) AND reachable from a turn (the payload carries organizationId; legacy turns resolve it via
// the bot index). NEVER keyed by organizationName: that is free-form, admin-editable display text, so a
// rename would orphan the mapping and re-create the folder.
//
// IMPORTANT: cwd is a CONVENIENCE / organization boundary, NOT a security sandbox. The runner runs
// bypassPermissions with the full Claude Code toolset, so an agent can still read/write any absolute path and
// reach another org's folder. That is the deliberate single-user full-capability design — all orgs belong to
// one operator. Real isolation would require OS-level separation (separate accounts/containers).
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, writeFile, chmod, stat, copyFile, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { provisionKb } from "./kb.mjs";

const HOME = process.env.HOME || homedir();
const SETTINGS_FILE = path.join(HOME, ".adania", "settings.json");
// Where turns whose org can't be determined at all run — never $HOME (a full-capability agent loose in the
// home tree defeats the whole point of per-org folders).
export const QUARANTINE_DIR = path.join(HOME, "adania", "_unassigned");

// Per-agent folders we've already kicked KB provisioning for THIS process — keyed by resolved abs dir. Prevents
// duplicate provisioning when a dir is seeded at startup and then touched again by a turn / reconnect.
const provisioned = new Set();
// In-flight (or just-finished) KB provisioning promises, keyed by resolved abs dir, so that dir's FIRST turn
// can wait for it (see awaitProvisioning) — the per-agent turn queue then keeps the agent out of a half-cloned
// tree.
const provisioningPromises = new Map();

// Serialize settings.json mutation: load→merge→save is a read-modify-write, so two concurrent first-writes
// for different orgs could clobber each other. Each writer re-reads the latest on-disk state INSIDE the lock.
let settingsLock = Promise.resolve();
function withSettingsLock(fn) {
  const next = settingsLock.then(fn, fn);
  settingsLock = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function loadSettings() {
  try {
    const j = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
async function saveSettings(s) {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true }).catch(() => {});
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  await chmod(SETTINGS_FILE, 0o600).catch(() => {});
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Expand a leading ~, then resolve to an ABSOLUTE path. readline does not expand ~, and a relative path would
// resolve against the runner's launch cwd (unpredictable under `npx`) — so pin it at input time.
export function normalizeDir(input) {
  let p = String(input ?? "").trim();
  if (!p) return null;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
  return path.resolve(p);
}

// Reduce a slug/name to one safe path segment, or null if nothing usable remains (collapses unsafe chars,
// strips leading/trailing dots/hyphens so ".." and hidden dirs can't appear).
export function sanitizeSegment(s) {
  const seg = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  return seg || null;
}

// A real GitHub org login: 1–39 chars, alphanumeric or single interior hyphens, no leading/trailing hyphen.
// We only do GitHub <slug>/kb operations when the stored value (unvalidated admin free-text) looks like one.
export function validGithubLogin(s) {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(String(s ?? "").trim());
}

// The default working dir for an org: ~/adania/<github-org-slug>, falling back to a slugified org name, then
// the (sanitized) org UUID — so a folder ALWAYS resolves, even for an org with no GitHub slug. organizationId
// is sanitized too: it is a DB UUID today, but the unknown-org turn path can pass a raw id straight through.
export function defaultDirFor(org) {
  const leaf =
    sanitizeSegment(org?.githubOrgSlug) || sanitizeSegment(org?.organizationName) || sanitizeSegment(org?.organizationId) || "_unknown";
  return path.join(HOME, "adania", leaf);
}

function promptDir(org, def) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Working directory for ${org.organizationName ?? org.organizationId} [${def}]: `, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

// Make `dir` usable, or fall back to a fresh scratch dir under the OS temp dir — NEVER $HOME. Returns
// { dir, fellBack }. Throws only if even a scratch dir can't be made (caller turns that into a refused turn).
async function ensureUsableDir(dir, log) {
  try {
    await mkdir(dir, { recursive: true });
    const st = await stat(dir);
    if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    return { dir, fellBack: false };
  } catch (e) {
    log(`⚠️ working dir ${dir} unusable (${e?.code ?? e?.message}); using a scratch dir instead`);
    const scratch = await mkdtemp(path.join(tmpdir(), "adania-fallback-")); // throws → caller refuses the turn
    return { dir: scratch, fellBack: true };
  }
}

// Resolve + create an org's BASE working dir (the parent that holds its per-agent subdirs), persisting the
// choice. On a TTY, `interactive` prompts for orgs with no saved path (Enter accepts the default); off a TTY it
// silently uses the default — so an unattended start never blocks. KB is NOT provisioned here; that happens
// per-agent in ensureBotDir so each agent gets its OWN kb checkout. Returns { dir, fellBack } (abs, existing).
async function ensureOrgBaseDir(org, { interactive = false, log = console.log } = {}) {
  const current = await loadSettings();
  let dir = current.workingDirs?.[org.organizationId] ? normalizeDir(current.workingDirs[org.organizationId]) : null;

  if (!dir) {
    const def = defaultDirFor(org);
    dir = interactive && process.stdin.isTTY ? normalizeDir(await promptDir(org, def)) || def : def;
    // Re-read inside the lock so concurrent first-writes for different orgs merge instead of clobbering.
    await withSettingsLock(async () => {
      const settings = await loadSettings();
      const dirs = settings.workingDirs ?? {};
      if (dirs[org.organizationId]) {
        dir = normalizeDir(dirs[org.organizationId]) || dir; // someone persisted while we raced → honor it
        return;
      }
      settings.workingDirs = { ...dirs, [org.organizationId]: dir };
      await saveSettings(settings);
    }).catch((e) => log(`⚠️ could not save settings: ${e?.message ?? e}`));
  }

  return ensureUsableDir(dir, log); // { dir, fellBack }
}

// Atomically mirror the org-wide CLAUDE.md into an agent's cwd (settingSources:["project"] loads ./CLAUDE.md
// from the cwd, NOT its parents). Copy via temp+rename so a turn reading CLAUDE.md never sees a half-written
// file, and so edits to the org file propagate on the next turn. Best-effort.
async function mirrorClaudeMd(srcFile, destDir) {
  try {
    const tmp = path.join(destDir, ".CLAUDE.md.tmp");
    await copyFile(srcFile, tmp);
    await rename(tmp, path.join(destDir, "CLAUDE.md"));
  } catch {
    /* best-effort — a missing/locked CLAUDE.md just means the org rules aren't mirrored this turn */
  }
}

// Resolve + create a per-AGENT working dir: <orgBaseDir>/<slug>. Each agent gets its OWN folder and its OWN kb
// checkout, so turns for DIFFERENT agents in the same org run concurrently without sharing a git tree /
// .git/index.lock (the per-agent turn queue in runner.mjs still serializes same-agent turns). KB provisioning
// is (re)kicked once per process per dir, in the BACKGROUND (tracked so the dir's first turn can await it).
// Returns an absolute, existing directory.
export async function ensureBotDir(org, slug, { interactive = false, log = console.log } = {}) {
  const { dir: base, fellBack } = await ensureOrgBaseDir(org, { interactive, log });
  const seg = sanitizeSegment(slug);
  if (fellBack || !seg) return base; // scratch fallback, or no usable slug → run in the base dir (no per-agent kb)

  const { dir: resolved, fellBack: botFellBack } = await ensureUsableDir(path.join(base, seg), log);
  if (botFellBack) return resolved; // scratch dir — never provision a kb / mirror into a throwaway

  const baseClaude = path.join(base, "CLAUDE.md");
  if (await pathExists(baseClaude)) await mirrorClaudeMd(baseClaude, resolved);

  if (validGithubLogin(org.githubOrgSlug) && !provisioned.has(resolved)) {
    provisioned.add(resolved);
    const ghSlug = String(org.githubOrgSlug).trim();
    log(`  ↳ ${org.organizationName ?? ghSlug} / ${seg}: ensuring knowledge base (${ghSlug}/kb)…`);
    const p = provisionKb(resolved, ghSlug, log)
      .catch((e) => log(`  ↳ kb: provisioning error: ${e?.message ?? e}`))
      .finally(() => provisioningPromises.delete(resolved));
    provisioningPromises.set(resolved, p);
  }
  return resolved;
}

// Wait (bounded) for an in-flight KB provisioning for THIS working dir before its first turn runs, so the agent
// doesn't run git in a tree provisionKb is still cloning/initializing. Keyed by the resolved dir (see
// ensureBotDir). Capped well under the server's reply timeout; a slow clone proceeds uncapped in the background.
export async function awaitProvisioning(dir, capMs = 45_000) {
  const p = dir && provisioningPromises.get(dir);
  if (!p) return;
  let timer;
  await Promise.race([
    p.catch(() => {}),
    new Promise((res) => {
      timer = setTimeout(res, capMs);
    }),
  ]);
  clearTimeout(timer);
}

// Ensure a per-agent working dir for every assigned bot at startup / on refresh. The org's base dir is resolved
// once per org (prompting on a TTY for orgs with no saved path); each agent's subdir + kb is created under it.
// Bots carry their definition slug in config.slug.
export async function seedBotDirs(bots, orgsById, { interactive = false, log = console.log } = {}) {
  for (const b of bots ?? []) {
    if (!b?.organizationId) continue;
    const org = orgsById?.get(b.organizationId) ?? { organizationId: b.organizationId };
    const slug = b.config?.slug;
    if (!slug) continue;
    await ensureBotDir(org, slug, { interactive, log });
  }
}

// The working dir for an inbound turn: <orgBaseDir>/<slug> for the invoked agent. organizationId + slug come
// from the turn payload (org also recoverable via the bot index). A turn with no org id runs under the
// quarantine dir (in a per-agent subdir when the slug is known) — never $HOME. Throws only if no directory at
// all can be created (the caller replies with an error rather than running anywhere).
export async function dirForTurn({ organizationId, slug, orgsById, log = console.log }) {
  if (!organizationId) {
    const base = (await ensureUsableDir(QUARANTINE_DIR, log)).dir;
    const seg = sanitizeSegment(slug);
    return seg ? (await ensureUsableDir(path.join(base, seg), log)).dir : base;
  }
  const org = orgsById?.get(organizationId) ?? { organizationId };
  return ensureBotDir(org, slug, { interactive: false, log });
}
