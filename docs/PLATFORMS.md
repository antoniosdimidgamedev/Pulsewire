# Platform notes

Pulsewire currently ships a Linux terminal client, a self-hosted server, and a browser dashboard.
Windows and Android are future targets. Nothing in this document claims that a separate Windows or
Android client is implemented.

## Supported today

| Platform | What is supported |
| --- | --- |
| Linux | Terminal client (TUI and non-interactive commands), server, dashboard in any modern browser |
| Any modern browser | Dashboard at `/admin`, served by the Pulsewire server |
| Windows | The test suite runs on Windows in CI and the shared client compiles, but a separately supported client is not claimed |

## Windows

The TypeScript client is portable and can be compiled with `deno compile`. The current compile task
produces `dist/pulsewire.exe`, and CI exercises the tests on Windows. That is useful for development,
but it is not yet a supported Windows milestone.

To make Windows a first-class target, the remaining work is:

1. Choose a supported terminal and keyboard story (Windows Terminal, conhost, and common shells).
2. Package the compiled executable with a clear install and upgrade path.
3. Verify terminal input, pasting, colour detection, and small-window layouts on Windows.
4. Run end-to-end tests against a real server from a Windows host.
5. Document support boundaries and known limitations.

Authentication needs no change: tokens are stored per server URL in the user's data directory, and
the server is reached over HTTPS when it leaves the local machine.

## Android

There is no Android app today. The recommended approach is a native Kotlin/Compose client that
consumes the existing `/v1` API:

- **Authentication**: reuse `/v1/auth/register`, `/v1/auth/login`, and `/v1/auth/logout`. Store
  bearer tokens in Android Keystore-backed storage, never in plain preferences.
- **Data**: list conversations, page message history with `before`, send/edit/delete where
  authorized, and maintain read cursors.
- **Freshness**: use a foreground refresh policy first. For background updates, consider push
  notifications or a periodic worker instead of tight polling.
- **Security**: require TLS, validate the server certificate, and do not log tokens or message
  bodies.
- **UI**: build an original Android interface. Do not reuse Pulsewire terminal rendering or copy
  Google Chat branding or assets.

No schema or server change is required for a basic Android client. Push notifications would need a
server-side device registration table and delivery worker, which is future work.

## Server deployment notes

The server defaults to `127.0.0.1:8787` and a SQLite file under the data directory. For any
deployment that leaves the machine:

- put the server behind a TLS reverse proxy and use an `https://` base URL;
- bind to a private interface and restrict access to the database and data directory;
- back up the SQLite file together with its WAL sidecars;
- add proxy-level rate limiting in addition to the built-in login limiter;
- create the first account immediately so an administrator exists, or set
  `PULSEWIRE_ADMIN_HANDLE` to a known account.

The dashboard is served by the same process. It needs no separate web server, build step, or
extension; its files are included in compiled binaries with `--include web`.

## Non-goals

- Copying Google Chat branding, logos, or proprietary assets.
- Presenting the offline demo as an online service.
- Claiming Windows or Android support before those clients are built and tested.
