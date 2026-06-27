# Developing & building

Developer notes for osu! Pacemaker. End users don't need any of this — see the
[README](README.md).

## Run from source

Requires **Node ≥ 18** and a running **[tosu](https://tosu.app/)**.

```bash
npm install
npm run app        # the full desktop app (backend + overlay window + tray)
```

Other entry points:
- `npm start` — backend only (serves the overlay at `http://localhost:7271/`,
  usable as an OBS Browser Source).
- `npm run overlay` — just the overlay window (against an already-running backend).
- `npm run index` — rebuild the replay index and print the maps with the most replays.

## Configuration (`.env`, optional)

Auto-detection covers the common case; only set these for custom setups.

| Var | Default | Meaning |
|-----|---------|---------|
| `OSU_MODE` | `auto` | `auto` \| `stable` \| `lazer` |
| `OSU_STABLE_ROOT` | `%LOCALAPPDATA%\osu!` | stable install dir |
| `OSU_LAZER_ROOT` | `%APPDATA%\osu` | lazer data dir |
| `TOSU_URL` | `ws://127.0.0.1:24050/websocket/v2` | tosu v2 websocket |
| `RELAY_PORT` | `7270` | overlay websocket |
| `HTTP_PORT` | `7271` | overlay static server |
| `SIM_STEP_MS` | `100` | timeline sample step |
| `SIM_WORKERS` | `0` (auto) | simulation worker threads |
| `MAX_GHOSTS` | `7` | max ghosts the backend sends |
| `WATCH_REPLAYS` | `true` | re-scan the index on each map change |
| `OSU_PROXY_URL` | — | leaderboard proxy URL (for global ghosts; see `proxy/`) |
| `OSU_GLOBAL_COUNT` | `50` | default global scores to pull (1–100) |

## Global ghosts & the proxy

Global scores come from the osu! API. So the app never ships the API secret, a
small **Cloudflare Worker** (`proxy/`) holds it and the app only knows the public
Worker URL. Deploy it once and set `OSU_PROXY_URL` — see
[`proxy/README.md`](proxy/README.md).

(Dev-only fallback: set `OSU_API_CLIENT_ID` / `OSU_API_CLIENT_SECRET` in `.env` to
call the API directly. Never ship a build with a key baked in.)

## Building the installer

```bash
npm run dist       # bakes the proxy URL + icons, then builds dist/*.exe
```

Produces an NSIS installer (auto-updating) and a portable `.exe` in `dist/`.

## Publishing a release (auto-update)

The app auto-updates from GitHub Releases via electron-updater.

```bash
# token: classic PAT with `public_repo`, or fine-grained with Contents: Read/Write.
# put GH_TOKEN=... in .env, or set it in the shell.
npm version patch          # bump version + tag
git push --follow-tags
npm run release            # build + upload installer + latest.yml to the Release
```

The release version must match `package.json`. Auto-update needs `latest.yml`
uploaded alongside the installer (electron-builder does this on `--publish`).

## How it works (short)

- **tosu** streams the active map + your live stats over a websocket.
- The **backend** indexes replays (stable `Data\r\*.osr`; lazer's hash-named blobs
  in `files\`, content-sniffed), simulates mania frame-by-frame for accurate race
  curves, and uses each replay's exact stored final score. std/taiko/catch use the
  exact stored score with an approximated curve. Global ghosts come from the proxy.
- The **overlay** (a transparent web page) interpolates ghost scores at the live
  playhead with `requestAnimationFrame` and re-sorts the bars each frame.
- The **Electron app** runs the backend in-process, shows the overlay window, adds
  a tray, and handles auto-update.
