import { dirname, isAbsolute, resolve } from "node:path";
import { ConfigError } from "../config.ts";
import { DEFAULT_PBKDF2_ITERATIONS } from "./auth.ts";
import { initDbKey } from "./crypto.ts";
import { openDatabase } from "./db.ts";
import { ApiError } from "./errors.ts";
import { createRequestHandler } from "./http.ts";
import { MessagingStore } from "./store.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_SESSION_TTL_DAYS = 30;

export interface ServeOverrides {
  host?: string;
  port?: number;
  dbPath?: string;
  dbKey?: string;
}

export interface ServerSettings {
  host: string;
  port: number;
  dbPath: string;
  /** When set, message bodies are encrypted at rest with AES-256-GCM. */
  dbKey?: string;
  sessionTtlMs: number;
  passwordIterations: number;
  /** Optional handle promoted to administrator at startup. */
  adminHandle?: string;
}

export function loadServerSettings(
  env: Record<string, string | undefined>,
  dataDir: string,
  overrides: ServeOverrides = {},
): ServerSettings {
  const host = (overrides.host ?? env.PULSEWIRE_SERVER_HOST ?? DEFAULT_HOST).trim();
  if (!host) throw new ConfigError("The server host cannot be empty.");
  if (/[\u0000-\u001f\u007f]/.test(host)) {
    throw new ConfigError("The server host must not contain control characters.");
  }

  const port = overrides.port ?? parseInteger(
    env.PULSEWIRE_SERVER_PORT,
    "PULSEWIRE_SERVER_PORT",
    DEFAULT_PORT,
    1,
    65_535,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("The server port must be an integer between 1 and 65535.");
  }

  const configuredDb = overrides.dbPath ?? env.PULSEWIRE_SERVER_DB ?? `${dataDir}/pulsewire.db`;
  if (!configuredDb.trim()) throw new ConfigError("The database path cannot be empty.");
  const dbPath = configuredDb === ":memory:"
    ? configuredDb
    : isAbsolute(configuredDb)
    ? configuredDb
    : resolve(configuredDb);

  const dbKey = overrides.dbKey ?? ((env.PULSEWIRE_DB_KEY ?? "").trim() || undefined);

  const ttlDays = parseInteger(
    env.PULSEWIRE_SESSION_TTL_DAYS,
    "PULSEWIRE_SESSION_TTL_DAYS",
    DEFAULT_SESSION_TTL_DAYS,
    1,
    365,
  );
  const passwordIterations = parseInteger(
    env.PULSEWIRE_PBKDF2_ITERATIONS,
    "PULSEWIRE_PBKDF2_ITERATIONS",
    DEFAULT_PBKDF2_ITERATIONS,
    10_000,
    2_000_000,
  );

  const adminHandle = (env.PULSEWIRE_ADMIN_HANDLE ?? "").trim() || undefined;

  return {
    host,
    port,
    dbPath,
    dbKey,
    sessionTtlMs: ttlDays * 24 * 60 * 60 * 1_000,
    passwordIterations,
    ...(adminHandle ? { adminHandle } : {}),
  };
}

export interface RunningServer {
  url: string;
  finished: Promise<void>;
  shutdown(): Promise<void>;
  dbPath: string;
}

/** Start the HTTP API and block until the process is stopped. */
export async function startServer(
  settings: ServerSettings,
  options: { quiet?: boolean } = {},
): Promise<RunningServer> {
  if (settings.dbPath !== ":memory:") {
    await Deno.mkdir(dirname(settings.dbPath), { recursive: true });
  }
  const db = openDatabase(settings.dbPath);
  if (settings.dbKey) {
    await initDbKey(settings.dbKey);
  }
  const store = new MessagingStore(db, {
    passwordIterations: settings.passwordIterations,
    sessionTtlMs: settings.sessionTtlMs,
  });
  try {
    store.ensureAdmin(settings.adminHandle);
  } catch (error) {
    try {
      db.close();
    } catch {
      // The original configuration error is more useful than a close failure.
    }
    if (error instanceof ApiError) {
      throw new ConfigError(
        `PULSEWIRE_ADMIN_HANDLE is invalid: ${error.message} ` +
          "Register that account first, or remove the variable.",
      );
    }
    throw error;
  }
  const handler = createRequestHandler(store, {
    onRequest: options.quiet ? undefined : (method, path, status) => {
      // Request metadata only: never log bodies, passwords, or tokens.
      console.log(`${new Date().toISOString()} ${method} ${path} ${status}`);
    },
  });

  const server = Deno.serve({
    hostname: settings.host,
    port: settings.port,
    ...(options.quiet ? { onListen: () => {} } : {}),
  }, handler);
  const address = server.addr as Deno.NetAddr;
  const displayHost = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname;
  const url = `http://${displayHost}:${address.port}`;

  let closed = false;
  const closeDatabase = (): void => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      // Closing an already-closed database must not mask shutdown.
    }
  };
  const shutdown = async (): Promise<void> => {
    await server.shutdown();
    closeDatabase();
  };

  return {
    url,
    dbPath: settings.dbPath,
    finished: server.finished.then(() => {
      closeDatabase();
    }),
    shutdown,
  };
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}
