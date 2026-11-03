# Pulsewire

Pulsewire is a terminal team-chat client for Linux and Windows. It has the familiar shape of a
modern team chat app — conversations on the left, a message timeline, threads, search, and a
composer — but it runs entirely in your terminal.

Two providers ship in the box:

- **Local demo** (default): a persistent, clearly labelled demo workspace that never contacts the
  network and needs no credentials.
- **Google Chat** (optional): a real client for the Google Chat REST API using your own Google
  Workspace account and OAuth client.

The demo workspace is not connected to Google Chat. No demo message is ever sent anywhere.

## Highlights

- Direct messages, group chats, and spaces in one conversation list
- Unread badges, last-message previews, relative timestamps, and day dividers
- Send, edit, delete, reply in threads, and open a focused thread view
- Search across loaded messages, authors, and conversation names
- Keyboard-first navigation with a help overlay and narrow-terminal mode
- Loading, empty, and error states that stay inside the frame
- Unicode box drawing and an optional ASCII-only mode
- Truecolor, 256-color, and no-color output, plus `NO_COLOR` support
- Zero runtime npm dependencies; one `deno compile` binary per platform

## Requirements

- [Deno](https://deno.com/) 2.x for running from source (the project is developed and tested with
  current Deno 2 releases)
- Windows 10/11 or a modern Linux distribution
- An interactive terminal (stdin and stdout must be a TTY)

Compiled binaries do not need Deno installed.

## Install and run

```sh
git clone https://github.com/antoniosdimidgamedev/Google-Chat-Clone-CLI.git pulsewire
cd pulsewire
deno task start        # start the TUI with the local demo workspace
```

You can also use the launchers:

```sh
make run               # Linux/macOS (or Windows with GNU make)
./run.sh               # Linux/macOS
run.cmd                # Windows
```

`make` with no target lists every shortcut. `make verify` runs the same format, lint, type-check,
and test steps as CI.

Useful tasks:

| Task                | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `deno task start`   | Run the TUI with your resolved configuration   |
| `deno task dev`     | Force the local demo provider                  |
| `deno task test`    | Run the test suite                             |
| `deno task check`   | Type-check source, preview script, and tests   |
| `deno task lint`    | Lint source, tests, and scripts                |
| `deno task fmt`     | Format the project                             |
| `deno task preview` | Print a static preview without opening the TUI |

The `Makefile` wraps the most useful tasks:

| Target                    | What it does                                |
| ------------------------- | ------------------------------------------- |
| `make run` / `make start` | Start the TUI                               |
| `make dev`                | Start the local demo provider               |
| `make preview`            | Print a static preview                      |
| `make test`               | Run the test suite                          |
| `make verify`             | Run formatting, lint, type-check, and tests |
| `make build`              | Build both Linux and Windows binaries       |
| `make clean`              | Remove `dist/`                              |

### Build a standalone binary

```sh
deno task compile:linux     # dist/pulsewire-linux
deno task compile:windows   # dist/pulsewire.exe
```

The compile tasks target the standard x86_64 GNU/Linux and Windows MSVC builds. `deno compile` can
cross-compile from Linux to Windows. Copy the resulting file to the target machine; no Deno
installation is required there.

## Quick start

1. Run `deno task start`.
2. Use `Tab` or the arrow keys to move around, `Enter` to open a conversation or send a message, and
   `?` for the full shortcut list.
3. Press `Ctrl+C` to quit.

The first run seeds the Juniper Studio demo workspace under your local data directory. Sending a
message in the demo may produce a simulated reply after a short delay. Disable this with
`"simulateActivity": false` or `PULSEWIRE_SIMULATE_ACTIVITY=false`.

To wipe the demo and start over:

```sh
deno run --allow-read --allow-write --allow-env --allow-sys src/main.ts --reset-demo
# or, non-interactively:
deno run --allow-read --allow-write --allow-env --allow-sys src/main.ts --reset-demo --yes
```

## Keyboard shortcuts

| Keys                  | Action                                                  |
| --------------------- | ------------------------------------------------------- |
| `Tab` / `Shift+Tab`   | Cycle focus: conversations → messages → composer        |
| `↑` / `↓`             | Move through conversations or messages                  |
| `PageUp` / `PageDown` | Scroll the timeline                                     |
| `g` / `G`             | Jump to the first or last message                       |
| `Enter`               | Open a conversation, send, or save an edit              |
| `Esc`                 | Close an overlay, cancel an edit, or leave the composer |
| `r`                   | Reply to the selected message in its thread             |
| `t`                   | Open the focused thread view                            |
| `e`                   | Edit your selected message                              |
| `d`                   | Delete your selected message                            |
| `s` or `/`            | Search loaded messages                                  |
| `[` / `]`             | Previous / next conversation                            |
| `?` or `F1`           | Help overlay                                            |
| `Ctrl+C`              | Quit                                                    |
| `q`                   | Quit when the composer is not focused                   |

In narrow terminals (under 72 columns) Pulsewire shows one pane at a time. Switch to the
conversation list with `Tab` or `Shift+Tab`.

## Configuration

Pulsewire reads JSON from a platform-appropriate location:

| Platform | Config file                                           | Data directory                            |
| -------- | ----------------------------------------------------- | ----------------------------------------- |
| Linux    | `~/.config/pulsewire/config.json`                     | `~/.local/share/pulsewire`                |
| macOS    | `~/Library/Application Support/Pulsewire/config.json` | `~/Library/Application Support/Pulsewire` |
| Windows  | `%APPDATA%\Pulsewire\config.json`                     | `%LOCALAPPDATA%\Pulsewire`                |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are respected on Linux; `APPDATA` and `LOCALAPPDATA` are
respected on Windows.

Start from [`config.example.json`](config.example.json):

```json
{
  "provider": "demo",
  "displayName": "Ada",
  "simulateActivity": true,
  "ascii": false,
  "color": "auto",
  "demo": {
    "connectDelayMs": 450,
    "replyDelayMs": 1800,
    "ambientIntervalMs": 75000
  }
}
```

| Key                      | Values                                 | Meaning                             |
| ------------------------ | -------------------------------------- | ----------------------------------- |
| `provider`               | `demo`, `googlechat`                   | Which chat service to use           |
| `displayName`            | string, max 40 characters              | Name used in the demo workspace     |
| `dataDir`                | path                                   | Override the data directory         |
| `simulateActivity`       | boolean                                | Demo replies and ambient messages   |
| `ascii`                  | boolean                                | Use ASCII instead of Unicode glyphs |
| `color`                  | `auto`, `truecolor`, `ansi256`, `none` | Terminal color mode                 |
| `demo.connectDelayMs`    | non-negative integer                   | Simulated connection delay          |
| `demo.replyDelayMs`      | non-negative integer                   | Delay before a simulated demo reply |
| `demo.ambientIntervalMs` | non-negative integer                   | Background demo activity interval   |

Environment variables override the config file, and command-line flags override both:

| Variable                             | Purpose                     |
| ------------------------------------ | --------------------------- |
| `PULSEWIRE_CONFIG`                   | Path to `config.json`       |
| `PULSEWIRE_PROVIDER`                 | `demo` or `googlechat`      |
| `PULSEWIRE_DISPLAY_NAME`             | Demo display name           |
| `PULSEWIRE_DATA_DIR`                 | Data directory              |
| `PULSEWIRE_COLOR`                    | Color mode                  |
| `PULSEWIRE_ASCII`                    | `true`/`false`              |
| `PULSEWIRE_SIMULATE_ACTIVITY`        | `true`/`false`              |
| `PULSEWIRE_DEMO_CONNECT_DELAY_MS`    | Demo connection delay       |
| `PULSEWIRE_DEMO_REPLY_DELAY_MS`      | Demo reply delay            |
| `PULSEWIRE_DEMO_AMBIENT_INTERVAL_MS` | Demo ambient interval       |
| `NO_COLOR`                           | Disable auto color when set |

Inspect the fully resolved configuration without revealing secrets:

```sh
deno run --allow-read --allow-write --allow-env --allow-sys src/main.ts --print-config
```

### Keeping secrets safe

- Do not put client secrets or tokens in a tracked config file.
- Prefer environment variables or a credentials file outside the repository.
- The OAuth token cache is written with restrictive permissions where the platform supports it (mode
  `0600` on Linux).
- `.env`, local config files, token caches, and build output are ignored by Git.

## Google Chat setup

Google Chat support is optional. It requires:

1. A Google Workspace account with access to Google Chat
2. A Google Cloud project with the **Google Chat API** enabled
3. An OAuth **Desktop app** client

Google's setup for a user-auth desktop client:

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Chat API** under _APIs & Services → Library_.
3. Configure the OAuth consent screen. Add yourself as a test user if the app is still in testing
   mode.
4. Create credentials of type **OAuth client ID → Desktop app**.
5. Download the client JSON. Store it outside the repository, for example at
   `~/.config/pulsewire/google-client.json`, and restrict its permissions.
6. Point Pulsewire at it and sign in:

Linux/macOS:

```sh
export GOOGLE_CHAT_CREDENTIALS_FILE="$HOME/.config/pulsewire/google-client.json"
deno run --allow-read --allow-write --allow-env --allow-sys --allow-net --allow-run \
  src/main.ts auth google
```

Windows PowerShell:

```powershell
$env:GOOGLE_CHAT_CREDENTIALS_FILE = "$env:APPDATA\Pulsewire\google-client.json"
deno run --allow-read --allow-write --allow-env --allow-sys --allow-net --allow-run `
  src/main.ts auth google
```

The command starts a loopback OAuth flow, opens the consent page when possible, and prints the URL
otherwise. Use `--no-browser` on headless machines. The refresh token is cached at:

- Linux/macOS: `<dataDir>/googlechat-token.json`
- Windows: `%LOCALAPPDATA%\Pulsewire\googlechat-token.json`

Then enable the provider:

```json
{ "provider": "googlechat" }
```

or run:

```sh
deno run --allow-read --allow-write --allow-env --allow-sys --allow-net \
  src/main.ts --provider googlechat
```

Check the signed-in account at any time:

```sh
deno run --allow-read --allow-write --allow-env --allow-sys --allow-net \
  src/main.ts auth status
```

### Google Chat environment variables

| Variable                       | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `GOOGLE_CHAT_CREDENTIALS_FILE` | Path to a Desktop app OAuth client JSON                     |
| `GOOGLE_CHAT_CLIENT_ID`        | OAuth client ID (alternative to the file)                   |
| `GOOGLE_CHAT_CLIENT_SECRET`    | OAuth client secret (alternative to the file)               |
| `GOOGLE_CHAT_TOKEN_FILE`       | Override the refresh-token cache path                       |
| `GOOGLE_CHAT_ACCESS_TOKEN`     | Use a short-lived access token instead of interactive login |
| `GOOGLE_CHAT_USER_RESOURCE`    | Override the user resource, e.g. `users/12345`              |
| `GOOGLE_CHAT_POLL_INTERVAL_MS` | Polling interval in milliseconds (default `20000`)          |
| `GOOGLE_CHAT_MAX_SPACES`       | Maximum spaces to load (1–100, default `30`)                |

Requested scopes: `openid`, `email`, `profile`, `chat.spaces.readonly`, `chat.messages`,
`chat.memberships.readonly`, and `chat.users.readstate`.

### Honest Google Chat limitations

These come from Google's public API, not from Pulsewire:

- **No push channel for desktop user auth.** New messages are received by polling every
  `GOOGLE_CHAT_POLL_INTERVAL_MS`.
- **No full-text search endpoint.** Search covers messages already loaded in this session.
- **No typing indicators.** Google Chat does not expose them to this API.
- **Threads are limited to named spaces.** Direct messages and group chats do not support threaded
  replies.
- **Read state depends on the `chat.users.readstate` scope.** If Google denies it, Pulsewire falls
  back to local read state.

The network client maps HTTP failures to clear messages: `401` asks you to sign in again, `403`
means the account or scope is not permitted, `404` means the space or message is gone, and `429`
asks you to wait before retrying.

## Architecture

```
src/
  main.ts              CLI entry point and command handling
  cli.ts               Pure argument parsing and help text
  config.ts            Config discovery, validation, and safe printing
  storage.ts           Atomic, permission-restricted file writes
  chat/
    types.ts           Provider interface and domain types
    errors.ts          ChatError codes and message helpers
    factory.ts         Provider/session selection
    demo-provider.ts   Local demo transport and persistence
    demo-data.ts       Deterministic demo seed and validation
  google/
    settings.ts        Google env/path settings and scopes
    oauth.ts           Loopback OAuth, token refresh, token storage
    api.ts             Google Chat REST client
    provider.ts        ChatProvider implementation over the REST client
  ui/
    app.ts             State machine, key handling, provider events
    render.ts          Pure frame and timeline renderer
    keys.ts            Stateful key/escape/bracketed-paste parser
    terminal.ts        Raw-mode terminal wrapper and resize handling
    text.ts            ANSI-aware width, wrapping, and truncation
    theme.ts           Glyphs, colors, and layout tokens
scripts/preview.ts     Static preview renderer
tests/                 Unit and integration tests with mocked transports
```

The renderer is pure: given a `UiState` and a viewport it returns exactly `height` lines. The app
controller owns state transitions, and providers only implement the `ChatProvider` interface. That
separation is what lets the demo and Google providers share the same UI without either one leaking
transport details into rendering.

## Testing

```sh
deno task fmt:check
deno task lint
deno task check
deno task test
```

The suite covers:

- Linux, macOS, and Windows path resolution and config precedence
- ANSI-aware text measurement, wrapping, and truncation
- Key parsing, including split escape sequences and bracketed paste
- Frame layout at wide, narrow, and tiny terminal sizes
- ASCII and color rendering parity
- Demo persistence, ownership rules, threads, search, and read state
- Google settings, OAuth token loading/refresh, REST error mapping, and provider behavior against a
  mocked Google Chat API
- CLI parsing and the demo reset flow

All network access in the tests is mocked. The Google tests never call Google.

### Linux and Windows notes

Pulsewire avoids platform-specific shell assumptions at runtime. The only platform branches are:

- Config/data paths (`XDG_*` on Linux, `APPDATA`/`LOCALAPPDATA` on Windows)
- Atomic file replacement, which retries after a delete on Windows
- Opening the OAuth consent page (`xdg-open`, `open`, or `cmd /c start`)

Both platforms are covered by the path and storage tests. The CI workflow runs formatting, linting,
type checking, and the test suite on Linux and Windows.

## Troubleshooting

- **"needs an interactive terminal"** — run Pulsewire directly in a terminal window, not through a
  pipe or a non-interactive runner.
- **Garbled box drawing on Windows** — use Windows Terminal or another modern terminal, or pass
  `--ascii`.
- **No colors** — check `NO_COLOR`, `TERM=dumb`, and the `color` setting. `--print-config` shows the
  resolved mode.
- **Google sign-in fails** — confirm the Chat API is enabled, the OAuth client is a Desktop app, and
  your account is a test user if the consent screen is in testing mode.
- **Demo data is corrupt** — Pulsewire reports the path and suggests `--reset-demo`; run it with
  `--yes` to replace the file.
- **Config file not found** — missing files simply use defaults. Use `--print-config` to see the
  exact path Pulsewire checked.

## License

MIT. See [`LICENSE`](LICENSE).
