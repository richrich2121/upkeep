# Upkeep

A task tracker that doesn't just sit there — it actively nags you about pending
tasks on a cadence you control, sometimes calling out a specific random task
by name, and gives you an evening wrap-up of what's left undone today plus
what's due tomorrow. Built as an installable Android PWA + a small Node
backend that decides in real time whether it's time to nudge you (not a
fixed schedule).

This is built for **single-user personal use** — there's no login, one shared
task list, one push subscription. Don't expose the URL publicly if you don't
want that.

## How the "nagging" actually works

Every minute, the server checks:
1. Are notifications enabled and is there a saved push subscription?
2. Is the current time inside your "active hours" (so it won't buzz you at 2am)?
3. Are there any pending tasks (due today or overdue)?
4. Has enough time passed since the last nudge (your configurable interval)?

If all yes, it sends one push notification — either naming one random pending
task ("Still on your list: Change car oil") or a general count, based on your
settings. Tapping **Mark done** on the notification completes that task right
from the lock screen. Tapping **Later** resets the buffer timer without
waiting for the next natural cycle.

Separately, once a day at your chosen evening time, it sends a wrap-up: how
many tasks are still undone today, and how many are due tomorrow.

## 1. Run it locally first

```bash
npm install
npm run generate-vapid
```

This prints a `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Create a `.env` file
(or just export them in your shell) — Node doesn't load `.env` automatically,
so either use a tool like `dotenv` or export manually:

```bash
export VAPID_PUBLIC_KEY="..."
export VAPID_PRIVATE_KEY="..."
export VAPID_CONTACT="mailto:you@example.com"
npm start
```

Visit `http://localhost:3000` — the task app should load.

## 2. Set up free, permanent task storage (Upstash)

Render's free tier wipes its local disk on every redeploy, restart, *and* spin-down —
so storing tasks in a plain file (like this app originally did) means you'd
periodically lose your task list for free. Instead, tasks are now stored in
a free Upstash Redis database, which persists indefinitely and doesn't
expire.

1. Go to [upstash.com](https://upstash.com) and sign up (free, no credit card).
2. Click **Create Database**, give it any name, pick a region close to you.
3. On the database's page, find the **REST API** section and copy two values:
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
4. Add both as environment variables on Render (same place you added the
   VAPID keys), alongside your existing three.

If these two variables aren't set, the app still runs — it just falls back
to in-memory storage that's lost on every restart, same as before. A
warning is logged on startup if this happens.

## 3. Deploy somewhere that stays running

Push notifications only fire if the server is actually alive when the minute
ticks over — it needs real (always-on) hosting, not a serverless function
that sleeps. Free tiers that work well for this scale:

- **Render** (Web Service, free tier — note: free instances spin down after
  inactivity and take ~30s to wake on the next request, which can delay the
  very next nag by up to that long, but the cron catches up once it's awake)
- **Railway** or **Fly.io** (similar free/hobby tiers, less aggressive sleep)

General steps for Render:
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
   `VAPID_CONTACT`.
5. Deploy. You'll get a URL like `https://upkeep-yourname.onrender.com`.

**Important:** Tasks now live in Upstash Redis, not in a local file, so they
survive redeploys and restarts as long as `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are set correctly (see step 2 above). If you skip
Upstash setup, the app still works but reverts to in-memory storage that
resets whenever the service restarts or spins down.

## 4. Install it on your Android phone

1. Open the deployed URL in **Chrome** on your phone.
2. Tap the **⋮** menu → **Add to Home screen** (or Chrome will prompt you).
3. Open the app from the home screen icon (it now runs full-screen, no
   browser bar).
4. Tap **🔔 Enable alerts** and allow notifications when Android asks.
5. Tap **⚙ Settings** to set how often you want to be nagged, your active
   hours, and your evening wrap-up time.
6. Tap **Send a test notification** to confirm it's wired up correctly.

From here it runs on its own — you don't need to keep the app open. The
server checks every minute and pushes to your phone directly, same as any
other app's notifications.

## Notes and honest limitations

- If you force-stop the app or clear Chrome's site data, the push
  subscription is lost and you'll need to tap **Enable alerts** again.
- Free-tier hosts that spin down when idle mean your very first nudge after
  a quiet period might be delayed by the host's wake-up time — after that
  it's on time.
- All the reminder logic (interval, quiet hours, random vs. summary message)
  lives in `nagCheck()` and `eveningCheck()` in `server.js` if you want to
  tune the feel further.
