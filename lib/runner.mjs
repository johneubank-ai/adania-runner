// The reverse-WS runtime: fetch the member's assigned agents + relay URL, hold a WebSocket to the relay,
// run each pushed turn locally via the Claude Agent SDK, and send the reply back over the same socket.
import WebSocket from "ws";
import { ADANIA_API } from "./config.mjs";

// Run one turn via the Claude Agent SDK (the CLI self-resolves; uses this machine's Claude Code login).
async function runTurn(payload) {
  try {
    delete process.env.ANTHROPIC_API_KEY; // a Claude Code OAuth token must win auth precedence
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Accept either a messages[] array (webchat) or a single message string (slack/linear/github).
    const messages = payload?.messages ?? (payload?.message ? [{ role: "user", content: payload.message }] : []);
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    let text = "";
    for await (const m of query({
      prompt,
      // Text-only by construction: `tools: []` disables every built-in tool (Read/Write/Edit/Bash/…),
      // so the agent has NO filesystem or shell access — it can only emit a reply. `permissionMode:
      // "dontAsk"` + empty `allowedTools` is belt-and-suspenders: anything not pre-approved is denied,
      // never prompted (this runner is headless). Granting real tools here would expose YOUR machine to
      // whoever can trigger a turn (any org member's Slack/web message) — do that only behind a sandbox.
      options: { model: "claude-opus-4-8", maxTurns: 1, tools: [], allowedTools: [], permissionMode: "dontAsk" },
    })) {
      if (m.type === "result" && m.subtype === "success") text = m.result ?? "";
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
        const reply = await runTurn(f.payload);
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
