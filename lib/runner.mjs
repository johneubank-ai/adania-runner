// The reverse-WS runtime: fetch the member's assigned agents + relay URL, hold a WebSocket to the relay, run
// each pushed turn locally via the Claude Agent SDK in THAT org's working directory, and send the reply back
// over the same socket.
import WebSocket from "ws";
import { ADANIA_API } from "./config.mjs";
import { awaitProvisioning, dirForTurn, seedBotDirs } from "./orgdirs.mjs";

// How many agent turns (tool-call rounds) a single request may take before it must reply. Generous so the
// agent can do real multi-step work (read several repos, compose, post) in one turn. Override via env.
const MAX_TURNS = Number(process.env.ADANIA_MAX_TURNS ?? 100);

// Hard wall-clock fallback for a single turn. We deliberately keep a turn ALIVE across background waits (so a
// "background a 5-min timer, then post the next message" pattern actually resumes instead of ending the turn —
// see runTurn), which means a turn can legitimately run for a long time. This abort is the only backstop
// against a background task that never settles. Default 90 min; override via ADANIA_MAX_RUNTIME_MS.
const MAX_RUNTIME_MS = Number(process.env.ADANIA_MAX_RUNTIME_MS ?? 90 * 60_000);

// A controllable async-iterable of user messages — the streaming INPUT to query(). It yields the initial
// prompt, then stays open (an awaited next() that never resolves on its own) so the runner can inject
// continuation messages when a background task settles, and ends the session only when we explicitly close().
// This is what lets a turn outlive the model's first "I'm done" — see runTurn.
function makeInputStream(first) {
  const buf = [first];
  let pending = null; // resolver for a next() that's waiting because the buffer is empty
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      if (pending) {
        const r = pending;
        pending = null;
        r({ value: msg, done: false });
      } else buf.push(msg);
    },
    close() {
      closed = true;
      if (pending) {
        const r = pending;
        pending = null;
        r({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((res) => (pending = res));
          },
        };
      },
    },
  };
}

const userMsg = (content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });

// Run one turn via the Claude Agent SDK, FULL-CAPABILITY on THIS machine: the agent gets the complete default
// Claude Code toolset (Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/…) via the `claude_code` preset,
// bypasses all permission prompts (headless), and may take many tool calls before replying. Slack/Linear/
// GitHub come from the bot's act-as-agent CONNECTOR MCP servers (HTTP + signed Bearer minted by the backend),
// so the agent posts AS the bot without any service token ever touching this machine or the model.
//
// `cwd` is the ORG's working directory (orgdirs.mjs resolves + creates it). This deliberately grants any
// triggerable turn full host access (no sandbox) — the operator's explicit choice; the per-org cwd organizes
// each org's work into its own folder but is NOT a security boundary (see orgdirs.mjs).
//
// ALWAYS WAITS FOR BACKGROUND WORK. We run in streaming-input mode and keep the input stream open: when the
// model emits a `result` (it thinks it's done) but background tasks are still in flight, we do NOT end the
// turn — we wait, and when a task settles we inject a continuation message so the model resumes as part of the
// SAME run. The turn ends only when the model finishes with nothing still running, or MAX_RUNTIME_MS aborts.
// We track in-flight work conservatively (a missed signal can only stall to the abort, never end early): both
// the model's own run_in_background Bash calls (by tool_use id) and task-framework subagents (by task id).
async function runTurn(payload, bot, cwd, org) {
  const ac = new AbortController();
  const killTimer = setTimeout(() => ac.abort(), MAX_RUNTIME_MS);
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
      abortController: ac, // the MAX_RUNTIME_MS backstop (also kills any still-running background child on abort)
      // Load the org's project memory (./CLAUDE.md from cwd). The Agent SDK does NOT read filesystem setting
      // sources by default — without this, the per-org CLAUDE.md is never loaded even though cwd points at it,
      // so its rules (e.g. Slack brevity, git policy) silently never reach the model.
      settingSources: ["project"],
      // …but settingSources ALSO makes the SDK auto-discover the OPERATOR's personal MCP — including their
      // claude.ai cloud connectors (Slack/Drive/Gmail/Linear/…), which act AS the human. That let the agent
      // post Slack messages as the operator ("Sent using Claude") instead of via the bot's act-as-agent
      // connector. Lock the toolset to ONLY the backend-minted connectors passed in options.mcpServers below:
      strictMcpConfig: true, // ignore project .mcp.json / user-settings / plugin MCP — use only options.mcpServers
      managedSettings: { disableClaudeAiConnectors: true }, // never auto-fetch the operator's claude.ai connectors
    };
    // Tell the agent which identity it's running AS and WHERE its knowledge base lives. The relay never names
    // the agent in the prompt (that's just the message text), so prepend a fixed invocation-context block with
    // this bot's AgentDefinition slug AND the org's kb repo. Without the owner the agent guessed it from the
    // connector name (mcp__adania-github__*) and 404'd on /repos/adania/kb — so name it explicitly. The GitHub
    // connector stays the PRIMARY kb path (with retries for transient 503s); the per-bot ./kb checkout in the
    // agent's own cwd is the local FALLBACK only after retries are exhausted.
    const ghOrg = org?.githubOrgSlug;
    const ctxLines = [];
    if (cfg?.slug) ctxLines.push(`You are agent ${cfg.slug}.`);
    if (ghOrg)
      ctxLines.push(
        `Your knowledge base is the GitHub repo "${ghOrg}/kb" (owner "${ghOrg}", repo "kb" — do NOT guess ` +
          `"adania"). Use the GitHub connector (e.g. put_file / get_file_contents) as the primary way to read ` +
          `and write it. If a connector call fails, retry it at least 3 times, waiting 10 seconds between ` +
          `attempts, before falling back to local git on the ./kb checkout in your working directory.`,
      );
    const invocationContext = ctxLines.length ? `[INVOCATION CONTEXT]\n${ctxLines.join("\n")}` : "";
    const systemPrompt = [invocationContext, cfg?.instructions].filter(Boolean).join("\n\n");
    // APPEND to the Claude Code base prompt, don't REPLACE it. A plain-string systemPrompt overrides the
    // default preset — which is also what surfaces loaded CLAUDE.md memory — so use the preset+append form to
    // keep the base prompt (and project-memory injection) while still carrying our invocation context.
    if (systemPrompt) options.systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
    if (Object.keys(mcpServers).length) options.mcpServers = mcpServers;

    const input = makeInputStream(userMsg(prompt));
    const outstanding = new Set(); // ids of in-flight background work; only emptiness matters, not the count
    let idle = false; // model emitted a result and is now parked, waiting for background work to wake it
    let text = "";

    for await (const m of query({ prompt: input.stream, options })) {
      if (m.type === "assistant") {
        // A backgrounded Bash keeps running after the model moves on; remember it (by tool_use id, which the
        // settle notification echoes) so we never end the turn while it's still going.
        for (const b of m.message?.content ?? []) {
          if (b?.type === "tool_use" && b.input?.run_in_background === true) outstanding.add(b.id);
        }
      } else if (m.type === "system" && m.subtype === "task_started") {
        outstanding.add(m.task_id); // task-framework background work (subagents / background tasks)
      } else if (m.type === "system" && m.subtype === "task_notification") {
        // A background task settled (completed | failed | stopped). Clear it by whichever id space it used.
        outstanding.delete(m.task_id);
        if (m.tool_use_id) outstanding.delete(m.tool_use_id);
        // If the model had already parked, wake it to continue the run as part of this same turn.
        if (idle) {
          input.push(
            userMsg(
              `[BACKGROUND TASK ${m.status}] ${m.summary || m.task_id}` +
                (m.output_file ? ` (output: ${m.output_file})` : "") +
                `. Continue with your plan.`,
            ),
          );
          idle = false;
        }
      } else if (m.type === "result") {
        // The terminal `result` of a model response cycle: success carries `result` text; an error subtype
        // (error_max_turns / error_during_execution / error_max_budget_usd / …) has no `result`, has errors[].
        text =
          m.subtype === "success"
            ? (m.result ?? "")
            : `⚠️ ${m.subtype}${m.errors?.length ? ": " + m.errors.join("; ") : ""}`;
        // The model thinks it's done. End the turn ONLY if nothing is still running; otherwise stay open and
        // park — a task_notification above will wake it and the loop continues.
        if (outstanding.size === 0) input.close();
        else idle = true;
      }
    }
    return text || "(no text)";
  } catch (e) {
    if (ac.signal.aborted) {
      const mins = Math.round(MAX_RUNTIME_MS / 60_000);
      return "⚠️ turn hit the " + mins + "-min runtime limit (background work did not finish in time)";
    }
    return "⚠️ " + (e?.message ?? String(e));
  } finally {
    clearTimeout(killTimer);
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

  // (Re)fetch the agent config + orgs, rebuild the indexes, and ensure each assigned agent's per-bot working
  // dir exists (KB-seeding it on first creation). interactive=true prompts on a TTY for orgs with no saved
  // path. This is the single source of truth for "what do I serve" — called at startup and again whenever
  // memberships change on a reconnect, so a bot/org assigned after launch is picked up (also fixes stale config).
  const refresh = async (token, { interactive }) => {
    const data = await fetchBots(token);
    const orgs = data.orgs ?? [];
    const bots = data.bots ?? [];
    botsById = new Map(bots.map((b) => [b.id, b]));
    const { orgsById: idx } = indexOrgs(orgs, bots);
    orgsById = idx;
    relayWs = data.relay?.ws ?? relayWs;
    console.log(`\nSigned in. ${orgs.length} org(s), ${bots.length} assigned agent(s):`);
    for (const b of bots) {
      console.log(`  • ${b.name}  [${(b.channels ?? []).join(", ") || "—"}]  (${b.organizationName})`);
    }
    await seedBotDirs(bots, orgsById, { interactive, log: console.log });
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

  // Per-AGENT serialization: turns that resolve to the SAME working dir (same org + slug — see dirForTurn) run
  // strictly sequentially, so two turns never corrupt that agent's git tree / .git/index.lock. DIFFERENT agents
  // (and different orgs) run CONCURRENTLY — so an @-mentioned agent can reply in-thread while another agent's
  // long turn is still running. Keyed by org+slug (the dir-determining tuple), falling back to botId, then
  // "_unassigned". The map persists across reconnects.
  const turnQueues = new Map();
  const enqueueTurn = (key, fn) => {
    const prev = turnQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the prior turn's outcome
    turnQueues.set(
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
        // Serialize per AGENT (the dir-determining org+slug tuple), so different agents run concurrently. Falls
        // back to botId, then "_unassigned", when the org can't be determined upfront (legacy slug-less payload).
        const turnKey = orgId ? `${orgId}:${payload.slug ?? payload.botId ?? "_"}` : (payload.botId ?? "_unassigned");
        const label =
          (payload.channel ?? "turn") + (payload.message ? `: ${String(payload.message).slice(0, 60)}` : "");
        console.log(`→ ${label}`);
        enqueueTurn(turnKey, async () => {
          try {
            let bot = botsById.get(payload.botId);
            if (!bot && payload.botId) {
              await maybeRefresh(); // a bot assigned after our last refresh (mints a fresh token internally)
              bot = botsById.get(payload.botId);
              if (!orgId) orgId = bot?.organizationId ?? null; // recover org now that the index is warm
            }
            const cwd = await dirForTurn({ organizationId: orgId, slug: payload.slug, orgsById, log: console.log });
            await awaitProvisioning(cwd); // let THIS agent's kb finish initializing before we run in its tree
            const org = orgId ? (orgsById.get(orgId) ?? null) : null; // carries githubOrgSlug for the kb context
            const reply = await runTurn(payload, bot, cwd, org);
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
