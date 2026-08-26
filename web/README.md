# VidMinder web

A multi-user web version of VidMinder on Cloudflare's free tier: one Worker
serves the React frontend (static assets) and the `/api/*` JSON API, with D1
(SQLite) for storage and a cron trigger polling followed channels' RSS feeds.

**Scope vs. the desktop app:** library, channels, and inbox — no offline
downloads (Workers can't run yt-dlp/ffmpeg), playback links out to YouTube.
Videos added by URL get title/uploader/thumbnail from YouTube's oEmbed API;
duration isn't available without yt-dlp.

Accounts are email + password (PBKDF2, HttpOnly session cookies). Signup
requires the invite code in `SIGNUP_CODE` (wrangler.jsonc) — change it before
deploying, or set it as a secret with `wrangler secret put SIGNUP_CODE` and
delete the var.

## First deploy

```sh
cd web
npm install
npx wrangler login                 # one-time browser auth
npm run db:create                  # prints a database_id →
                                   #   paste it into wrangler.jsonc
npm run db:schema                  # create tables in the remote D1
npm run deploy                     # build frontend + deploy Worker
```

The deploy prints your `https://vidminder.<subdomain>.workers.dev` URL.
Open it on any device, create the first account with the invite code, done.

## Local development

```sh
npm run db:schema:local            # once, to seed the local D1
npm run dev:worker                 # wrangler dev (API on :8787)
npm run dev                        # vite dev server (frontend on :5173,
                                   #   proxies /api → :8787)
```

## Notes

- Channel RSS polling runs on a `*/30 * * * *` cron; "Check channels now" in
  the Inbox tab forces it. Each run covers the 40 stalest channels (free-plan
  subrequest headroom).
- The desktop app and the web app don't sync (separate databases). Treat the
  web app as its own library for now.
