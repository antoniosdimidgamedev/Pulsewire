# Home

Welcome to the Pulsewire wiki.

Pulsewire is an original, self-hosted team messaging app with a keyboard-driven
terminal interface, a SQLite database, and a browser-based management dashboard.
Conversations, membership, messages, read state, and search all live on the
server; the clients are only consumers of the versioned REST API under `/v1`.

## What ships

- **Pulsewire server** — REST API at `/v1`, SQLite persistence, account sessions,
  authorization checks, and an append-only event log.
- **Terminal client** — Keyboard-driven TUI plus non-interactive commands
  (register, login, conversations, history, send, search, profile).
- **Management dashboard** — Browser-based admin panel at `/admin` for accounts,
  conversations, moderation, and activity review.
- **Android client** — Native Kotlin/Jetpack Compose app for Android 8.0+.
- **Offline demo** — Local sandbox for trying the interface without a server.

## Platforms

See [Server Setup](Server-Setup.md) to get the server running, then
[LAN Deployment](LAN-Deployment.md) to reach it from other devices on your
network. The [Android Client](Android-Client.md) page covers the native mobile
app.
