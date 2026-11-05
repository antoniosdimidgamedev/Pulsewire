import { writePrivateJson } from "../storage.ts";

export interface StoredSession {
  baseUrl: string;
  token: string;
  userId: string;
  handle: string;
  displayName: string;
  expiresAt: string;
  savedAt: string;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, StoredSession>;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export async function loadSession(
  path: string,
  baseUrl: string,
): Promise<StoredSession | null> {
  const file = await readSessionFile(path);
  const session = file.sessions[normalizeBaseUrl(baseUrl)];
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    await clearSession(path, baseUrl);
    return null;
  }
  return session;
}

export async function saveSession(path: string, session: StoredSession): Promise<void> {
  const file = await readSessionFile(path);
  file.sessions[normalizeBaseUrl(session.baseUrl)] = {
    ...session,
    baseUrl: normalizeBaseUrl(session.baseUrl),
    savedAt: new Date().toISOString(),
  };
  await writePrivateJson(path, file);
}

export async function clearSession(path: string, baseUrl: string): Promise<boolean> {
  const file = await readSessionFile(path);
  const key = normalizeBaseUrl(baseUrl);
  if (!file.sessions[key]) return false;
  delete file.sessions[key];
  await writePrivateJson(path, file);
  return true;
}

async function readSessionFile(path: string): Promise<SessionFile> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text) as Partial<SessionFile>;
    if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      return emptyFile();
    }
    return { version: 1, sessions: parsed.sessions };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyFile();
    // A corrupt session file should not prevent a fresh sign-in. It will be
    // replaced atomically by the next save.
    if (error instanceof SyntaxError) return emptyFile();
    throw error;
  }
}

function emptyFile(): SessionFile {
  return { version: 1, sessions: {} };
}
