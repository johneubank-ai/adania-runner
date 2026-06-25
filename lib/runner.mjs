// The reverse-WS runtime: fetch the member's assigned agents + relay URL, hold a WebSocket to the relay,
// run each pushed turn locally via the Claude Agent SDK, and send the reply back over the same socket.
import WebSocket from "ws";
import { ADANIA_API } from "./config.mjs";

// How many agent turns (tool-call rounds) a single request may take before it must reply. Generous so the
// agent can do real multi-step work (read several repos, compose, post) in one turn. Override via env.
const MAX_TURNS = Number(process.env.ADANIA_MAX_TURNS ?? 100);

// Run one turn via the Claude Agent SDK, FULL-CAPABILITY on THIS machine: the agent gets the complete default
// Claude Code toolset (Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/…) via the `claude_code` preset,
// bypasses all permission prompts (headless), and may take many tool calls before replying. Slack/Linear/
// GitHub come from the bot's act-as-agent CONNECTOR MCP servers (HTTP + signed Bearer minted by the backend),
// so the agent posts AS the bot without any service token ever touching this machine or the model.
//
// This deliberately grants any triggerable turn full host access (no sandbox) — the operator's explicit
// choice. To narrow it later, gate tools/connectors per bot via the AgentConfig instead of here.
async function runTurn(payload, bot) {
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
      cwd: process.env.HOME, // run where the user's repos/files live, like Claude Code on this machine
    };
    if (cfg?.instructions) options.systemPrompt = cfg.instructions;
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

// `getToken` returns a FRESH id token on each call (ensureSession refreshes the ~1h Cognito ID token when
// it has expired). We call it at startup AND before every (re)connect's `hello`, because the relay-gw only
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
  let data;
  try {
    data = await fetchBots(idToken);
  } catch (e) {
    console.error("Could not fetch your agents:", e.message);
    process.exit(1);
  }
  const orgs = data.orgs ?? [];
  const bots = data.bots ?? [];
  console.log(`\nSigned in. ${orgs.length} org(s), ${bots.length} assigned agent(s):`);
  for (const b of bots) console.log(`  • ${b.name}  [${(b.channels ?? []).join(", ") || "—"}]  (${b.organizationName})`);
  // Index the assigned bots so each pushed turn resolves its bot's AgentConfig (model/instructions/connectors).
  const botsById = new Map(bots.map((b) => [b.id, b]));
  const botsBySlug = new Map(bots.filter((b) => b.config?.slug).map((b) => [b.config.slug, b]));
  const wsUrl = data.relay?.ws;
  if (!wsUrl) {
    console.error("No relay WebSocket URL returned by the backend — cannot receive turns.");
    process.exit(1);
  }

  let backoff = 1000;
  const connect = async () => {
    // Mint a fresh token for THIS connection's hello (refreshes if the previous one expired).
    let token = idToken;
    try {
      token = await getToken();
      idToken = token;
    } catch {
      /* refresh failed (refresh token also expired) → try the last token; a 4401 close just retries */
    }
    const ws = new WebSocket(wsUrl);
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
        console.log(`\n● Connected — listening for turns (${f.memberships ?? 0} membership(s)). Keep this running.`);
        return;
      }
      if (f.type === "error") {
        console.error("relay error:", f.error);
        return;
      }
      if (f.type === "event" && f.turnId) {
        const label = (f.payload?.channel ?? "turn") + (f.payload?.message ? `: ${String(f.payload.message).slice(0, 60)}` : "");
        console.log(`→ ${label}`);
        const bot = botsById.get(f.payload?.botId) ?? botsBySlug.get(f.payload?.slug);
        const reply = await runTurn(f.payload, bot);
        console.log(`← ${reply.slice(0, 80)}`);
        try {
          ws.send(JSON.stringify({ type: "reply", turnId: f.turnId, reply }));
        } catch {
          /* socket dropped mid-reply → server times out the turn → portal Retry covers it */
        }
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
