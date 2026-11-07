# Security

Pulsewire is designed for self-hosted, trusted-LAN use. Understand the security
boundary before exposing it beyond your local network.

## Authentication

- Passwords are hashed with PBKDF2-HMAC-SHA-256, a random per-user salt, and
  210,000 iterations by default. Plaintext passwords are never stored.
- Sign-in creates a random 256-bit session token. Only its SHA-256 hash is
  stored, with a 30-day default expiry.
- The terminal client stores the raw token in a `0600` file; the dashboard keeps
  it in `sessionStorage` for the current tab; the Android app encrypts it with
  an AES/GCM key held by the Android Keystore.

## At-rest database encryption

Stock SQLite does **not** encrypt database files (`PRAGMA key` is a no-op
without SQLCipher). Pulsewire therefore offers application-layer encryption:

- Set `PULSEWIRE_DB_KEY` to a passphrase. Message bodies are encrypted with
  AES-256-GCM before being written and decrypted after being read.
- Passwords and session tokens are already hashed (never plaintext).
- Losing `PULSEWIRE_DB_KEY` means the encrypted message bodies cannot be
  recovered. Back up the `.db` file and the key together.

For full-disk protection, encrypt the data directory at the filesystem level
(LUKS, fscrypt, BitLocker, FileVault) or build with SQLCipher.

## Transport security

- Cleartext HTTP is permitted deliberately for trusted LANs only.
- Anyone on the LAN can observe session tokens and message traffic over plain
  HTTP.
- Use HTTPS via a reverse proxy for any network you do not control.
- Do not expose the plain HTTP server directly to the internet.
- The Android app validates normal system-trusted TLS certificates but does not
  implement certificate pinning.

## Authorization

- Identity always comes from the bearer token; routes resolve the caller before
  reading a resource.
- Non-members receive `404` for conversations and messages they cannot see,
  avoiding existence disclosure.
- Only message authors may edit or delete their own messages. Only a group
  owner may remove other members.
- Search, history, and the event feed are filtered by current membership.
- Administrator routes require the `is_admin` flag. The last administrator
  cannot be demoted.

## Logging

Request logging records method, path, and status only. Passwords, bearer
tokens, query strings, and message bodies are never logged.

## Login rate limiting

In-memory limit: 10 failures per handle per 5 minutes. For internet-facing
deployments, also rate-limit at the reverse proxy.

## Dashboard

The dashboard is served same-origin at `/admin` with a strict Content Security
Policy (`script-src 'self'`, `frame-ancestors 'none'`). Server data is rendered
as text nodes, not HTML injection.

## Android

- Session token encrypted with Android Keystore AES/GCM; server URL in plain
  preferences; backups disabled.
- No push notifications, background sync, certificate pinning, or custom CA
  configuration.
- Cleartext HTTP for trusted LANs only.
