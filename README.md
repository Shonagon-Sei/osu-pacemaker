# osu! Local Leaderboard Overlay

A live-scrolling "local multiplayer" leaderboard for **osu!** (all modes, with
mania the most accurate). It finds every saved `.osr` replay for the map you're
about to play — plus the global top scores if you want — and races those ghosts
against your live play in a transparent OBS-ready overlay on the **ScoreV2**
(standardised) scale. When your live score passes a ghost at the current
timestamp, your bar slides up past theirs.

**Modes:** mania is frame-simulated for accurate mid-race curves. osu!std, taiko
and catch use each replay's exact stored standardised score with an approximated
race curve (full cursor/slider judging is a non-goal) — so std standings are
exact, the curve is an estimate. Mod **score multipliers** are accounted for
because exact finals (replay header / API / tosu) already include them.

```
osu! (stable)  ──►  tosu  ──ws──►  Node backend  ──ws──►  Browser overlay
                    (active map,   (index + simulate         (rAF interpolation
                     live stats)    all matching .osr)        + live re-sort)
```

Uses [**tosu**](https://tosu.app/) (the maintained successor to gosumemory) via
its modern **v2 API** (`/websocket/v2`).

## How it works

1. **Index** — On startup (and on each map change if `WATCH_REPLAYS=true`) it
   builds a *beatmap MD5 → replay files* map. It supports **both** osu! installs
   and auto-detects whichever exist:
   - **stable** — scans `osu!\Data\r\*.osr` (header-only, no LZMA decode), cached
     by mtime+size.
   - **lazer** — lazer has no `.osr` files; replays live as hash-named blobs in
     its content-addressable `files\` store. We walk that store and *content-sniff*
     each blob's header to find the replays (lazer writes them in legacy `.osr`
     format). Because the store is immutable, a "seen" set means each blob is
     sniffed only once, ever.

   Either way the result is cached to `.cache/replay-index.json`, so relaunches
   only look at new files.
2. **Match** — tosu broadcasts the active map's MD5 (`beatmap.checksum`) **and its
   absolute `.osu` path** (`directPath.beatmapFile`). We look up replays for that
   MD5 and simulate them against that exact `.osu` (no need to hash your whole
   Songs library).
3. **Simulate** — A `worker_threads` pool fans the matching replays across CPU
   cores. Each worker LZMA-decodes the replay, reads the mania **column bitmask**
   from each frame's `x` value, judges presses against note times using OD-based
   hit windows, and emits a score timeline sampled every `SIM_STEP_MS` (default
   100 ms).
4. **Stream** — Ghost timelines are sent to the overlay **once per map**; your
   live stats stream every tosu tick. The browser interpolates ghost scores at
   the live playhead with `requestAnimationFrame` and re-sorts bars each frame.

## Scoring model (read this)

This reproduces lazer's **ScoreV2** mania model (capped at 1,000,000):

```
score = 150000 · comboProgress
      + 850000 · acc^(2 + 2·acc) · progress

progress      = judged / totalHits          (map completion; a Meh still counts)
acc           = base / (judged · 305)       (quality — Perfect=305, Great=300, …)
comboProgress = Σ combo^COMBO_BASE / max     (combo weighting)
```

Key points:
- **lazer ghosts use the EXACT stored score.** A lazer `.osr` header carries the
  real standardised total, accuracy counts, and max combo, so we read those
  verbatim — ghost final standings match the in-game results screen exactly. The
  simulation is used only for the *shape* of the race curve (lazer stores no
  time-series), scaled to end on the exact number.
- **Your live bar uses tosu's reported score/accuracy/combo directly** — also the
  exact lazer value — so you and the ghosts are on one scale.
- The simulated curve (and the score for **stable** replays, which store a legacy
  ScoreV1 total) uses the formula above: coefficients, OD-scaled windows, accuracy
  weighting and 1.5× long-note tail leniency from the lazer source, with the combo
  exponent (`COMBO_BASE = 0.2`) calibrated against real scores. Validated to ~0.2%
  before the exact-header override, so even the mid-race curve is faithful.

All constants live in [`src/osu/scoreV2.js`](src/osu/scoreV2.js).

## Setup

Requires **Node ≥ 18**, **osu!** (stable or lazer), and a running
**[tosu](https://tosu.app/)** (launch tosu first — it auto-starts a server on
port 24050).

```bash
npm install
cp .env.example .env      # optional — only needed for custom install paths
npm start
```

Works with **both stable and lazer** — it auto-detects whichever you have
installed (stable `…\AppData\Local\osu!`, lazer `…\AppData\Roaming\osu`). On
startup it logs which it found, e.g. `Indexing source(s): lazer (C:\…\osu)`. Force
one with `OSU_MODE=stable|lazer`, or set `OSU_STABLE_ROOT` / `OSU_LAZER_ROOT` for
non-default locations.

Open **`http://localhost:7271/`** in a browser, or add it as an **OBS Browser
Source** (the background is transparent). Select a mania map in osu! that you've
played before — its ghosts appear; press play and the race begins.

## Showing it on screen (3 ways)

The overlay is just a transparent web page; how you display it depends on where
you want to see it.

| Goal | How |
|------|-----|
| **In your stream/recording** | Add `http://localhost:7271/` as an **OBS Browser Source** over your osu! capture. Easiest, but only visible in OBS — not on your own screen. |
| **On your screen while playing (true in-game overlay)** | Run the bundled **Electron overlay** (below). |
| **Quick test / second monitor** | Just open `http://localhost:7271/` in a browser window. |

### True in-game overlay (Electron)

osu! is a fullscreen game, so a browser/OBS source won't appear over your own
gameplay. The bundled Electron shell creates a transparent, always-on-top,
**click-through** window that floats over osu!:

```bash
npm install            # pulls in electron (~once)
npm start              # terminal 1: backend (keep running)
npm run overlay        # terminal 2: the floating overlay window
```

**You must run osu! in Borderless**, *not* exclusive fullscreen — Options ▸
Graphics ▸ uncheck **Fullscreen** (leave "Letterboxing" off). Windows will not
let any overlay draw above an exclusive-fullscreen game; borderless lets it
composite on top.

Hotkeys while the overlay runs:
- **Ctrl+Shift+O** — quit the overlay
- **Ctrl+Shift+L** — lock/unlock. **Unlocked** shows drag + resize handles and lets
  you reposition/scale the panel; **locked** makes it click-through so play isn't
  affected.

Clicks and keystrokes pass straight through to osu! while locked, so it never
interferes with play.

### Moving & resizing

The overlay is **draggable and resizable** in any context:
- Drag it by the **header** (the `⠿` grip); resize with the **corner handle**.
- In a browser/OBS it's always editable. In the Electron overlay, press
  **Ctrl+Shift+L** to unlock first.
- Position and scale are saved to `localStorage`, so they persist across reloads
  and restarts.

### Global top scores as ghosts

Race the **beatmap's global leaderboard**, not just your own replays. In the
config screen turn on **"Include global top scores"** and set the count (**up to
100** — the API's maximum). Requires osu! API credentials — create an OAuth app
at [osu.ppy.sh/home/account/edit](https://osu.ppy.sh/home/account/edit) and put
the client id/secret in `.env`:

```
OSU_API_CLIENT_ID=12345
OSU_API_CLIENT_SECRET=your-secret
```

No user login is needed (client-credentials). The leaderboard gives each score's
**exact** standardised score / accuracy / combo, so global standings are exact;
their mid-race curve is approximated (one API call per map — no replay downloads).
Global ghosts show a 🌐 and respect the **"only ghosts with my mods"** filter.

**Scoring (Standardised vs Classic):** the config screen has a **Scoring** toggle
that mirrors lazer's own *Classic score display* setting:
- **Standardised (ScoreV2)** — the default; the value osu! ranks by (~1M scale).
- **Classic** — applies lazer's exact standardised→classic display conversion to
  **every** score (ghosts and your live bar), so the whole board switches together.

Because the conversion only needs the standardised score + the map's object count,
it works for **all** ghosts including your own local replays — no extra data
needed. Notes:
- **Mania is unchanged** by Classic — that's intentional; lazer shows mania classic
  == standardised, so the toggle has no visible effect on mania maps.
- **std/taiko/catch** scale up to the familiar big classic numbers (e.g. ~130M).
- Keep lazer's *own* in-game display on Standardised; the overlay does the
  conversion, so double-converting is avoided. (This matches lazer's display
  conversion, which is an approximation of ScoreV1 — not the exact submitted V1.)

### Customizing the look (config screen)

Click the **⚙ gear** in the header (visible when unlocked) for a live settings
panel. Everything saves to `localStorage` and applies instantly:
- **Rank by** — Score, Accuracy, Combo, or **Perfect:Great ratio**. The big number
  shows the chosen metric; bars re-sort to match.
- **Follow my rank (window)** — for long boards (e.g. global top 50). Instead of a
  giant list, it shows **#1**, a `⋯ N more ⋯` separator, the configurable number of
  **players above me**, then **you**, plus optional **players below me** — so your
  bar is always visible no matter your rank. Turn it off for a plain top-N list.
- **Sort debounce (ms)** — how long a bar must hold a lead before it overtakes
  another. Higher = calmer/stickier board; lower = snappier re-sorting.
- **Scoring** — Standardised (ScoreV2) or Classic (ScoreV1); see below.
- **Max rows (full view)** — row count when *not* following your rank.
- **Highlight #1 pace** (gives the current leader its own colour so you can tell at
  a glance whether you're on top), **Only ghosts with my mods**.
- **Colours** — your bar, the #1-pace bar, rank numbers, text.
- **Size & layout** — bar height, gap, width, font scale, overall scale, text
  shadow. Plus **Reset to defaults**.

### Pause / retry / quit

The overlay reacts to what you do mid-map (osu! reports no explicit "paused"
flag, so this is inferred from the gameplay clock):
- **Pause** — the ghosts freeze in place and a **❚❚ PAUSED** badge appears; the
  race resumes exactly where it left off.
- **Retry** (clock jumps back) — your bar resets to 0 and re-races.
- **Quit** to song select / results — your bar drops off and the board returns to
  the ghosts' final-score preview.

### Verify your paths first

```bash
npm run index
```

This rebuilds the index and prints the maps with the most replays — good targets
to test the overlay on. If it reports 0 replays, your `OSU_ROOT` is wrong.

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `OSU_MODE` | `auto` | Which install to index: `auto` \| `stable` \| `lazer` |
| `OSU_STABLE_ROOT` | `%LOCALAPPDATA%\osu!` | Stable install dir (contains `Data\r`) |
| `OSU_LAZER_ROOT` | `%APPDATA%\osu` | Lazer data dir (contains `client.realm`, `files\`) |
| `TOSU_URL` | `ws://127.0.0.1:24050/websocket/v2` | tosu v2 websocket |
| `RELAY_PORT` | `7270` | WebSocket the overlay connects to |
| `HTTP_PORT` | `7271` | Static server for the overlay HTML |
| `SIM_STEP_MS` | `100` | Timeline sample granularity |
| `SIM_WORKERS` | `0` (auto) | Simulation worker threads (`0` = cpus−1) |
| `MAX_GHOSTS` | `7` | Show top N ghosts by final score (`0` = all) |
| `WATCH_REPLAYS` | `true` | Re-scan index on each map change |

## Project layout

```
config/index.js              env parsing + path resolution
src/
  index.js                   orchestrator (wires everything, generation-guarded)
  util/binaryReader.js       osu! little-endian + ULEB128 + string reader
  util/logger.js             tiny leveled logger
  osu/
    osrParser.js             .osr header / full parse + LZMA frame decode
    osuParser.js             .osu beatmap parse (keys, OD, hit objects, LNs)
    mods.js                  rate + OD adjustments from mod bitmask
    scoreV2.js               hit windows + ScoreV2 formula (tune here)
    maniaSimulator.js        bitmask→events→judgements→score timeline
    replayIndex.js           Data\r header scan + mtime cache (MD5→files)
  sim/simPool.js             worker_threads pool + per-map batch
  workers/simWorker.js       one replay: read→LZMA→judge→timeline
  server/
    tosuClient.js            tosu v2 client (normalised events, reconnect)
    relayServer.js           overlay WS hub (bulk ghosts + live stream)
    httpServer.js            static overlay server + /config.json
  tools/reindex.js           CLI: rebuild + report the index
public/
  index.html  style.css  overlay.js     transparent overlay (rAF + re-sort)
electron/overlay-main.js     transparent click-through in-game window
```

## Troubleshooting

**`npm run index` finds replays but `npm start` shows none.** The index is fine;
the live *match* is failing. Watch the backend log when you select a map — it now
prints one of:
- `Matched N replay(s) for this map.` — working.
- `No local replays for this map (md5 …). Index holds N other maps.` — that
  specific map genuinely has no saved replays. Pick a map you've actually played,
  or play it once so a `.osr` is written.
- `No replays indexed at all …` — `OSU_ROOT` is wrong for this process.
- *(no "Map selected" line at all)* — tosu isn't sending a usable beatmap. Confirm
  tosu is running, you're on the **v2** endpoint (`TOSU_URL=…/websocket/v2`), and
  osu! has a mania map selected. The client warns once if the payload shape looks
  like the legacy `/ws` endpoint.

MD5 matching is case-insensitive, and the map-change event waits until tosu has
also reported the `.osu` path (it can lag the checksum by a tick), so a map that
"flickers" past on load is still picked up.

## Notes & limitations

- **Stable and lazer both supported.** Lazer replays are read straight from its
  `files\` store by content-sniffing — no Realm DB dependency, so it keeps working
  across lazer schema/version bumps.
- Neither `scores.db` (stable) nor `client.realm` (lazer) is parsed — header/blob
  scanning is more robust across osu! versions.
- First lazer scan walks the whole `files\` store; on a large install that's a few
  seconds. It's cached afterwards (each blob is sniffed at most once).
- DT/NC/HT rate and EZ/HR OD changes are handled. Lazer-only mods (e.g. custom
  rate-adjust) aren't in the legacy mod bitmask, so those replays simulate at 1.0×.
- If a map has no replays, the overlay simply shows "No local replays".
