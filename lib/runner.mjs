// The reverse-WS runtime: fetch the member's assigned agents + relay URL, hold a WebSocket to the relay, run
// each pushed turn locally via the Claude Agent SDK in THAT org's working directory, and send the reply back
// over the same socket.
import WebSocket from "ws";
import { ADANIA_API } from "./config.mjs";
import { awaitProvisioning, dirForTurn, seedOrgDirs } from "./orgdirs.mjs";

// How many agent turns (tool-call rounds) a single request may take before it must reply. Generous so the
// agent can do real multi-step work (read several repos, compose, post) in one turn. Override via env.
const MAX_TURNS = Number(process.env.ADANIA_MAX_TURNS ?? 100);

// Run one turn via the Claude Agent SDK, FULL-CAPABILITY on THIS machine: the agent gets the complete default
// Claude Code toolset (Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/…) via the `claude_code` preset,
// bypasses all permission prompts (headless), and may take many tool calls before replying. Slack/Linear/
// GitHub come from the bot's act-as-agent CONNECTOR MCP servers (HTTP + signed Bearer minted by the backend),
// so the agent posts AS the bot without any service token ever touching this machine or the model.
//
// `cwd` is the ORG's working directory (orgdirs.mjs resolves + creates it). This deliberately grants any
// triggerable turn full host access (no sandbox) — the operator's explicit choice; the per-org cwd organizes
// each org's work into its own folder but is NOT a security boundary (see orgdirs.mjs).
async function runTurn(payload, bot, cwd) {
  try {
    delete process.env.ANTHROPIC_API_KEY; // a Claude Code OAuth token must win auth precedence
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const cfg = bot?.config ?? null;
    // Accept either a messages[] array (webchat) or a single message string (slack/linear/github).
    const messages = payload?.messages ?? (payload?.message ? [{ role: "user", content: payload.message }] : []);
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

    // Connector MCP servers → HTTP MCP with the backend-minted Bearer (the connector server resolves the
    // bot's real xoxb / actor=app / installation token server-side; this token only ever acts AS the bot).
    const mcpServers = Object.fromEntries(
      (cfg?.mcpServers ?? []).map((s) => [
        s.name,
        { type: "http", url: s.url, headers: { Authorization: `Bearer ${s.token}` }, alwaysLoad: true },
      ]),
    );

    const options = {
      model: cfg?.model || "claude-opus-4-8",
      tools: { type: "preset", preset: "claude_code" }, // the full default Claude Code toolset
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true, // the SDK requires this alongside bypassPermissions
      maxTurns: MAX_TURNS,
      cwd, // the org's working directory — always created/validated by orgdirs.dirForTurn before we get here
    };
    // Tell the agent which identity it's running AS. The relay never names the agent in the prompt (that's just
    // the message text), so prepend a fixed invocation-context block carrying this bot's AgentDefinition slug
    // ahead of its instructions. Slug-only (stable, non-PII); the human @-handle/org live in the connectors.
    const invocationContext = cfg?.slug ? `[INVOCATION CONTEXT]\nYou are agent ${cfg.slug}.` : "";
    const systemPrompt = [invocationContext, cfg?.instructions].filter(Boolean).join("\n\n");
    if (systemPrompt) options.systemPrompt = systemPrompt;
    if (Object.keys(mcpServers).length) options.mcpServers = mcpServers;

    let text = "";
    for await (const m of query({ prompt, options })) {
      // The terminal `result` message is either a success (carries `result` text) or an error subtype
      // (error_max_turns / error_during_execution / error_max_budget_usd / … — no `result`, has `errors[]`).
      // Surface the error reason rather than collapsing every failure into a silent "(no text)".
      if (m.type === "result") {
        text =
          m.subtype === "success"
            ? (m.result ?? "")
            : `⚠️ ${m.subtype}${m.errors?.length ? ": " + m.errors.join("; ") : ""}`;
      }
    }
    return text || "(no text)";
  } catch (e) {
    return "⚠️ " + (e?.message ?? String(e));
  }
}

async function fetchBots(idToken) {
  const r = await fetch(`${ADANIA_API}/api/bots`, { headers: { authorization: `Bearer ${idToken}` } });
  if (!r.ok) throw new Error(`/api/bots ${r.status}`);
  return r.json();
}

// Merge orgs[] (carry githubOrgSlug + name) with the org info on each assigned bot into one orgId→org map, and
// return the distinct set of orgs that can actually ROUTE a turn (= the orgs of assigned bots). We seed/prompt
// only the routable set, since a membership with no assigned bot can never receive a turn.
function indexOrgs(orgs, bots) {
  const orgsById = new Map();
  for (const o of orgs ?? []) orgsById.set(o.organizationId, o);
  for (const b of bots ?? []) {
    if (b.organizationId && !orgsById.has(b.organizationId)) {
      orgsById.set(b.organizationId, {
        organizationId: b.organizationId,
        organizationName: b.organizationName,
        githubOrgSlug: b.githubOrgSlug ?? null,
      });
    }
  }
  const routable = [];
  const seen = new Set();
  for (const b of bots ?? []) {
    if (b.organizationId && !seen.has(b.organizationId)) {
      seen.add(b.organizationId);
      routable.push(orgsById.get(b.organizationId));
    }
  }
  return { orgsById, routable };
}

// `getToken` returns a FRESH id token on each call (ensureSession refreshes the ~1h Cognito ID token when it
// has expired). We call it at startup AND before every (re)connect's `hello`, because the relay-gw only
// validates the token on `hello` — so after the token lapses, any reconnect (laptop sleep, network blip, the
// Fargate-Spot relay-gw being reclaimed) would otherwise loop forever on 4401 "bad hello" until restart.
export async function runForever(getToken) {
  let idToken;
  try {
    idToken = await getToken();
  } catch (e) {
    console.error("Sign-in required:", e?.message ?? e);
    process.exit(1);
  }

  let botsById = new Map();
  let orgsById = new Map();
  let relayWs = null;

  // (Re)fetch the agent config + orgs, rebuild the indexes, and ensure each routable org's working dir exists
  // (KB-seeding it on first creation). interactive=true prompts on a TTY for orgs with no saved path. This is
  // the single source of truth for "what do I serve" — called at startup and again whenever memberships change
  // on a reconnect, so a bot/org assigned after launch is picked up (also fixes stale per-bot config).
  const refresh = async (token, { interactive }) => {
    const data = await fetchBots(token);
    const orgs = data.orgs ?? [];
    const bots = data.bots ?? [];
    botsById = new Map(bots.map((b) => [b.id, b]));
    const { orgsById: idx, routable } = indexOrgs(orgs, bots);
    orgsById = idx;
    relayWs = data.relay?.ws ?? relayWs;
    console.log(`\nSigned in. ${orgs.length} org(s), ${bots.length} assigned agent(s):`);
    for (const b of bots) {
      console.log(`  • ${b.name}  [${(b.channels ?? []).join(", ") || "—"}]  (${b.organizationName})`);
    }
    await seedOrgDirs(routable, { interactive, log: console.log });
    return data;
  };

  try {
    await refresh(idToken, { interactive: true });
  } catch (e) {
    console.error("Could not fetch your agents:", e.message);
    process.exit(1);
  }
  if (!relayWs) {
    console.error("No relay WebSocket URL returned by the backend — cannot receive turns.");
    process.exit(1);
  }

  // Per-ORGANIZATION serialization: same-org turns run strictly sequentially (so two concurrent turns never
  // corrupt the same git tree / .git/index.lock); different-org turns still run concurrently. Keyed by orgId,
  // or "_unassigned" when the org can't be determined. The map persists across reconnects.
  const orgQueues = new Map();
  const enqueueTurn = (key, fn) => {
    const prev = orgQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the prior turn's outcome
    orgQueues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };

  // Background refetch that mints a FRESH id token: /api/bots re-validates the bearer, and on a long-lived
  // socket the connection token has likely lapsed (the relay-gw only checks the token at 'hello'). Bound the
  // token wait so a fully-logged-out interactive re-login can never block a turn — fall back to the last token
  // (a reconnect then re-auths via the normal hello path).
  const TOKEN_WAIT_MS = 8000;
  const bgRefresh = async () => {
    let token = idToken;
    try {
      const tokenP = getToken();
      tokenP.catch(() => {}); // if it loses the race below, swallow a later rejection (no unhandledRejection)
      token = await Promise.race([tokenP, new Promise((res) => setTimeout(() => res(idToken), TOKEN_WAIT_MS))]);
    } catch {
      token = idToken;
    }
    idToken = token;
    await refresh(token, { interactive: false }).catch(() => {});
  };
  // Debounced wrapper: an unknown botId or a membership change triggers a refetch, but a burst can't storm it.
  let lastRefresh = 0;
  const maybeRefresh = async () => {
    if (Date.now() - lastRefresh < 15_000) return;
    lastRefresh = Date.now();
    await bgRefresh();
  };

  let backoff = 1000;
  let lastMemberships = null; // baseline recorded on the first 'ready'; a change triggers a refresh
  const connect = async () => {
    // Mint a fresh token for THIS connection's hello (refreshes if the previous one expired).
    let token = idToken;
    try {
      token = await getToken();
      idToken = token;
    } catch {
      /* refresh failed (refresh token also expired) → try the last token; a 4401 close just retries */
    }
    const ws = new WebSocket(relayWs);
    ws.on("open", () => {
      backoff = 1000;
      ws.send(JSON.stringify({ type: "hello", token }));
    });
    ws.on("message", async (data) => {
      let f;
      try {
        f = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (f.type === "ready") {
        const count = f.memberships ?? 0;
        console.log(`\n● Connected — listening for turns (${count} membership(s)). Keep this running.`);
        // Membership COUNT can stay equal across an org swap, so don't trust it. After the first 'ready' (whose
        // state the startup refresh already covered), always refetch (debounced + idempotent: folders exist and
        // the `provisioned` Set dedupes KB work) so a bot/org assigned while we were away is picked up.
        if (lastMemberships === null) lastMemberships = count;
        else void maybeRefresh();
        lastMemberships = count;
        return;
      }
      if (f.type === "error") {
        console.error("relay error:", f.error);
        return;
      }
      if (f.type === "event" && f.turnId) {
        const payload = f.payload ?? {};
        // Org for this turn: prefer the authoritative organizationId in the payload; else resolve via the bot
        // index by botId ONLY (never the shared definition slug, which could pick another org's bot → wrong
        // dir under bypassPermissions).
        let orgId = payload.organizationId ?? botsById.get(payload.botId)?.organizationId ?? null;
        const orgKey = orgId ?? "_unassigned";
        const label =
          (payload.channel ?? "turn") + (payload.message ? `: ${String(payload.message).slice(0, 60)}` : "");
        console.log(`→ ${label}`);
        enqueueTurn(orgKey, async () => {
          try {
            let bot = botsById.get(payload.botId);
            if (!bot && payload.botId) {
              await maybeRefresh(); // a bot assigned after our last refresh (mints a fresh token internally)
              bot = botsById.get(payload.botId);
              if (!orgId) orgId = bot?.organizationId ?? null; // recover org now that the index is warm
            }
            const cwd = await dirForTurn({ organizationId: orgId, orgsById, log: console.log });
            await awaitProvisioning(orgId); // let this org's kb finish initializing before we run in its tree
            const reply = await runTurn(payload, bot, cwd);
            console.log(`← ${reply.slice(0, 80)}`);
            ws.send(JSON.stringify({ type: "reply", turnId: f.turnId, reply }));
          } catch (e) {
            try {
              // surface the failure as the reply rather than silently timing out the turn
              ws.send(JSON.stringify({ type: "reply", turnId: f.turnId, reply: "⚠️ " + (e?.message ?? String(e)) }));
            } catch {
              /* socket dropped → server times out the turn → portal Retry covers it */
            }
          }
        });
      }
    });
    ws.on("close", (code) => {
      const why = code === 4401 ? " (auth expired — refreshing on retry)" : "";
      console.log(`Disconnected${why} — reconnecting in ${Math.round(backoff / 1000)}s…`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
    ws.on("error", () => {
      /* 'close' fires next */
    });
  };
  connect();
}
