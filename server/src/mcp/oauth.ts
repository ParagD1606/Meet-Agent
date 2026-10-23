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
};

export class McpReauthRequired extends Error {
  constructor(public connectionId: string) {
    super(`MCP connection ${connectionId} needs to be reconnected`);
    this.name = "McpReauthRequired";
  }
}

export const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/mcp-oauth/callback`;

export async function readAuth(connectionId: string): Promise<AuthState> {
  const [row] = await db.select({ a: mcpConnections.authEnc }).from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  if (!row?.a) return {};
  try { return JSON.parse(decrypt(row.a)) as AuthState; } catch { return {}; }
}

export async function writeAuth(connectionId: string, patch: Partial<AuthState>, replace = false): Promise<void> {
  const next = replace ? (patch as AuthState) : { ...(await readAuth(connectionId)), ...patch };
  await db.update(mcpConnections).set({ authEnc: encrypt(JSON.stringify(next)) }).where(eq(mcpConnections.id, connectionId));
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
    await writeAuth(this.connectionId, { state: s });
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
    const prev = await readAuth(this.connectionId);
    await writeAuth(this.connectionId, {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? prev.refreshToken, // refresh responses often omit it
      tokenType: t.token_type,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
      codeVerifier: undefined,
      state: undefined,
    });
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
