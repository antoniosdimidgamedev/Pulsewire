# Pulsewire

Pulsewire is an original, self-hosted team messaging app with a keyboard-driven terminal client, a
real HTTP backend, a SQLite database, and a browser-based management dashboard. Conversations,
membership, messages, read state, and search all live on the server; the terminal is only a client.

The current deliverable is the **Linux terminal client**, the **self-hosted server**, the
**management dashboard**, and a **native Android client**. The same TypeScript client also compiles
into a Windows executable, but Windows remains a build target rather than a separately supported
client for this milestone.

What ships in this repository:

- **Pulsewire server** (default): a REST API at `/v1`, SQLite persistence, account sessions, and
  authorization checks. It is the normal way to use Pulsewire.
- **Management dashboard** (`/admin`): an original HTML, CSS, and JavaScript control panel served by
  the same server for accounts, conversations, moderation, and activity review.
- **Android client** (`android/`): a native Kotlin/Jetpack Compose app for Android 8.0 (API 26) and
  newer. It signs in to your server, lists conversations, pages through history, sends and edits
  messages, searches, manages membership, and updates your profile.
- **Offline demo** (`--demo`): a clearly labelled local sandbox that contacts nothing unless you
  enable its optional local AI replies. It is for trying the interface, not for online messaging.
- **Google Chat** (`--provider googlechat`): the original optional integration. It is kept for
  existing users but is not required to use Pulsewire.

Pulsewire is not affiliated with Google. It does not use Google Chat branding, logos, or assets.

## What works today

- Account registration, sign-in, sign-out, session expiry, and profile updates.
- Direct messages and group conversations.
- Reliable message ordering, cursor-based history pagination, edit, delete, reply threads,
  timestamps, and delivery/read indicators.
- Membership management: invite, remove, leave, and automatic ownership transfer in groups.
- Per-user unread counts and read state.
- Server-side message search scoped to conversations you belong to.
- A terminal UI with a conversation list, message timeline, search, threads, unread badges, help,
  ASCII mode, colour modes, and small-terminal layouts.
- A management dashboard with a server overview, account administration, conversation inspection,
  moderation controls, activity review, loading/empty/error states, and a responsive layout.
- A native Android client with authentication, conversation list, message history, send/edit/delete,
  search, read state, membership management, profile editing, and Keystore-backed session storage.
- Non-interactive commands for scripts and remote shells.
- Automated tests for persistence, authorization, HTTP behaviour, the network provider, dashboard
  admin rules and assets, CLI commands, and the Android API client.

## Architecture at a glance

```
Terminal UI / commands ─┐
Management dashboard ───┼── JSON over HTTP (/v1, /admin) ──┐
Android client ─────────┘                                   │
                                                            ▼
                                        ┌──────────────────────────────┐
                                        │ HTTP API + admin routes      │
                                        ├──────────────────────────────┤
                                        │ Messaging store              │
                                        ├──────────────────────────────┤
                                        │ SQLite                       │
                                        └──────────────────────────────┘
```

The terminal UI never talks to SQLite or HTTP directly. It uses the same `ChatProvider` interface as
the offline demo, so rendering, keyboard handling, and search behaviour are shared. The dashboard
and Android client are separate consumers of the same `/v1` contract. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the layering, data model, authorization rules,
and event strategy.

## Requirements

- [Deno](https://deno.com/) 2.x. No `npm install`, bundler, or external database server is needed.
- Linux or macOS for the primary terminal experience. SQLite comes from Deno's built-in
  `node:sqlite`.
- For the Android client: JDK 17 and Android SDK platform 35 with build-tools 35.0.0, or Android
  Studio. The Gradle wrapper is included.

## Quick start

### 1. Start the server

```sh
deno task server
```

Defaults:

- API: `http://127.0.0.1:8787`
- Database: your data directory + `pulsewire.db`
- Bind address: loopback only

Use a separate data directory and port for experiments:

```sh
deno task server --data-dir /tmp/pulsewire-server --port 8799
```

You should see `Pulsewire server listening on http://127.0.0.1:8799`.

### 2. Create two accounts

Each local account keeps its own session token. On the same machine, give each simulated user a
separate `--data-dir`:

```sh
# Terminal 2
deno task start register alice --name "Alice" --server http://127.0.0.1:8799 \
  --data-dir /tmp/pulsewire-alice

# Terminal 3
deno task start register bob --name "Bob" --server http://127.0.0.1:8799 \
  --data-dir /tmp/pulsewire-bob
```

You will be prompted for a password of at least 10 characters. In scripts, pipe one line and add
`--password-stdin`:

```sh
printf '%s\n' "$PULSEWIRE_PASSWORD" |
  deno task start register alice --name "Alice" --password-stdin \
    --server http://127.0.0.1:8799 --data-dir /tmp/pulsewire-alice
```

### 3. Create a conversation and send a message

```sh
# Alice creates a group with Bob
deno task start new-group "Release" bob --server http://127.0.0.1:8799 \
  --data-dir /tmp/pulsewire-alice

# Alice sends using the conversation id or name
deno task start send Release "Ship it tomorrow" --server http://127.0.0.1:8799 \
  --data-dir /tmp/pulsewire-alice

# Bob reads it
deno task start conversations --server http://127.0.0.1:8799 --data-dir /tmp/pulsewire-bob
deno task start history Release --server http://127.0.0.1:8799 --data-dir /tmp/pulsewire-bob
```

### 4. Open the terminal UI

```sh
deno task start --server http://127.0.0.1:8799 --data-dir /tmp/pulsewire-alice
```

The TUI reloads new messages by polling the server's event log (every 1.5 seconds by default).
Delivery ticks update when other members mark a conversation read.

### 5. Open the management dashboard

With the server running, visit:

```text
http://127.0.0.1:8799/admin
```

Sign in with an administrator account. The **first account registered on a fresh database becomes an
administrator**; in the quick start above, that is `alice`. The dashboard can:

- show server counts and recent activity;
- search accounts, promote or remove administrators, and never remove the last administrator;
- inspect conversations and their latest messages;
- delete a conversation or an individual message;
- review the append-only event log with type filters.

The dashboard is served by the same process as the API. It uses only same-origin requests and a
strict Content Security Policy, stores its session token in `sessionStorage` (cleared when the tab
closes), and is not a separate service. It is a browser interface, not a replacement for the
terminal client.

To promote an existing account at startup, set the handle before starting the server:

```sh
PULSEWIRE_ADMIN_HANDLE=alice deno task server
```

If no administrator exists, the oldest account is promoted automatically at startup. The server does
not start if `PULSEWIRE_ADMIN_HANDLE` names an account that does not exist.

### 6. Use the Android app on your LAN

Bind the server to a private interface so a phone can reach it:

```sh
deno task server --host 0.0.0.0 --port 8787
```

Find the computer's LAN address with `hostname -I`, allow port `8787` through the host firewall, and
confirm `http://<LAN-IP>:8787/health` opens from the phone's browser. Then build and install the
client:

```sh
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Enter `http://<LAN-IP>:8787` in the app. The Android Studio emulator can use `http://10.0.2.2:8787`
instead. Plain HTTP is allowed for trusted LANs only; use HTTPS for any network you do not control.
See [`android/README.md`](android/README.md) for build requirements, first-run steps, and the
verified scope.

For the offline demo instead:

```sh
deno task dev
# or
deno task start --demo
```

## Commands

### Server

```sh
deno task server
deno task server --host 127.0.0.1 --port 8787 --db /path/to/pulsewire.db
```

Do not expose the plain HTTP server directly to the internet. Put it behind a TLS reverse proxy and
use an `https://` server URL.

### Accounts

```sh
pulsewire register <handle> --name "Display Name"
pulsewire login <handle>
pulsewire logout
pulsewire whoami
pulsewire profile --name "New Name"
pulsewire profile --handle new_handle
```

`pulsewire` commands are normally run through Deno in development:

```sh
deno task start login alice --server http://127.0.0.1:8787
```

Options that apply to every server command:

| Option             | Meaning                                           |
| ------------------ | ------------------------------------------------- |
| `--server <url>`   | Server base URL (default `http://127.0.0.1:8787`) |
| `--config <file>`  | Use a specific `config.json`                      |
| `--data-dir <dir>` | Override the local data/session directory         |
| `--password-stdin` | Read exactly one password line from stdin         |

### Messaging

```sh
pulsewire conversations
pulsewire history <conversation> [--limit 50] [--before <seq>]
pulsewire send <conversation> <message...> [--reply-to <message-id>]
pulsewire search <query...>
pulsewire new-dm <handle>
pulsewire new-group <name> <handle...>
pulsewire members <conversation>
pulsewire invite <conversation> <handle>
pulsewire remove-member <conversation> <handle-or-user-id>
pulsewire leave <conversation>
pulsewire read <conversation>
```

A `<conversation>` may be an id (`c_...`), an exact name, a unique name prefix, or `#name`. `new-dm`
and `invite` accept handles with or without `@`.

`history` prints message ids so they can be used with `--reply-to`. When it reports older messages,
continue with `--before <nextBefore>`.

### Terminal UI shortcuts

| Key                 | Action                                |
| ------------------- | ------------------------------------- |
| `Tab` / `Shift+Tab` | Move focus between panes              |
| `↑` / `↓`           | Navigate conversations or messages    |
| `Enter`             | Open a conversation or send a message |
| `Esc`               | Go back / cancel                      |
| `r`                 | Reply in a thread                     |
| `t`                 | Open the focused thread               |
| `e`                 | Edit your own message                 |
| `d`                 | Delete your own message               |
| `s` or `/`          | Search messages                       |
| `g` / `G`           | Jump to top / bottom                  |
| `[` / `]`           | Previous / next conversation          |
| `?` or `F1`         | Help overlay                          |
| `Ctrl+C`            | Quit                                  |

The renderer adapts to narrow terminals by showing one pane at a time; use `Tab` to switch.

## Configuration

Configuration is optional. `config.example.json` contains placeholders and safe local defaults. Copy
it to your platform's config location (usually `~/.config/pulsewire/config.json` on Linux) and edit
it, or use environment variables.

```json
{
  "provider": "server",
  "displayName": "Your Name",
  "server": {
    "baseUrl": "http://127.0.0.1:8787",
    "pollIntervalMs": 1500,
    "requestTimeoutMs": 15000
  }
}
```

Configuration precedence is: command-line flag, environment variable, config file, built-in default.
`--print-config` shows the resolved configuration with secrets and tokens redacted.

### Client environment variables

| Variable                      | Purpose                                     |
| ----------------------------- | ------------------------------------------- |
| `PULSEWIRE_CONFIG`            | Config file path                            |
| `PULSEWIRE_PROVIDER`          | `server` (default), `demo`, or `googlechat` |
| `PULSEWIRE_DISPLAY_NAME`      | Default display name for registration       |
| `PULSEWIRE_DATA_DIR`          | Local data and session directory            |
| `PULSEWIRE_SERVER_URL`        | Server base URL                             |
| `PULSEWIRE_SERVER_POLL_MS`    | Event poll interval (100–60000 ms)          |
| `PULSEWIRE_SERVER_TIMEOUT_MS` | Request timeout (500–120000 ms)             |
| `PULSEWIRE_COLOR`             | `auto`, `truecolor`, `ansi256`, `none`      |
| `PULSEWIRE_ASCII`             | Use ASCII glyphs                            |
| `NO_COLOR`                    | Disable colour unless explicitly configured |

### Server environment variables

| Variable                      | Default                  | Purpose                                         |
| ----------------------------- | ------------------------ | ----------------------------------------------- |
| `PULSEWIRE_SERVER_HOST`       | `127.0.0.1`              | Bind address                                    |
| `PULSEWIRE_SERVER_PORT`       | `8787`                   | Bind port                                       |
| `PULSEWIRE_SERVER_DB`         | `<dataDir>/pulsewire.db` | SQLite database path                            |
| `PULSEWIRE_SESSION_TTL_DAYS`  | `30`                     | Session lifetime (1–365)                        |
| `PULSEWIRE_PBKDF2_ITERATIONS` | `210000`                 | Password derivation work factor (10000–2000000) |
| `PULSEWIRE_ADMIN_HANDLE`      | unset                    | Promote an existing account to administrator    |

Required settings are validated at startup; invalid ports, paths, iteration counts, or client URLs
produce an error instead of a half-configured process. The server does not need a secret key file:
session tokens are random and only their hashes are stored.

The sample config contains no real credentials. Do not commit `.env`, local configs, SQLite files,
or session tokens; the repository `.gitignore` already excludes them.

## Data and privacy

- The server stores accounts, password hashes, conversations, memberships, messages, and an
  append-only event log in SQLite.
- Passwords use PBKDF2-HMAC-SHA-256 with a per-user random salt and 210,000 iterations by default.
  Plaintext passwords are never stored or logged.
- Session tokens are 256-bit random values. The server stores only their SHA-256 hashes, and the
  client stores the raw token in a `0600` file inside the data directory. The dashboard keeps its
  token in `sessionStorage` for the current browser tab only.
- The dashboard is served by the same origin as the API, uses a strict Content Security Policy
  (`script-src 'self'`, `frame-ancestors 'none'`), and renders all server data with DOM text nodes
  rather than injecting HTML.
- Non-members receive `404` for conversations they cannot access, so existence is not disclosed.
  Only the author can edit or delete a message. Only a group owner can remove other members.
  Administrator moderation can delete conversations and messages; every admin route checks the
  administrator flag on the authenticated account.
- Search and the event feed are filtered by current membership. The dashboard's admin views are
  separate routes under `/v1/admin/*` and are never available to non-administrators.
- Request logging records method, path, and status only. Passwords, bearer tokens, query strings,
  and message bodies are not logged.
- The API includes an in-memory login rate limit (10 failures per handle per 5 minutes). For an
  internet-facing deployment, also rate-limit at the reverse proxy.
- The offline demo never contacts the network unless local AI replies are enabled, in which case it
  only calls the configured local model endpoint.

For production, terminate TLS at a reverse proxy, bind the server to a private interface, back up
the SQLite file (including WAL sidecars), and restrict access to the data directory.

## HTTP API

The API is versioned under `/v1` and is consumed by the terminal client, the dashboard, and the
native Android client. The main groups are:

- `/v1/auth/*` — register, login, logout
- `/v1/me` — current profile and profile updates
- `/v1/users` — look up people by handle or name
- `/v1/conversations/*` — list, create, messages, members, read state, leave
- `/v1/messages/*` — edit, delete, thread
- `/v1/search` — search messages you can read
- `/v1/events`, `/v1/events/head` — append-only change feed
- `/v1/admin/*` — administrator overview, accounts, conversations, moderation, activity
- `/admin` — dashboard HTML, CSS, and JavaScript assets (same process)
- `/health` — unauthenticated liveness check

Interactive API documentation with `curl` examples is in [`docs/API.md`](docs/API.md). The dashboard
is documented there too, including each `/v1/admin/*` route and its authorization rules.

## Development

```sh
deno task fmt        # format
deno task lint       # lint
deno task check      # type-check source, scripts, tests
deno task test       # run all tests
make verify          # run fmt:check, lint, check, and test
```

Run a single test file:

```sh
deno test --allow-read --allow-write --allow-env --allow-sys --allow-net \
  tests/server_test.ts
```

Useful platform targets:

```sh
make build-linux     # dist/pulsewire-linux
make build-windows   # dist/pulsewire.exe (compiles; Windows is not a supported milestone yet)
```

Android checks use the committed Gradle wrapper:

```sh
make android-build   # debug APK
make android-check   # lint and JVM unit tests
```

The compile tasks include `web/admin` via `--include web`, so a compiled binary can serve the
dashboard without the repository checkout. `deno task fmt` and `deno task fmt:check` also cover the
dashboard files.

## Windows and Android

The supported clients are the Linux terminal and the native Android app. The service boundary is the
`/v1` REST API, so clients do not need to change the database or messaging rules.

- **Windows CLI**: the shared TypeScript client can already be compiled with `deno compile`, and
  existing CI runs the test suite on Windows. A separately supported Windows client, packaging, and
  end-to-end verification are future work.
- **Android**: implemented in [`android/`](android/README.md) with Kotlin and Jetpack Compose. It
  covers authentication, conversations, history, send/edit/delete, search, read state, membership,
  and profile editing, with Keystore-backed token storage. It has been compiled and unit-tested, but
  runtime behavior has not been verified on a device or emulator in this repository's build
  environment.

See [`docs/PLATFORMS.md`](docs/PLATFORMS.md) for the supported scope and security limits. A
Windows-specific client is not claimed as implemented.

## Repository layout

```
android/         Native Android client (Kotlin, Jetpack Compose)
src/
  chat/          ChatProvider contract, demo, Google Chat, network provider
  client/        HTTP client, session storage, password prompt, CLI commands
  google/        Optional legacy Google Chat integration
  protocol/      Shared JSON response types
  server/        HTTP API, authorization, store, SQLite schema, dashboard assets
  ui/            Terminal rendering, input, layout, theme
  cli.ts         Argument parsing and help
  config.ts      Configuration loading and validation
  main.ts        Command dispatch
web/
  admin/         Management dashboard (index.html, styles.css, app.js)
docs/            API, architecture, and platform notes
tests/           Unit, integration, HTTP, provider, and CLI tests
```

## License

See [`LICENSE`](LICENSE).
