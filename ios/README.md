# Sugar Scratchie — iOS smoke client

SwiftUI + Metal port of the [Android smoke client](../android/README.md). Same FastAPI backend, cookie auth, dual-video scratch loop, mesh-UV symbols, foil bar, film-strip transition, synthesized sounds, and haptics.

## Fastest way to test (recommended)

Your Mac often cannot run Local (needs Postgres on `:5433`) and the iOS Simulator may be broken on Xcode 27. Use **Remote**:

1. Open the project and run:

```bash
cd ios
open SugarScratchie.xcodeproj
```

2. In Xcode: pick a **physical iPhone** if the Simulator won’t accept clicks, or a Simulator if it works.
3. On the login screen, confirm **Server: Remote (.env)** (this is now the default).
4. Register any email + password (≥ 8 chars) against `https://sugarbackend.mxjprod.work`.

Media also comes from that host — you do **not** need `npm run dev:all` for Remote.

## Local mode (optional)

Needs all three:

```bash
# 1) Postgres (Docker Desktop must be running)
docker compose up -d

# 2) API + Vite media
npm run dev:all
```

| Device | API | Media |
| --- | --- | --- |
| Simulator | `http://127.0.0.1:8090` | `https://127.0.0.1:5080` |
| Phone | `http://<Mac LAN IP>:8090` | `https://<LAN IP>:5080` |

If Local login fails with “Could not connect”, Postgres isn’t up (`127.0.0.1:5433`) or the API crashed on startup.

## If you can’t click / type in the Simulator

This is a **Simulator / CoreSimulator** problem on this machine (Xcode 27 vs outdated Simulator services), not the app:

1. Prefer a **physical device** (cable + Developer Mode + Team in Signing).
2. Or fix Simulator: update macOS, open Xcode once and install components, then:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null
xcrun simctl list
```

3. In Simulator: **Device → Erase All Content and Settings…**, then Run again.
4. Toggle **I/O → Keyboard → Connect Hardware Keyboard** (⌘K).

## Generate / open

```bash
cd ios
./bin/xcodegen/bin/xcodegen generate   # if project.yml changed
open SugarScratchie.xcodeproj
```

LAN host and Remote URLs are written into `SugarScratchie/Generated/DevConfig.generated.swift` by the **Resolve Dev Endpoints** build phase (reads `frontend-new/.env`).

## Smoke flow

1. Register (password ≥ 8 chars) or log in.
2. Card deals a 5-card themed hand; intro trailer (if any) → scratch the foil bar → body scratch.
3. Reveal 12 symbols or clear ≥ 98% of the foil → auto-claim milestone 1 → film strip → next card.
4. After 5 cards, a new hand is dealt.

## Architecture notes

- **SwiftUI** for session chrome / HUD; **UIKit** login fields (more reliable in Simulator)
- **Metal** dual-video + scratch mask (shaders compile at runtime)
- **AVFoundation** looping players (clips cached for Vite basic-ssl)
- Scratches are **screen-space** (same as Android, not the web UV prototype)
