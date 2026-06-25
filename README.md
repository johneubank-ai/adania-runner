# adania-runner

The headless runtime an org member runs to serve their assigned **Desktop-app** Adania agents. It reuses
your Adania Client session (or opens a browser login), holds a reverse **WebSocket** to the Adania relay,
and runs each turn locally via the Claude Agent SDK — so agent events (Slack/Linear/GitHub/web-chat) are
answered on your machine with no inbound port exposed.

## Run

```sh
npx adania-runner
# or, before it's published to npm:
npx github:johneubank-ai/adania-runner
```

What it does:
1. **Checks for an active session** (shared with the Adania Client app via the macOS Keychain, service
   `adania`). If none, **opens your browser to the Cognito sign-in** (Authorization-Code + PKCE on a
   loopback callback) and stores the session.
2. Fetches your orgs + assigned agents (`GET /api/bots`) and connects to the relay
   (`wss://app.adania.johneubank.ai/api/relay/ws`), authenticating with a hello frame.
3. For each turn pushed to you, runs it via the Claude Agent SDK and sends the reply back. Keep it running.

**Prereqs:** Node 20+, and you must be **logged into Claude Code on this machine** — the runner uses that
ambient login to execute turns. Override the backend with `ADANIA_API=…`.

## Layout

```
bin/cli.mjs     entry (npx adania-runner)
lib/session.mjs shared keychain session + ensureSession (active-session check / browser login)
lib/oauth.mjs   Cognito PKCE + JWKS verification
lib/runner.mjs  reverse-WS loop + Claude Agent SDK turn execution
lib/config.mjs  Cognito + backend config (non-secret)
```

> Pairs with **adania-ui** (the thin Deno Desktop app: login + your memberships + web-chat input). The two
> share the same local session credential, so signing in once works for both.
