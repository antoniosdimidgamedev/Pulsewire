# Android Client

Pulsewire ships a native Android client written in Kotlin with Jetpack
Compose. It consumes the existing `/v1` REST API — no server changes required.

## Requirements

- Android 8.0 (API 26) or newer
- Android Studio (Koala+) or JDK 17 + Android SDK platform 35 / build-tools 35.0.0
- A running Pulsewire server reachable from the device

## Build

```sh
cd android
./gradlew :app:assembleDebug
```

The debug APK is written to
`android/app/build/outputs/apk/debug/app-debug.apk`.

Install on a connected device:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## LAN setup

Start the server on a private interface:

```sh
deno task server --host 0.0.0.0 --port 8787
```

Then enter `http://<LAN-IP>:8787` in the app. The Android Studio emulator can
use `http://10.0.2.2:8787` instead.

## Features

- Register and sign in to your server
- Conversation list with unread badges and previews
- Page through message history
- Send, edit, and delete your own messages
- Mark conversations read; poll `/v1/events` for updates (~every 3s)
- Search message text and conversation names
- Create direct messages, groups, and spaces
- View and manage conversation members (owners can add/remove)
- Update display name and handle
- Keystore-encrypted session token storage

## Scope and limits

- No attachments, reactions, typing indicators, or rich text
- No offline message cache beyond the conversation list and profile
- No push notifications or background sync
- No certificate pinning
- Cleartext HTTP allowed for trusted LANs only; use HTTPS elsewhere
- No Android administrator screens (use `/admin` in a browser)

## Verification

The client was compiled on Linux with JDK 17, SDK 35, build-tools 35.0.0, and
Gradle 8.9:

- `:app:assembleDebug` — produced a debug APK
- `:app:lintDebug` — completed without errors
- `:app:testDebugUnitTest` — 5 tests, 0 failures

No emulator or physical device was available, so runtime behavior has not been
verified on Android.
