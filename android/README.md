# Sugar Scratchie — Android smoke client

Minimal Kotlin/Compose app that talks to the **same FastAPI backend** as the web player:

1. Register / login (`sugar_session` cookie)
2. Load a motion card (`GET /api/cards`)
3. Start a scratch hand (`POST /api/rewards/scratch/hands`)
4. Play the card’s motion video (Media3)
5. Claim milestone 1 coins (`POST /api/rewards/scratch/coins`)

This does **not** port the UV mesh scratch canvas — that remains a follow-up.

## Prerequisites

- Android Studio (Ladybug / Koala+) or command-line SDK
- JDK 17
- Host services running from the repo root:

```bash
npm run dev:api   # FastAPI on 127.0.0.1:8090
npm run dev       # Vite media on :5080 (/cards, /mesh)
```

## Open / run

```bash
cd android
./gradlew :app:assembleDebug
# or open the android/ folder in Android Studio and Run
```

Debug defaults (emulator):

| BuildConfig        | Value                   |
| ------------------ | ----------------------- |
| `API_BASE_URL`     | `http://10.0.2.2:8090`  |
| `MEDIA_BASE_URL`   | `https://10.0.2.2:5080` |

Vite serves `/cards` and `/mesh` on **HTTPS** port 5080 (`@vitejs/plugin-basic-ssl`). The debug app trusts that local certificate only for media playback.

## Physical device

**Option A — adb reverse (keep defaults or point at 127.0.0.1):**

```bash
adb reverse tcp:8090 tcp:8090
adb reverse tcp:5080 tcp:5080
```

Then set both base URLs to `http://127.0.0.1:8090` / `http://127.0.0.1:5080` in [`app/build.gradle.kts`](app/build.gradle.kts) `buildConfigField`s and rebuild.

**Option B — LAN IP:** bind the API to all interfaces (`--host 0.0.0.0`) and set the base URLs to your machine’s LAN IP (phone and laptop on the same Wi‑Fi). Vite already listens on `0.0.0.0:5080`.

## Smoke flow in the app

1. Register with any email + password (≥ 8 chars), or log in.
2. Confirm wallet + a card label appear.
3. Tap **Start scratch hand** → note `handId`.
4. Video should loop (foreground preferred, else background).
5. Tap **Claim milestone 1** → coins should increase.

API docs while the server is up: http://127.0.0.1:8090/docs
