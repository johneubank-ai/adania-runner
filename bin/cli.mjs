#!/usr/bin/env node
// adania-runner — `npx adania-runner`
// Checks for an active local session (shared with the Adania Client app); opens a browser Cognito login
// if there's none; then dials the Adania relay and runs your assigned Desktop-app agents' turns locally.
import { ensureSession } from "../lib/session.mjs";
import { runForever } from "../lib/runner.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("-h") || args.has("--help")) {
  console.log(`adania-runner — run your assigned Adania agents on this machine.

Usage:  npx adania-runner

It reuses your Adania Client session (or opens a browser login), connects to the Adania relay over a
reverse WebSocket, and runs each turn locally via the Claude Agent SDK (uses this machine's Claude Code
login). Keep it running. Override the backend with ADANIA_API=...`);
  process.exit(0);
}

try {
  // Pass ensureSession as a token GETTER (not a one-shot token): runForever calls it at startup and before
  // every reconnect, so the ~1h Cognito ID token is refreshed for each `hello` and the runner survives
  // overnight instead of getting stuck on 4401 after the token lapses.
  await runForever(ensureSession);
} catch (e) {
  console.error("\nadania-runner failed:", e?.message ?? e);
  process.exit(1);
}
