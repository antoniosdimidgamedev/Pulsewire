import { ChatError, errorMessage } from "../chat/errors.ts";
import type { User } from "../chat/types.ts";
import { writePrivateJson } from "../storage.ts";
import { GOOGLE_CHAT_SCOPE_STRING } from "./settings.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GoogleUserProfile {
  id: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface GoogleSession {
  getAccessToken(): Promise<string>;
  getUser(): Promise<User>;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType: string;
}

export interface OAuthTokenFile {
  version: 1;
  token: OAuthToken;
  profile?: GoogleUserProfile;
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export class GoogleOAuthSession implements GoogleSession {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenPath: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly userResource?: string;
  private loaded = false;
  private token?: OAuthToken;
  private profile?: GoogleUserProfile;

  constructor(options: {
    clientId: string;
    clientSecret: string;
    tokenPath: string;
    userResource?: string;
    fetchImpl?: FetchLike;
    now?: () => number;
  }) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tokenPath = options.tokenPath;
    this.userResource = options.userResource;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    await this.load();
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.accessToken;
    }
    if (this.token?.refreshToken) {
      await this.refresh();
      if (this.token && this.token.expiresAt > this.now()) return this.token.accessToken;
    }
    throw new ChatError(
      "auth_required",
      "No usable Google Chat session. Run `pulsewire auth google` to sign in again.",
    );
  }

  async getUser(): Promise<User> {
    await this.load();
    if (this.profile) return profileToUser(this.profile, this.userResource);
    const accessToken = await this.getAccessToken();
    this.profile = await fetchUserProfile(accessToken, this.fetchImpl);
    await this.save();
    return profileToUser(this.profile, this.userResource);
  }

  async authorizeInteractive(
    options: { onUrl: (url: string) => void; openBrowser?: boolean; timeoutMs?: number },
  ): Promise<User> {
    const state = crypto.randomUUID();
    const deferred = Promise.withResolvers<string>();
    let settled = false;

    const finish = (error?: unknown, code?: string) => {
      if (settled) return;
      settled = true;
      if (error) deferred.reject(error);
      else deferred.resolve(code ?? "");
    };

    const listening = Promise.withResolvers<Deno.NetAddr>();
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => listening.resolve(address as Deno.NetAddr),
    }, (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/oauth2callback") {
        return new Response("Not found", { status: 404 });
      }
      const error = url.searchParams.get("error");
      if (error) {
        finish(new ChatError("auth_required", `Google authorization was denied: ${error}`));
        return htmlResponse(
          "<h1>Authorization cancelled</h1><p>You can close this tab and return to Pulsewire.</p>",
          400,
        );
      }
      if (url.searchParams.get("state") !== state) {
        finish(
          new ChatError("auth_required", "Google authorization returned an invalid state value."),
        );
        return htmlResponse("<h1>Authorization failed</h1><p>Invalid state.</p>", 400);
      }
      const code = url.searchParams.get("code");
      if (!code) {
        finish(new ChatError("auth_required", "Google authorization did not return a code."));
        return htmlResponse("<h1>Authorization failed</h1><p>No authorization code.</p>", 400);
      }
      finish(undefined, code);
      return htmlResponse(
        "<h1>Pulsewire is authorized</h1><p>You can close this tab and return to the terminal.</p>",
      );
    });

    const timeoutMs = options.timeoutMs ?? 300_000;
    const timer = setTimeout(() => {
      finish(new ChatError("auth_required", "Google authorization timed out after five minutes."));
    }, timeoutMs);

    try {
      const address = await listening.promise;
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const params = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_CHAT_SCOPE_STRING,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;
      options.onUrl(authorizeUrl);
      if (options.openBrowser !== false) {
        await openBrowser(authorizeUrl);
      }
      const code = await deferred.promise;
      this.token = await exchangeCode({
        code,
        redirectUri,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
      const accessToken = this.token.accessToken;
      this.profile = await fetchUserProfile(accessToken, this.fetchImpl);
      await this.save();
      return profileToUser(this.profile, this.userResource);
    } finally {
      clearTimeout(timer);
      await server.shutdown().catch(() => undefined);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.tokenPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw new ChatError(
        "storage_unavailable",
        `Could not read the Google token cache at ${this.tokenPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ChatError(
        "storage_corrupt",
        `The Google token cache at ${this.tokenPath} is not valid JSON. Run \`pulsewire auth google\` to replace it.`,
        { cause: error },
      );
    }
    if (!isTokenFile(parsed)) {
      throw new ChatError(
        "storage_corrupt",
        `The Google token cache at ${this.tokenPath} is invalid. Run \`pulsewire auth google\` to replace it.`,
      );
    }
    this.token = parsed.token;
    this.profile = parsed.profile;
  }

  private async refresh(): Promise<void> {
    if (!this.token?.refreshToken) return;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.token.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await requestToken(body, this.fetchImpl);
    this.token = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? this.token.refreshToken,
      expiresAt: this.now() + response.expires_in * 1000,
      scope: response.scope ?? this.token.scope,
      tokenType: response.token_type ?? "Bearer",
    };
    await this.save();
  }

  private async save(): Promise<void> {
    if (!this.token) return;
    const file: OAuthTokenFile = {
      version: 1,
      token: this.token,
      ...(this.profile ? { profile: this.profile } : {}),
    };
    try {
      await writePrivateJson(this.tokenPath, file);
    } catch (error) {
      throw new ChatError(
        "write_failed",
        `Could not save the Google token cache to ${this.tokenPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

export class StaticGoogleSession implements GoogleSession {
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly userResource?: string;
  private profile?: GoogleUserProfile;

  constructor(options: {
    accessToken: string;
    userResource?: string;
    fetchImpl?: FetchLike;
  }) {
    this.accessToken = options.accessToken;
    this.userResource = options.userResource;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getAccessToken(): Promise<string> {
    return Promise.resolve(this.accessToken);
  }

  async getUser(): Promise<User> {
    if (!this.profile) {
      this.profile = await fetchUserProfile(this.accessToken, this.fetchImpl);
    }
    return profileToUser(this.profile, this.userResource);
  }
}

export async function fetchUserProfile(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleUserProfile> {
  let response: Response;
  try {
    response = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    throw new ChatError(
      "network_error",
      `Could not reach Google user information: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ChatError(
      "auth_required",
      `Google rejected the access token (${response.status}). ${cleanDetail(detail)} ` +
        "Run `pulsewire auth google` to sign in again.",
    );
  }
  const value = await response.json() as Record<string, unknown>;
  const id = stringValue(value.id) ?? stringValue(value.sub);
  if (!id) throw new ChatError("auth_required", "Google did not return a stable user id.");
  const profile: GoogleUserProfile = { id };
  const name = stringValue(value.name);
  const email = stringValue(value.email);
  const picture = stringValue(value.picture);
  if (name) profile.name = name;
  if (email) profile.email = email;
  if (picture) profile.picture = picture;
  return profile;
}

export function profileToUser(profile: GoogleUserProfile, userResource?: string): User {
  const resource = userResource ??
    (profile.id.startsWith("users/") ? profile.id : `users/${profile.id}`);
  const emailHandle = profile.email?.split("@")[0];
  return {
    id: resource,
    displayName: profile.name?.replace(/\s+/g, " ").trim() || emailHandle || "Google user",
    handle: emailHandle || slugHandle(profile.name ?? profile.id),
  };
}

interface TokenEndpointResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

async function exchangeCode(options: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl: FetchLike;
  now: () => number;
}): Promise<OAuthToken> {
  const body = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await requestToken(body, options.fetchImpl);
  return {
    accessToken: response.access_token,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
    expiresAt: options.now() + response.expires_in * 1000,
    ...(response.scope ? { scope: response.scope } : {}),
    tokenType: response.token_type ?? "Bearer",
  };
}

async function requestToken(
  body: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<TokenEndpointResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    throw new ChatError(
      "network_error",
      `Could not reach Google's token service: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const record = isRecord(parsed) ? parsed : {};
    const detail = stringValue(record.error_description) ?? stringValue(record.error) ??
      cleanDetail(text);
    throw new ChatError(
      "auth_required",
      `Google authorization failed (${response.status}): ${detail || "no details"}. ` +
        "Run `pulsewire auth google` to try again.",
    );
  }
  if (!isRecord(parsed) || typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new ChatError("auth_required", "Google's token service returned an incomplete response.");
  }
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const token: TokenEndpointResponse = {
    access_token: parsed.access_token,
    expires_in: expiresIn,
    token_type: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
  };
  if (typeof parsed.refresh_token === "string") token.refresh_token = parsed.refresh_token;
  if (typeof parsed.scope === "string") token.scope = parsed.scope;
  return token;
}

function openBrowser(url: string): Promise<void> {
  try {
    let command: Deno.Command;
    if (Deno.build.os === "windows") {
      command = new Deno.Command("cmd", {
        args: ["/c", "start", "", url],
        stdout: "null",
        stderr: "null",
      });
    } else if (Deno.build.os === "darwin") {
      command = new Deno.Command("open", { args: [url], stdout: "null", stderr: "null" });
    } else {
      command = new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" });
    }
    const child = command.spawn();
    child.unref();
  } catch {
    // Headless machines are normal; the URL is printed by the caller.
  }
  return Promise.resolve();
}

function isTokenFile(value: unknown): value is OAuthTokenFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.token)) return false;
  const token = value.token;
  return typeof token.accessToken === "string" &&
    typeof token.expiresAt === "number" &&
    typeof token.tokenType === "string" &&
    (token.refreshToken === undefined || typeof token.refreshToken === "string") &&
    (value.profile === undefined || isRecord(value.profile));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function slugHandle(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 20) || "user";
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Pulsewire</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;` +
      `line-height:1.5;color:#0f172a}h1{font-size:1.5rem}</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
