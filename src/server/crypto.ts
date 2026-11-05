/**
 * Application-level encryption for sensitive fields stored in the SQLite
 * database.
 *
 * Deno's `node:sqlite` is linked against stock SQLite, which does NOT support
 * `PRAGMA key` encryption (the pragma is accepted but is a no-op -- plaintext
 * remains readable in the `.db` file). A SQLCipher build is not available, so
 * sensitive fields are encrypted at the application layer with AES-256-GCM
 * before being written and decrypted after being read.
 *
 * The encryption key is derived from the `PULSEWIRE_DB_KEY` environment
 * variable via PBKDF2-HMAC-SHA-256. Losing this key means the encrypted
 * fields cannot be recovered -- back up the `.db` file and the key together.
 *
 * Currently encrypted: `messages.body`.
 * Passwords are already stored as salted PBKDF2 hashes (never plaintext).
 * Session tokens are stored as SHA-256 hashes.
 */

const ALGORITHM = "AES-GCM";
const KEY_BITS = 256;
const IV_BITS = 96;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

let derivedKey: CryptoKey | null = null;

/** Initialize the encryption key from a passphrase. Must be awaited before use. */
export async function initDbKey(secret: string): Promise<void> {
  const material = ENCODER.encode(secret);
  const salt = ENCODER.encode("pulsewire-db-encryption-v1");
  const base = await crypto.subtle.importKey("raw", material, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    base,
    KEY_BITS,
  );
  derivedKey = await crypto.subtle.importKey(
    "raw",
    bits,
    ALGORITHM,
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a plaintext string. Returns base64(iv || ciphertext). */
export async function encrypt(plaintext: string): Promise<string> {
  if (!derivedKey) throw new Error("Database encryption key is not initialized.");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BITS / 8));
  const encoded = ENCODER.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    derivedKey,
    encoded,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64(iv || ciphertext) string. Returns null when the value is
 * empty or decryption fails (e.g. wrong key).
 */
export async function decrypt(
  ciphertext: string | null,
): Promise<string | null> {
  if (!ciphertext) return null;
  if (!derivedKey) throw new Error("Database encryption key is not initialized.");
  let combined: Uint8Array;
  try {
    combined = new Uint8Array(
      atob(ciphertext).split("").map((c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
  if (combined.length < IV_BITS / 8 + 1) return null;
  const iv = combined.slice(0, IV_BITS / 8);
  const body = combined.slice(IV_BITS / 8);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      derivedKey,
      body,
    );
    return DECODER.decode(plain);
  } catch {
    return null;
  }
}

export function isEnabled(): boolean {
  return derivedKey !== null;
}
