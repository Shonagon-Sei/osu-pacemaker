# osu-pacemaker leaderboard proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that holds your osu!
API secret so the distributed app never has to. The app only ever knows the
public Worker URL.

## Deploy (one time, free)

1. Install Wrangler and log in:
   ```
   npm i -g wrangler
   wrangler login
   ```
2. From this `proxy/` folder, set your osu! OAuth app credentials as secrets
   (create the app at <https://osu.ppy.sh/home/account/edit>):
   ```
   wrangler secret put OSU_CLIENT_ID
   wrangler secret put OSU_CLIENT_SECRET
   ```
3. Deploy:
   ```
   wrangler deploy
   ```
   Wrangler prints a URL like `https://osu-pacemaker-proxy.<you>.workers.dev`.

4. Put that URL in the app's `.env` and rebuild:
   ```
   OSU_PROXY_URL=https://osu-pacemaker-proxy.<you>.workers.dev
   ```

That's it. The packaged app calls `<url>/leaderboard?...`; the secret lives only
in the Worker. (The Worker caches the OAuth token and adds CORS, so it's safe to
call from the browser overlay too.)

## Test it

```
curl "https://osu-pacemaker-proxy.<you>.workers.dev/leaderboard?beatmap=129891&mode=osu&limit=5"
```
should return a JSON `{ "scores": [...] }`.
