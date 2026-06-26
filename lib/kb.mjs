// Knowledge-base provisioning for an org's local working directory.
//
// Each org folder (~/adania/<github-org-slug>) gets a `kb` repo inside it:
//   • if the GitHub repo <slug>/kb already exists  → clone it into <orgFolder>/kb
//   • otherwise                                     → scaffold a fresh kb: add the obsidian-markdown Claude
//     Code skill, write a README, then create the <slug>/kb repo on GitHub (PRIVATE), wire it as `origin`,
//     and push.
//
// SELF-HEALING: this is called once per process per org (see orgdirs.ensureOrgDir), not just on first folder
// creation — so a run that committed locally but failed `gh repo create --push` (e.g. offline, or `gh` not
// yet authed) is RESUMED on a later launch instead of being stuck forever. A `gh repo view` that fails for a
// reason OTHER than not-found (auth/network/rate-limit) is NOT treated as "create" — we bail and retry next
// time rather than scaffold a broken shadow repo.
//
// Everything is BEST-EFFORT and logged: a missing/unauthed `gh`, no create-permission on the org, or a
// network failure must NEVER crash the runner or fail a turn. We shell out to the operator's own `gh`/`git`
// (the runner is the deliberate full-capability local runtime), passing argv directly (no shell), so the org
// slug can never inject a command.
import { spawn } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const SKILL_URL = "https://github.com/kepano/obsidian-skills";
const MAX_OUT = 64 * 1024; // cap captured stdout/stderr so a chatty child can't grow memory unbounded

// Run a command as a fixed argv (no shell). Resolves with { code, out, err }; NEVER rejects. On timeout the
// whole process GROUP is killed (npx/git/gh spawn grandchildren), resolving code 124.
function run(cmd, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let timer;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    let child;
    try {
      // detached:true → child is its own process-group leader, so we can group-kill its descendants on timeout.
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true });
    } catch (e) {
      return resolve({ code: -1, out: "", err: e?.message ?? String(e) });
    }
    timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = the whole group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone (ESRCH) */
        }
      }
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (out.length < MAX_OUT) out += d;
    });
    child.stderr?.on("data", (d) => {
      if (err.length < MAX_OUT) err += d;
    });
    child.on("error", (e) => {
      err += e?.message ?? String(e);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? 0));
  });
}

let ghOk = null;
async function ghAvailable() {
  if (ghOk !== null) return ghOk;
  const r = await run("gh", ["--version"], { timeoutMs: 10_000 });
  ghOk = r.code === 0;
  return ghOk;
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const text = (r) => `${r.err}\n${r.out}`;
// `gh repo view` failed because the repo genuinely isn't visible/doesn't exist (vs an auth/network blip).
const looksLikeNotFound = (r) => /could not resolve to a repository|not found|http 404|gone/i.test(text(r));

async function isGitRepo(dir) {
  const r = await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 10_000 });
  return r.code === 0 && r.out.trim() === "true";
}
async function originUrl(dir) {
  const r = await run("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return r.code === 0 ? r.out.trim() : "";
}
async function hasUnpushed(dir) {
  // commits on HEAD not on the upstream; if there is no upstream, treat as unpushed.
  const r = await run("git", ["-C", dir, "rev-list", "--count", "@{u}..HEAD"], { timeoutMs: 10_000 });
  if (r.code !== 0) return true;
  return Number(r.out.trim() || "0") > 0;
}

// Create the remote <slug>/kb (private), wire origin, push. Assumes kbDir is a git repo with a commit. If the
// repo already exists out-of-band, attach origin + push instead.
async function createRemoteAndPush(kbDir, slug, log) {
  const create = await run("gh", ["repo", "create", `${slug}/kb`, "--private", "--source", ".", "--remote", "origin", "--push"], {
    cwd: kbDir,
    timeoutMs: 300_000,
  });
  if (create.code === 0) {
    log(`  ↳ kb: created + pushed ${slug}/kb (private)`);
    return;
  }
  if (/already exists|name already exists on this account/i.test(text(create))) {
    await run("git", ["-C", kbDir, "remote", "add", "origin", `https://github.com/${slug}/kb.git`], { timeoutMs: 30_000 });
    const p = await run("git", ["-C", kbDir, "push", "-u", "origin", "HEAD"], { timeoutMs: 300_000 });
    log(
      p.code === 0
        ? `  ↳ kb: attached origin + pushed ${slug}/kb`
        : `  ↳ kb: attach/push to existing ${slug}/kb failed (${p.code}): ${(p.err || p.out).trim().slice(0, 160)}`,
    );
    return;
  }
  log(`  ↳ kb: 'gh repo create ${slug}/kb' failed (${create.code}): ${(create.err || create.out).trim().slice(0, 200)} — local kb kept, will retry`);
}

// Resume a kb folder left behind by a prior (possibly partial) run.
async function repairKb(kbDir, slug, log) {
  if (!(await isGitRepo(kbDir))) {
    log(`  ↳ kb: ${kbDir} exists but is not a git repo — leaving as-is`);
    return;
  }
  if (await originUrl(kbDir)) {
    if (await hasUnpushed(kbDir)) {
      const p = await run("git", ["-C", kbDir, "push", "-u", "origin", "HEAD"], { timeoutMs: 300_000 });
      if (p.code === 0) log(`  ↳ kb: pushed pending commits to ${slug}/kb`);
      else log(`  ↳ kb: push to ${slug}/kb failed (${p.code}): ${(p.err || p.out).trim().slice(0, 160)}`);
    }
    return; // already wired to a remote
  }
  // git repo but no origin → ensure a commit exists, then create+push.
  await run("git", ["-C", kbDir, "add", "-A"], { timeoutMs: 60_000 });
  await run(
    "git",
    ["-C", kbDir, "-c", "user.name=adania-runner", "-c", "user.email=runner@users.noreply.github.com", "commit", "-m", "Initialize knowledge base"],
    { timeoutMs: 60_000 },
  ); // no-op if nothing staged / already committed — ignore code
  await createRemoteAndPush(kbDir, slug, log);
}

// Scaffold a brand-new kb: skill + README, then init + create remote + push (in the spec's order).
async function scaffoldKb(kbDir, slug, log) {
  log(`  ↳ kb: scaffolding new ${slug}/kb…`);
  await mkdir(kbDir, { recursive: true });
  const skills = await run(
    "npx",
    ["skills", "add", SKILL_URL, "--skill", "obsidian-markdown", "--agent", "claude-code", "universal", "--copy", "--yes"],
    { cwd: kbDir, timeoutMs: 300_000 },
  );
  if (skills.code !== 0) {
    log(`  ↳ kb: 'npx skills add' returned ${skills.code} (continuing): ${(skills.err || skills.out).trim().slice(0, 160)}`);
  }
  await writeFile(path.join(kbDir, "README.md"), "# Knowledge Base\n");
  const init = await run("git", ["init"], { cwd: kbDir, timeoutMs: 30_000 });
  if (init.code !== 0) {
    log(`  ↳ kb: git init failed (${init.code}) — local kb kept, will retry`);
    return;
  }
  await run("git", ["-C", kbDir, "add", "-A"], { timeoutMs: 60_000 });
  await run(
    "git",
    ["-C", kbDir, "-c", "user.name=adania-runner", "-c", "user.email=runner@users.noreply.github.com", "commit", "-m", "Initialize knowledge base"],
    { timeoutMs: 60_000 },
  );
  await createRemoteAndPush(kbDir, slug, log);
}

// Ensure <orgFolder>/kb exists and is pushed to <slug>/kb. `slug` MUST be a validated GitHub org login (the
// caller checks). Safe to call every launch: a complete kb short-circuits after a couple of cheap probes.
export async function provisionKb(orgFolder, slug, log = console.log) {
  if (!(await ghAvailable())) {
    log(`  ↳ kb: skipped (gh CLI not found/unauthed) for ${slug}/kb`);
    return;
  }
  const kbDir = path.join(orgFolder, "kb");

  // A kb folder already exists → resume/repair rather than re-scaffold or blindly skip.
  if (await pathExists(kbDir)) {
    return repairKb(kbDir, slug, log);
  }

  // No local kb → decide clone vs scaffold from the remote's existence.
  const view = await run("gh", ["repo", "view", `${slug}/kb`, "--json", "nameWithOwner"], { timeoutMs: 30_000 });
  if (view.code === 0) {
    const clone = await run("gh", ["repo", "clone", `${slug}/kb`, kbDir], { timeoutMs: 300_000 });
    log(
      clone.code === 0
        ? `  ↳ kb: cloned existing ${slug}/kb`
        : `  ↳ kb: clone of ${slug}/kb failed (${clone.code}): ${(clone.err || clone.out).trim().slice(0, 200)}`,
    );
    return;
  }
  if (!looksLikeNotFound(view)) {
    // auth/network/rate-limit/timeout — do NOT scaffold a shadow; retry on a later launch.
    log(`  ↳ kb: 'gh repo view ${slug}/kb' inconclusive (${view.code}): ${(view.err || view.out).trim().slice(0, 160)} — skipping (will retry)`);
    return;
  }
  await scaffoldKb(kbDir, slug, log);
}
