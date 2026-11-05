# Pulsewire for Android

A native Android client for a self-hosted Pulsewire server. It is written in Kotlin with Jetpack
Compose and talks to the existing `/v1` REST API. It is not the offline demo and it does not bundle
any local message data.

## What it does

- Register a new account on a server, sign in, and sign out.
- List conversations with unread badges, previews, and timestamps.
- Page through message history, send messages, edit and delete your own messages.
- Mark conversations read and refresh from the server's append-only event feed.
- Search message text and conversation names across your conversations.
- Create direct messages, groups, and spaces.
- View members, invite people, remove people as an owner, and leave a conversation.
- Update your display name and handle.
- Show loading, empty, and error states.
- Store the session token with an AES/GCM key held by the Android Keystore.

The client does not include an administrator dashboard. Use `/admin` in a browser for moderation.

## Requirements

- A running Pulsewire server reachable from the phone or emulator.
- Android Studio (Koala or newer) **or** JDK 17 with Android SDK platform 35 and build-tools 35.0.0.
- The Gradle wrapper is committed, so a separate Gradle installation is not required.

The app targets Android 15 (API 35) and supports Android 8.0 (API 26) and newer.

## Point the server at your LAN

By default the server listens only on loopback, which a phone cannot reach. Start it on a private
interface:

```sh
deno task server --host 0.0.0.0 --port 8787
```

The equivalent environment variable is:

```sh
PULSEWIRE_SERVER_HOST=0.0.0.0 PULSEWIRE_SERVER_PORT=8787 deno task server
```

Find the computer's LAN address:

```sh
# Linux
hostname -I
# or inspect one interface
ip -4 addr show
```

Use `http://<LAN-IP>:8787` from a device on the same Wi-Fi/LAN. Allow the port through the host
firewall if necessary, for example:

```sh
sudo ufw allow 8787/tcp
```

Then check:

- `http://<LAN-IP>:8787/health` returns `{"status":"ok"}` from the phone's browser.
- `http://<LAN-IP>:8787/admin` opens the dashboard.
- The Android app's server field uses the same URL.

Emulator shortcuts:

- Android Studio emulator: `http://10.0.2.2:8787` reaches the host machine's loopback.
- Physical phone: use the host's LAN IP, not `127.0.0.1` and not `10.0.2.2`.

### Security boundary

The app permits cleartext HTTP so a trusted home or office LAN can use the server without a
certificate. That is a deliberate trade-off:

- Anyone who can observe the LAN can read the session token and message traffic over plain HTTP.
- Use HTTPS, for example through a reverse proxy, for any network you do not control.
- Do not expose the plain HTTP server directly to the internet.
- The app validates normal TLS certificates but does not implement certificate pinning.

The server address is stored in plain preferences. The bearer token and cached profile are encrypted
with an Android Keystore key. Passwords, tokens, and message contents are never written to logcat by
this app. Backups are disabled for the app.

## Build and install

From the repository root:

```sh
cd android
./gradlew :app:assembleDebug
```

The debug APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected device or emulator:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` directory in Android Studio, select a device, and press Run.

Useful checks:

```sh
cd android
./gradlew :app:lintDebug
./gradlew :app:testDebugUnitTest
```

The unit tests cover base URL normalization, login request/response handling, bearer headers,
pagination parameters, and server error mapping. They do not replace an on-device test.

## First run

1. Start the server on the LAN and create the first account (the first account on a fresh database
   becomes the administrator).
2. Open the app, enter the server URL, and sign in or create an account.
3. Create a direct message or group, or wait for another account to start one.
4. Open a conversation to load history and mark it read.
5. Use the profile screen to change your display name or handle, sign out, or confirm the server
   URL.

Incoming changes are refreshed by polling `/v1/events` roughly every three seconds while the app is
running. There are no push notifications.

## Supported scope and limits

- No attachments, reactions, typing indicators, or rich text.
- Reply threads are not shown in the Android UI, although the API supports them.
- No offline message cache; the conversation list and profile are the only cached values.
- No Android administrator screens.
- No push or background sync. Polling stops when the process is gone.
- No certificate pinning and no custom CA configuration beyond the system trust store.
- No tablet-specific two-pane layout.

## Verified build

This client was compiled on Linux with JDK 17, Android SDK platform 35, build-tools 35.0.0, and
Gradle 8.9:

- `:app:assembleDebug` produced a debug APK.
- `:app:lintDebug` completed without errors. (The cleartext warning is intentional and documented
  above.)
- `:app:testDebugUnitTest` ran five tests with zero failures.

No emulator or physical device was available in the build environment, so runtime login, rendering,
keyboard behavior, and connectivity have **not** been verified on Android. Treat that as the
remaining manual test before calling the client field-ready.

## Source layout

```text
android/app/src/main/java/dev/pulsewire/android/
  MainActivity.kt           Compose entry point and navigation
  PulsewireViewModel.kt     State, API calls, event polling
  data/
    Models.kt               JSON models and API errors
    PulsewireApi.kt         OkHttp API client
    SessionStore.kt         Keystore-backed token storage
  ui/                       Auth, conversations, chat, members, search, profile
```
