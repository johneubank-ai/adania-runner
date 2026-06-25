// Shared local session credential (OS keychain on macOS, 0600-file fallback) + ensureSession:
// check for an active Cognito session, and if there's none, open the browser to sign in (PKCE loopback).
// adania-ui writes the SAME keychain entry, so a login in either place is shared.
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { promisify } from "node:util";
import { CALLBACK_PORT, COGNITO } from "./config.mjs";
import { authorizeUrl, exchangeCode, genPkce, verifyIdToken } from "./oauth.mjs";

const exec = promisify(execFile);
const SERVICE = "adania";
const ACCOUNT = "session";
const FILE = `${process.env.HOME ?? "/tmp"}/.adania/session.json`;

async function load() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
      return JSON.parse(stdout.trim());
    } catch {
      /* not in keychain */
    }
  }
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return null;
  }
}
async function save(tokens) {
  const json = JSON.stringify(tokens);
  if (process.platform === "darwin") {
    try {
      await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", json]);
      return;
    } catch {
      /* fall through */
    }
  }
  await mkdir(FILE.replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
  await writeFile(FILE, json, { mode: 0o600 });
  await chmod(FILE, 0o600).catch(() => {});
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

async function refresh(refreshToken) {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: COGNITO.clientId, refresh_token: refreshToken });
  const r = await fetch(`https://${COGNITO.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  return r.json(); // { id_token, access_token, expires_in } (no new refresh_token)
}

async function loginPkce() {
  const { verifier, challenge } = genPkce();
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:2rem'><h2>Signed in ✓</h2><p>You can close this tab and return to your terminal.</p>");
      const c = u.searchParams.get("code");
      server.close();
      c ? resolve(c) : reject(new Error("no code in callback"));
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const url = authorizeUrl(challenge);
      console.log("\nOpening your browser to sign in. If it doesn't open, visit:\n" + url + "\n");
      openBrowser(url);
    });
    setTimeout(() => {
      server.close();
      reject(new Error("login timed out (5 min)"));
    }, 300_000);
  });
  const tok = await exchangeCode(code, verifier);
  await verifyIdToken(tok.id_token);
  await save(tok);
  return tok;
}

// Return a valid id_token: reuse the active session, refresh it if expired, else browser-login.
export async function ensureSession() {
  const existing = await load();
  if (existing?.id_token) {
    try {
      await verifyIdToken(existing.id_token);
      return existing.id_token; // active session
    } catch {
      if (existing.refresh_token) {
        try {
          const refreshed = await refresh(existing.refresh_token);
          const merged = { ...existing, ...refreshed };
          await verifyIdToken(merged.id_token);
          await save(merged);
          console.log("Reusing your session (refreshed).");
          return merged.id_token;
        } catch {
          /* refresh failed → full login */
        }
      }
    }
  }
  console.log("No active session — signing in…");
  const tok = await loginPkce();
  return tok.id_token;
}
