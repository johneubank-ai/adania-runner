// adania-customers-dev Cognito (us-east-1) + the public desktop client (PKCE, no secret). All non-secret.
// Shared with adania-ui — both read/write the SAME local session (OS keychain) so either can sign in.
export const COGNITO = {
  domain: "adania-customers-660601648861.auth.us-east-1.amazoncognito.com",
  region: "us-east-1",
  poolId: "us-east-1_XinOnJ2F4",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XinOnJ2F4",
  clientId: "1c05scns13a3nofh7tj7v6ccp9",
  redirectUri: "http://127.0.0.1:8976/callback",
  scope: "openid profile email",
};
export const CALLBACK_PORT = 8976;
// The deployed adania backend: GET /api/bots (orgs + assigned bots + relay URLs), wss://…/api/relay/ws.
export const ADANIA_API = process.env.ADANIA_API ?? "https://app.adania.johneubank.ai";
