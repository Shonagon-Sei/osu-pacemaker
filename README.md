# osu! Pacemaker

A live leaderboard overlay for **osu!**. It races your current play against
**ghosts** — your own past replays for the map, plus (optionally) the **global
top scores** — and slides your bar up the board in real time as you pass them.

Works with **osu! lazer and stable**, all modes (most accurate in mania).

---

## What you need

- **osu!** running in **Borderless** (Options ▸ Graphics ▸ uncheck *Fullscreen*).
  An overlay can't draw over exclusive fullscreen.
- **[tosu](https://tosu.app/)** running (it reads the game; just launch it).

## Install & run

1. Download the latest from the
   [**Releases**](https://github.com/Shonagon-Sei/osu-pacemaker/releases) page:
   - **`osu-pacemaker-Setup-x.y.z.exe`** — installer (recommended; auto-updates).
   - **`osu-pacemaker-x.y.z-portable.exe`** — single file, no install.
2. Run it. The overlay appears on top of the game.
3. Play a map you've played before — your ghosts load and the race begins.

That's it. The app updates itself when a new version is released.

> First launch may show a Windows SmartScreen prompt (unsigned app) —
> **More info ▸ Run anyway**.

## Using the overlay

- **Ctrl + Shift + L** — lock / unlock. **Unlock** to drag it, resize it (corner
  handle), or open settings (⚙). **Lock** so clicks pass through to the game.
- **Ctrl + Shift + O** — quit.
- The **system-tray icon** also has unlock, reload, check-for-updates, and quit.

While playing it tracks pauses, retries, and quitting automatically.

## Settings (the ⚙ gear, when unlocked)

- **Rank by** — Score, Accuracy, Combo, or Perfect:Great ratio.
- **Follow my rank** — for long boards, shows #1, the players just above you, and
  you — so your bar is always on screen.
- **Include global top scores** — race the beatmap's worldwide leaderboard
  (shown with a 🌐). No setup needed.
- **Only ghosts with my mods**, **highlight #1 pace**, **max rows**.
- **Colours, size, layout, text shadow** — make it yours.
- **Scoring** — Standardised (default) or Classic, matching lazer's display.
- **Sort debounce** — how quickly the board re-orders.

All settings save automatically.

## Tips / troubleshooting

- **Overlay not visible over the game?** Make sure osu! is in **Borderless**, not
  fullscreen.
- **No ghosts on a map?** You need a saved replay for it — play it once, or turn
  on **Include global top scores**.
- **Nothing happening at all?** Make sure **tosu** is running.

---

*Built with [tosu](https://tosu.app/). Not affiliated with osu! or ppy.*
