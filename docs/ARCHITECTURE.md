# Pulsewire architecture

Pulsewire is split into a terminal client, a server, a browser dashboard, and a native Android
client. The clients share one contract: the versioned REST API under `/v1`. Nothing in the interface
layer reads SQLite or builds HTTP requests directly, so the rendering and keyboard code is
independent of persistence and transport.

## Layers

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ Terminal UI and commands    │   │ Management dashboard        │
│ src/ui, src/cli.ts          │   │ web/admin (HTML/CSS/JS)     │
└──────────────┬──────────────┘   └──────────────┬──────────────┘
               │ ChatProvider                     │ JSON over HTTP
┌──────────────▼──────────────┐                  │
│ Network provider and client │                  │
│ src/chat/server-provider.ts │                  │
│ src/client                  │                  │
└──────────────┬──────────────┘                  │
               └────────────────┬────────────────┘
                                │ Bearer token
┌───────────────────────────────▼───────────────────────────────┐
│ HTTP routing, authentication, authorization                    │
│ src/server/http.ts, src/server/admin-assets.ts                 │
├────────────────────────────────────────────────────────────────┤
│ Messaging store: accounts, conversations, messages, events      │
│ src/server/store.ts, src/server/auth.ts, src/server/errors.ts   │
├────────────────────────────────────────────────────────────────┤
│ SQLite schema and migrations                                    │
│ src/server/db.ts                                                │
└────────────────────────────────────────────────────────────────┘

┌─────────────────────────────┐
│ Native Android client       │
│ android/ (Kotlin, Compose)  │
└──────────────┬──────────────┘
               │ OkHttp + JSON over HTTP, bearer token
               └──────────────► same /v1 contract
```

### Interface layer

- `src/ui/` contains terminal rendering, input handling, layout, themes, and the app loop.
- `src/cli.ts` parses arguments, help, and per-command options.
- `src/main.ts` dispatches commands and starts either the TUI, a non-interactive command, or the
  server.
- `web/admin/` is plain HTML, CSS, and JavaScript. It calls the same JSON API and never receives a
  database handle or a password.
- `android/app/src/main/java/dev/pulsewire/android/` is a Jetpack Compose app. `MainActivity.kt`
  owns navigation, `PulsewireViewModel.kt` owns screen state and polling, and `ui/` holds the auth,
  conversation, chat, member, search, and profile screens.

The terminal UI talks only to the `ChatProvider` interface in `src/chat/types.ts`. The demo provider
and the network provider implement the same operations, so rendering and keyboard handling are
shared. The dashboard deliberately does not reuse terminal components; it consumes the admin API
directly and renders server data with DOM text nodes. The Android client is a third, independent
consumer of `/v1`; it shares the contract but not the terminal rendering code.

### Network layer

- `src/chat/server-provider.ts` adapts the REST API to `ChatProvider`.
- `src/client/api.ts` is a typed HTTP client with timeouts and consistent error handling.
- `src/client/session.ts` stores a bearer token per server URL in `<dataDir>/session.json` with mode
  `0600`.
- `src/client/commands.ts` implements register, login, logout, whoami, profile, and the other
  non-interactive commands.
- `src/protocol/api.ts` holds the JSON types shared by the client, provider, and documentation.

The provider polls `/v1/events` (1.5 seconds by default) and applies incremental changes to the
in-memory conversation state. Because the event log is append-only and cursor-based, the same UI can
later switch to server-sent events or WebSockets without changing rendering or commands.

The Android client has its own OkHttp layer in `android/.../data/PulsewireApi.kt`. It normalizes the
server URL, sends the bearer token, parses the same JSON shapes, and maps failures to user-facing
messages without logging request bodies, tokens, or passwords. Its view model polls `/v1/events`
about every three seconds while the process is alive; it has no background sync or push support.

### Server layer

- `src/server/http.ts` routes requests, reads JSON bodies, applies the login rate limit, checks
  bearer tokens, enforces administrator access for `/v1/admin/*`, and returns consistent errors.
- `src/server/store.ts` owns every authorization decision and all persistence. It never trusts a
  client-supplied user ID for identity.
- `src/server/auth.ts` implements PBKDF2-HMAC-SHA-256 password hashing, random session tokens, and
  token hashing.
- `src/server/db.ts` opens SQLite, enables foreign keys and WAL, and applies migrations.
- `src/server/admin-assets.ts` serves the dashboard with a strict Content Security Policy.
- `src/server/main.ts` loads environment settings, opens the database, bootstraps an administrator,
  and starts the listener.

## Data model

SQLite is the source of truth. The schema is relational and small:

| Table           | Purpose                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `users`         | Account identity, display name, password hash, administrator flag                      |
| `sessions`      | SHA-256 token hashes, owner, expiry                                                    |
| `conversations` | Kind (`dm`, `group`, `space`), name, topic, creator, DM key                            |
| `memberships`   | User/conversation pairs, role, last-read sequence                                      |
| `messages`      | Author, body, timestamps, reply link, soft-delete timestamp, per-conversation sequence |
| `events`        | Append-only log of message, conversation, and read changes                             |

Every conversation has a monotonic message sequence. Read state is stored as a sequence cursor, so
unread counts do not require per-message read rows. Deleted messages remain as tombstones so history
and reply links stay stable.

Migrations use `PRAGMA user_version`. Version 1 creates the messaging schema; version 2 adds
`users.is_admin`. Startup upgrades an existing database in place and never drops messages.

## Authentication and authorization

- Passwords are hashed with PBKDF2-HMAC-SHA-256, a random per-user salt, and 210,000 iterations by
  default. Plaintext passwords are never stored.
- Successful registration and sign-in create a random 256-bit token. Only its SHA-256 hash is
  stored, with a 30-day default expiry.
- The terminal client stores the raw token in a `0600` file; the dashboard stores it in
  `sessionStorage` for the current tab.
- The Android client encrypts the token and cached profile with an AES/GCM key held by the Android
  Keystore. The server URL stays in plain preferences, and app backups are disabled so the encrypted
  session is not copied off-device by the backup system.
- Identity always comes from the bearer token. Routes resolve the caller before reading a resource.
- Non-members receive `404` for conversations and messages they cannot see, avoiding existence
  disclosure.
- Only authors may edit or delete their own messages. Only a group owner may remove other members.
- Search, history, and the event feed are filtered by current membership.
- Administrator routes require the account's `is_admin` flag. Demoting the last administrator is
  rejected with `409 conflict`.

Request logging records only method, path, and status. It never logs bodies, query strings,
passwords, or tokens.

## Real-time updates

The server writes an `events` row in the same transaction as each change. Clients ask for events
after a sequence cursor and receive only events in conversations they belong to. Admin deletions
that affect everyone emit a broadcast `conversation-updated` event with a null conversation ID,
which clients map to an empty conversation ID before refreshing their lists.

This design favours simplicity and durability over long-lived sockets. Polling is cheap for a small
team, survives reconnects without replay state, and leaves the transport replaceable.

## Management dashboard

The dashboard is an administrator-only interface served at `/admin`:

- Overview: account, admin, conversation, message, deleted-message, event, and 24-hour counts.
- Accounts: search, pagination, promote/demote. The last administrator cannot be removed.
- Conversations: search, pagination, message history with `before` pagination, and deletion.
- Activity: newest-first event feed with type filters and older-event pagination.

The assets are static and public so the sign-in page can load. All data routes under `/v1/admin/*`
require an administrator token. The page uses a strict Content Security Policy and renders server
values with `textContent`, not HTML injection.

## Boundaries for future clients

The API is the product boundary. The Android client already consumes `/v1` and implements its own
Keystore-backed token storage and foreground polling policy. A future Windows client should do the
same; neither should need schema changes or new messaging rules. See [`PLATFORMS.md`](PLATFORMS.md)
and [`../android/README.md`](../android/README.md).
