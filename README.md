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
3. **Resolves a working directory per organization** (see below) and ensures each one exists.
4. For each turn pushed to you, runs it via the Claude Agent SDK **in that org's working directory** and
   sends the reply back. Keep it running.

**Prereqs:** Node 20+, and you must be **logged into Claude Code on this machine** — the runner uses that
ambient login to execute turns. For knowledge-base provisioning (below) it also uses your local `git` and
`gh` (GitHub CLI) — both optional; if `gh` is missing/unauthed the runner just skips that step. Override the
backend with `ADANIA_API=…`.

## Per-organization working directories

Each org's turns run in a **dedicated local folder** instead of `$HOME`, so one org's repos/files stay apart
from another's. The default is `~/adania/<github-org-slug>` (falling back to a slugified org name, then the
org id). Paths are stored in **`~/.adania/settings.json`** (mode `0600`, beside the session credential),
keyed by the stable organization id:

```json
{ "workingDirs": { "<organization-uuid>": "/Users/you/adania/acme" } }
```

- On startup the runner seeds a folder for each org you have an **assigned agent** in. On an interactive
  terminal it lets you confirm/override each path (Enter accepts the default); when run headless/unattended
  it silently uses the defaults so it never blocks. Edit `settings.json` to change a path later.
- An org you're added to **after** startup is picked up automatically on the next reconnect.
- A turn whose org can't be determined runs in `~/adania/_unassigned` — never your `$HOME`.

> **Not a sandbox.** The runner runs with the full Claude Code toolset and bypassed permissions, so an agent
> can still reach any absolute path. The per-org folder is an *organization* boundary (where each org's work
> lives by default), not a security one — appropriate because every org belongs to you, the single operator.

## Knowledge base (`kb`)

The **first time** an org folder is created, the runner provisions a `kb` repo inside it (only when the org
has a GitHub slug):

- if **`<org-slug>/kb` already exists** on GitHub → it's **cloned** into `<org-folder>/kb`;
- otherwise a fresh `kb` is **scaffolded** — the [obsidian-markdown](https://github.com/kepano/obsidian-skills)
  Claude Code skill is added, a `README.md` (`# Knowledge Base`) is written, then the repo is created
  **private** under the org, wired as `origin`, and pushed.

This runs in the background and is **best-effort**: any failure (no `gh`, no permission on the org, offline)
is logged and skipped — the org folder still works without a `kb`.

## Layout

```
bin/cli.mjs     entry (npx adania-runner)
lib/session.mjs shared keychain session + ensureSession (active-session check / browser login)
lib/oauth.mjs   Cognito PKCE + JWKS verification
lib/runner.mjs  reverse-WS loop + Claude Agent SDK turn execution (per-org cwd)
lib/orgdirs.mjs per-org working dirs: ~/.adania/settings.json, defaults, TTY prompt, dir resolution
lib/kb.mjs      knowledge-base provisioning (clone-or-scaffold <org-slug>/kb via gh + git)
lib/config.mjs  Cognito + backend config (non-secret)
```

> Pairs with **adania-ui** (the thin Deno Desktop app: login + your memberships + web-chat input). The two
> share the same local session credential, so signing in once works for both.
