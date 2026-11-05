/**
 * Password and session primitives for the Pulsewire server.
 *
 * Passwords are derived with PBKDF2-HMAC-SHA-256 and a per-user random salt.
 * Session tokens are random 256-bit values; only their SHA-256 hash is stored
 * in the database, so a leaked database cannot be replayed as a login.
 */

const PASSWORD_PREFIX = "pbkdf2-sha256";
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const TOKEN_BYTES = 32;

const encoder = new TextEncoder();

export async function hashPassword(
  password: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("PBKDF2 iterations must be a positive integer.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(password, salt, iterations);
  return `${PASSWORD_PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;
  const salt = fromBase64(parts[2] ?? "");
  const expected = fromBase64(parts[3] ?? "");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Create a random session token. Returns the raw token and its stored hash. */
export async function createSessionToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const token = toBase64Url(bytes);
  return { token, tokenHash: await hashToken(token) };
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}
