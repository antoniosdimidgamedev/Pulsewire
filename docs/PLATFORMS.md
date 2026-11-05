# Platform notes

Pulsewire ships a Linux terminal client, a self-hosted server, a browser dashboard, and a native
Android client. Windows remains a build target: the shared TypeScript client compiles, but a
separately supported Windows client is not claimed.

## Supported today

| Platform               | What is supported                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux                  | Terminal client (TUI and non-interactive commands), server, dashboard in any modern browser                                                         |
| Any modern browser     | Dashboard at `/admin`, served by the Pulsewire server                                                                                               |
| Android 8.0+ (API 26+) | Native Kotlin/Jetpack Compose client for the `/v1` API: auth, conversations, history, send/edit/delete, search, read state, membership, and profile |
| Windows                | The test suite runs on Windows in CI and the shared client compiles, but a separately supported client is not claimed                               |

## Windows

The TypeScript client is portable and can be compiled with `deno compile`. The current compile task
produces `dist/pulsewire.exe`, and CI exercises the tests on Windows. That is useful for
development, but it is not yet a supported Windows milestone.

To make Windows a first-class target, the remaining work is:

1. Choose a supported terminal and keyboard story (Windows Terminal, conhost, and common shells).
2. Package the compiled executable with a clear install and upgrade path.
3. Verify terminal input, pasting, colour detection, and small-window layouts on Windows.
4. Run end-to-end tests against a real server from a Windows host.
5. Document support boundaries and known limitations.

Authentication needs no change: tokens are stored per server URL in the user's data directory, and
the server is reached over HTTPS when it leaves the local machine.

## Android

The native Android client lives in [`android/`](../android/README.md). It is Kotlin with Jetpack
Compose, targets Android 15 (API 35), supports Android 8.0 (API 26) and newer, and consumes the
existing `/v1` REST API. No server schema or route change was required.

- **Authentication**: uses `/v1/auth/register`, `/v1/auth/login`, and `/v1/auth/logout`. The bearer
  token and cached profile are encrypted with an AES/GCM key held by the Android Keystore. The
  server URL is stored in plain preferences, and app backups are disabled.
- **Data**: lists conversations with unread counts, pages history with `before`, sends messages,
  edits and deletes the account's own messages, marks conversations read, searches, and manages
  conversation membership.
- **Freshness**: polls `/v1/events` about every three seconds while the app process is alive. There
  is no push notification, background worker, or WebSocket dependency.
- **Security**: cleartext HTTP is permitted deliberately for trusted LAN servers. Use HTTPS for any
  network you do not control, and do not expose the plain HTTP server to the internet. The client
  validates normal system-trusted TLS certificates but does not implement certificate pinning.
- **UI**: an original Compose interface. It does not reuse terminal rendering or copy Google Chat
  branding, logos, or other proprietary assets.

### LAN setup

The server listens on `127.0.0.1` by default, which a phone cannot reach. Start it on a private
interface and use the host's LAN address:

```sh
deno task server --host 0.0.0.0 --port 8787
hostname -I
# In the app: http://<LAN-IP>:8787
```

Allow port `8787` through the host firewall, then confirm `http://<LAN-IP>:8787/health` from the
phone's browser. The Android Studio emulator can use `http://10.0.2.2:8787` to reach the host
machine's loopback instead.

### Build and verification status

The client was compiled on Linux with JDK 17, Android SDK platform 35, build-tools 35.0.0, and
Gradle 8.9:

- `:app:assembleDebug` produced a debug APK.
- `:app:lintDebug` completed without errors.
- `:app:testDebugUnitTest` ran five JVM tests with zero failures.

No emulator or physical device was available in the build environment. Runtime login, rendering,
keyboard behavior, and real-network connectivity have **not** been verified on Android. That is the
remaining manual test before calling the client field-ready. See
[`android/README.md`](../android/README.md) for exact commands and supported scope.

Push notifications would need a server-side device registration table and delivery worker, which
remains future work.

## Server deployment notes

The server defaults to `127.0.0.1:8787` and a SQLite file under the data directory. For any
deployment that leaves the machine:

- put the server behind a TLS reverse proxy and use an `https://` base URL;
- bind to a private interface and restrict access to the database and data directory;
- back up the SQLite file together with its WAL sidecars;
- add proxy-level rate limiting in addition to the built-in login limiter;
- create the first account immediately so an administrator exists, or set `PULSEWIRE_ADMIN_HANDLE`
  to a known account.

The dashboard is served by the same process. It needs no separate web server, build step, or
extension; its files are included in compiled binaries with `--include web`.

## Non-goals

- Copying Google Chat branding, logos, or proprietary assets.
- Presenting the offline demo as an online service.
- Claiming Android runtime support beyond the build, lint, and unit-test evidence above until the
  app has been exercised on a device or emulator.
- Claiming Windows support before a Windows-specific client is built and tested.
