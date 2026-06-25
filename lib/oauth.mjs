// Cognito Authorization-Code + PKCE for a native client (public client, no secret) + JWKS verification.
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { COGNITO } from "./config.mjs";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function genPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(challenge) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: COGNITO.clientId,
    redirect_uri: COGNITO.redirectUri,
    scope: COGNITO.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${COGNITO.domain}/oauth2/authorize?${p.toString()}`;
}

export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: COGNITO.clientId,
    code,
    redirect_uri: COGNITO.redirectUri,
    code_verifier: verifier,
  });
  const r = await fetch(`https://${COGNITO.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return r.json();
}

let jwksCache = null;
async function jwks() {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const r = await fetch(`${COGNITO.issuer}/.well-known/jwks.json`);
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  jwksCache = { keys: (await r.json()).keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

export async function verifyIdToken(idToken) {
  const parts = String(idToken ?? "").split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("no matching signing key");
  const pub = createPublicKey({ key: jwk, format: "jwk" });
  if (!cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], "base64url"))) {
    throw new Error("bad signature");
  }
  if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) > payload.exp) throw new Error("expired");
  if (payload.iss !== COGNITO.issuer) throw new Error("issuer mismatch");
  return payload;
}

export function emailFromIdToken(idToken) {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return p.email ?? p["cognito:username"] ?? "unknown";
  } catch {
    return "unknown";
  }
}
