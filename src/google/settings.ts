import { resolve } from "node:path";
import { ConfigError } from "../config.ts";

export interface GoogleChatSettings {
  dataDir: string;
  tokenPath: string;
  readStatePath: string;
  pollIntervalMs: number;
  maxSpaces: number;
  userResource?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  credentialsFile?: string;
}

export interface GoogleChatDescription {
  pollIntervalMs: number;
  maxSpaces: number;
  tokenPath: string;
  readStatePath: string;
  credentialsSource: "access-token" | "environment" | "credentials-file" | "missing";
  credentialsFile?: string;
  userResource?: string;
}

export async function loadGoogleChatSettings(options: {
  dataDir: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): Promise<GoogleChatSettings> {
  const env = options.env ?? Deno.env.toObject();
  const cwd = options.cwd ?? Deno.cwd();
  const accessToken = clean(env.GOOGLE_CHAT_ACCESS_TOKEN);
  let clientId = clean(env.GOOGLE_CHAT_CLIENT_ID);
  let clientSecret = clean(env.GOOGLE_CHAT_CLIENT_SECRET);
  const credentialsFile = clean(env.GOOGLE_CHAT_CREDENTIALS_FILE);
  const credentialsPath = credentialsFile ? resolve(cwd, credentialsFile) : undefined;

  if ((!clientId || !clientSecret) && credentialsPath) {
    const credentials = await readOAuthClient(credentialsPath);
    clientId = clientId ?? credentials.clientId;
    clientSecret = clientSecret ?? credentials.clientSecret;
  }

  const tokenPath = resolve(
    cwd,
    clean(env.GOOGLE_CHAT_TOKEN_FILE) ?? `${options.dataDir}/googlechat-token.json`,
  );
  const readStatePath = resolve(cwd, `${options.dataDir}/googlechat-readstate.json`);

  return {
    dataDir: options.dataDir,
    tokenPath,
    readStatePath,
    pollIntervalMs: parseNonNegativeInt(
      env.GOOGLE_CHAT_POLL_INTERVAL_MS,
      20_000,
      "GOOGLE_CHAT_POLL_INTERVAL_MS",
    ),
    maxSpaces: parsePositiveInt(env.GOOGLE_CHAT_MAX_SPACES, 30, "GOOGLE_CHAT_MAX_SPACES", 100),
    userResource: normalizeUserResource(env.GOOGLE_CHAT_USER_RESOURCE),
    accessToken,
    clientId,
    clientSecret,
    credentialsFile: credentialsPath,
  };
}

export function describeGoogleChat(settings: GoogleChatSettings): GoogleChatDescription {
  const description: GoogleChatDescription = {
    pollIntervalMs: settings.pollIntervalMs,
    maxSpaces: settings.maxSpaces,
    tokenPath: settings.tokenPath,
    readStatePath: settings.readStatePath,
    credentialsSource: settings.accessToken
      ? "access-token"
      : settings.clientId && settings.clientSecret
      ? (settings.credentialsFile ? "credentials-file" : "environment")
      : "missing",
  };
  if (settings.credentialsFile) description.credentialsFile = settings.credentialsFile;
  if (settings.userResource) description.userResource = settings.userResource;
  return description;
}

export async function readOAuthClient(
  path: string,
): Promise<{ clientId: string; clientSecret: string }> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    throw new ConfigError(
      `Could not read the Google OAuth client file at ${path}: ${messageOf(error)}`,
      { path, cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`The Google OAuth client file is not valid JSON: ${path}`, {
      path,
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`The Google OAuth client file must contain a JSON object: ${path}`, {
      path,
    });
  }
  const section = isRecord(parsed.installed)
    ? parsed.installed
    : isRecord(parsed.web)
    ? parsed.web
    : parsed;
  const clientId = section.client_id;
  const clientSecret = section.client_secret;
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw new ConfigError(
      `The Google OAuth client file is missing "client_id". Download a Desktop app client JSON from Google Cloud.`,
      { path },
    );
  }
  if (typeof clientSecret !== "string" || !clientSecret.trim()) {
    throw new ConfigError(
      `The Google OAuth client file is missing "client_secret". Download a Desktop app client JSON from Google Cloud.`,
      { path },
    );
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

export const GOOGLE_CHAT_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  "https://www.googleapis.com/auth/chat.users.readstate",
];
export const GOOGLE_CHAT_SCOPE_STRING = GOOGLE_CHAT_SCOPES.join(" ");

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeUserResource(value: string | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) return undefined;
  return trimmed.startsWith("users/") ? trimmed : `users/${trimmed}`;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (parsed > 3_600_000) throw new ConfigError(`${name} must be 3600000 or less.`);
  return parsed;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) {
    throw new ConfigError(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
