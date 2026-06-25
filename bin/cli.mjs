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
  const idToken = await ensureSession();
  await runForever(idToken);
} catch (e) {
  console.error("\nadania-runner failed:", e?.message ?? e);
  process.exit(1);
}
