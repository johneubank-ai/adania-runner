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
import { mkdir, mkdtemp, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { provisionKb } from "./kb.mjs";

const HOME = process.env.HOME || homedir();
const SETTINGS_FILE = path.join(HOME, ".adania", "settings.json");
// Where turns whose org can't be determined at all run — never $HOME (a full-capability agent loose in the
// home tree defeats the whole point of per-org folders).
export const QUARANTINE_DIR = path.join(HOME, "adania", "_unassigned");

// Org folders we've already kicked KB provisioning for THIS process — keyed by resolved abs path. Prevents
// duplicate provisioning when an org is seeded at startup and then touched again by a turn / reconnect.
const provisioned = new Set();
// In-flight (or just-finished) KB provisioning promises, keyed by organizationId, so the org's FIRST turn can
// wait for it (see awaitProvisioning) — the per-org turn queue then keeps the agent out of a half-cloned tree.
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

// Resolve + create an org's working dir, persisting the choice. On a TTY, `interactive` prompts for orgs with
// no saved path (Enter accepts the default); off a TTY it silently uses the default — so an unattended start
// never blocks. KB provisioning is (re)kicked whenever the org has a valid GitHub slug and we haven't done so
// this process — completeness-based, so a partial prior run self-heals; it runs in the BACKGROUND (tracked so
// the org's first turn can await it). Returns an absolute, existing directory.
export async function ensureOrgDir(org, { interactive = false, log = console.log } = {}) {
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

  const { dir: resolved, fellBack } = await ensureUsableDir(dir, log);
  if (fellBack) return resolved; // scratch dir — never provision a kb into a throwaway

  if (validGithubLogin(org.githubOrgSlug) && !provisioned.has(resolved)) {
    provisioned.add(resolved);
    const slug = String(org.githubOrgSlug).trim();
    log(`  ↳ ${org.organizationName ?? slug}: ensuring knowledge base (${slug}/kb)…`);
    const p = provisionKb(resolved, slug, log)
      .catch((e) => log(`  ↳ kb: provisioning error: ${e?.message ?? e}`))
      .finally(() => provisioningPromises.delete(org.organizationId));
    provisioningPromises.set(org.organizationId, p);
  }
  return resolved;
}

// Wait (bounded) for an org's in-flight KB provisioning before its first turn runs, so the agent doesn't run
// git in a tree provisionKb is still cloning/initializing. Capped well under the server's ~90s reply timeout:
// in the common (scaffold) case provisioning finishes in seconds; a slow clone proceeds uncapped in the
// background (the agent's cwd is the org folder, not kb/, so the residual collision risk is narrow).
export async function awaitProvisioning(orgId, capMs = 45_000) {
  const p = orgId && provisioningPromises.get(orgId);
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

// Ensure working dirs for a set of orgs (the routable orgs at startup / on refresh).
export async function seedOrgDirs(orgs, { interactive = false, log = console.log } = {}) {
  for (const org of orgs ?? []) {
    if (!org?.organizationId) continue;
    await ensureOrgDir(org, { interactive, log });
  }
}

// The working dir for an inbound turn. organizationId comes from the turn payload (or the bot index). A known
// org resolves to its folder (creating + KB-seeding it if new); an org id we have no info for still gets its
// own ~/adania/<uuid> folder; a turn with no org id at all runs in the quarantine dir — never $HOME. Throws
// only if no directory at all can be created (the caller replies with an error rather than running anywhere).
export async function dirForTurn({ organizationId, orgsById, log = console.log }) {
  if (!organizationId) return (await ensureUsableDir(QUARANTINE_DIR, log)).dir;
  const org = orgsById?.get(organizationId) ?? { organizationId };
  return ensureOrgDir(org, { interactive: false, log });
}
