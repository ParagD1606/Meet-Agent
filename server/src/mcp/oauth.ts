import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db } from "../db";
import { mcpConnections } from "../db/schema";

/** Decrypted shape of mcp_connections.auth_enc. */
export type AuthState = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string;
  bearer?: boolean; // static API token, no OAuth
  clientInfo?: OAuthClientInformationMixed;
  codeVerifier?: string;
  state?: string; // pending OAuth state nonce
  stateExpiresAt?: number; // epoch ms; a callback after this is refused
};

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** The stored blob could not be decrypted/parsed (wrong ENCRYPTION_KEY or corruption). Never silently treated as "no auth". */
export class AuthDecryptError extends Error {
  constructor(public connectionId: string) {
    super(`stored credentials for MCP connection ${connectionId} cannot be decrypted`);
    this.name = "AuthDecryptError";
  }
}

export class McpReauthRequired extends Error {
  constructor(public connectionId: string) {
    super(`MCP connection ${connectionId} needs to be reconnected`);
    this.name = "McpReauthRequired";
  }
}

export const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/mcp-oauth/callback`;

const parseAuth = (connectionId: string, blob: string | null | undefined): AuthState => {
  if (!blob) return {};
  try { return JSON.parse(decrypt(blob)) as AuthState; } catch { throw new AuthDecryptError(connectionId); }
};

/** Throws AuthDecryptError when a blob exists but cannot be decrypted. Returns {} when nothing is stored. */
export async function readAuth(connectionId: string): Promise<AuthState> {
  const [row] = await db.select({ a: mcpConnections.authEnc }).from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  return parseAuth(connectionId, row?.a);
}

/**
 * Read-modify-write of the encrypted auth blob under a row lock, so a token refresh and a state/verifier write
 * racing each other cannot overwrite one another. A missing connection is a no-op.
 */
export async function updateAuth(connectionId: string, fn: (cur: AuthState) => AuthState): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ a: mcpConnections.authEnc }).from(mcpConnections).where(eq(mcpConnections.id, connectionId)).for("update");
    if (!row) return;
    const next = fn(parseAuth(connectionId, row.a));
    await tx.update(mcpConnections).set({ authEnc: encrypt(JSON.stringify(next)) }).where(eq(mcpConnections.id, connectionId));
  });
}

export async function writeAuth(connectionId: string, patch: Partial<AuthState>, replace = false): Promise<void> {
  if (replace) {
    await db.update(mcpConnections).set({ authEnc: encrypt(JSON.stringify(patch)) }).where(eq(mcpConnections.id, connectionId));
    return;
  }
  await updateAuth(connectionId, (cur) => ({ ...cur, ...patch }));
}

/**
 * OAuthClientProvider persisting everything encrypted in mcp_connections.auth_enc.
 * interactive=true (connect flow) captures the authorization URL; interactive=false (runtime) refuses to redirect.
 */
export class DbOAuthProvider implements OAuthClientProvider {
  authUrl?: URL;
  constructor(private connectionId: string, private interactive: boolean, private scope?: string) {}

  get redirectUrl() { return redirectUri(); }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Company Brain",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }
  async state() {
    const s = `${this.connectionId}.${randomBytes(16).toString("base64url")}`;
    await writeAuth(this.connectionId, { state: s, stateExpiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    return s;
  }
  async clientInformation() { return (await readAuth(this.connectionId)).clientInfo; }
  async saveClientInformation(info: OAuthClientInformationMixed) { await writeAuth(this.connectionId, { clientInfo: info }); }
  async tokens(): Promise<OAuthTokens | undefined> {
    const a = await readAuth(this.connectionId);
    if (!a.accessToken) return undefined;
    return {
      access_token: a.accessToken,
      token_type: a.tokenType ?? "Bearer",
      ...(a.refreshToken ? { refresh_token: a.refreshToken } : {}),
      ...(a.expiresAt ? { expires_in: Math.max(0, Math.floor((a.expiresAt - Date.now()) / 1000)) } : {}),
    };
  }
  async saveTokens(t: OAuthTokens) {
    await updateAuth(this.connectionId, (prev) => ({
      ...prev,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? prev.refreshToken, // refresh responses often omit it
      tokenType: t.token_type,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
      codeVerifier: undefined,
      state: undefined,
      stateExpiresAt: undefined,
    }));
    await db.update(mcpConnections).set({ status: "connected" }).where(eq(mcpConnections.id, this.connectionId));
  }
  async saveCodeVerifier(v: string) { await writeAuth(this.connectionId, { codeVerifier: v }); }
  async codeVerifier() {
    const v = (await readAuth(this.connectionId)).codeVerifier;
    if (!v) throw new Error("missing PKCE code verifier");
    return v;
  }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new McpReauthRequired(this.connectionId);
    this.authUrl = url;
  }
}
