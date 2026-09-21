# Reminders

A single-user reminder app. Type what to remember, pick a time, save. At that time a message
arrives in a Discord channel, and Discord's own apps deliver the push notification to your phone
and laptop.

## How it works

```
phone / laptop browser  ──HTTPS──▶  Cloudflare Worker  ──▶  D1 (SQLite)
       (the page)                     /api/*  + static files
                                          ▲
                        Cron Trigger every minute: "anything due?" ──▶ POST Discord webhook
```

* **Storage / sync**: every reminder lives in a D1 database, so both devices see the same list.
  The page keeps a copy in `localStorage` and queues writes made while offline; they are sent
  when the connection returns.
* **Scheduling**: a Cron Trigger runs the Worker every minute. It selects reminders whose
  `next_at <= now`, atomically claims each one (so a message is never sent twice), posts it to the
  Discord webhook, and computes the next occurrence. If Discord is unreachable the claim is rolled
  back and the next minute retries — a late reminder beats a lost one. If several occurrences of a
  repeating reminder were missed during an outage, it sends once, marks it "sent late", and skips
  to the next future occurrence rather than spamming.
* **Pings**: each occurrence is sent `PINGS` times (default 4), one minute apart — `Title`, then
  `Title (2/4)` … — so one missed buzz is not the end of it. Change the number in `wrangler.jsonc`
  (`vars.PINGS`) and redeploy. Editing or pausing a reminder mid-burst stops the burst.
* **Time zones**: reminders store the wall-clock time plus the IANA zone they were created in and
  fire at that wall-clock time even across DST changes (`public/schedule.js`, shared by server and
  page).
* **Nothing runs on the phone.** Closing the browser, losing signal, or restarting the phone does
  not affect delivery; only Discord's app needs to be installed with notifications enabled.

Why not browser notifications: a web page cannot schedule a notification for later and have it
fire while the browser is closed (the Notification Triggers API was abandoned), and Web Push needs
a server anyway. Why not Supabase/pg_cron: free-tier projects pause after 7 idle days and
`pg_cron` activity does not count, so a paused project silently misses reminders. Cloudflare's
free plan has per-minute cron with no idle pausing.

## Deploy (about 10 minutes, all free tiers)

Prerequisites: Node.js, a Cloudflare account, a Discord server you control.

1. **Discord webhook.** In your Discord server: channel → *Edit channel* → *Integrations* →
   *Webhooks* → *New Webhook*. Name it "Reminders", copy the webhook URL.
   For a guaranteed ping, also copy your user ID (Discord *Settings → Advanced → Developer Mode*,
   then right-click your name → *Copy User ID*). Alternatively set the channel's notification
   setting to *All Messages*.

2. **Log in and create the database.**
   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create reminders
   ```
   Paste the `database_id` it prints into `wrangler.jsonc`, then create the table:
   ```bash
   npm run db:init
   ```

3. **Secrets.** Run each and paste the value when prompted:
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   npx wrangler secret put APP_TOKEN
   npx wrangler secret put DISCORD_USER_ID
   ```
   `APP_TOKEN` is the password you will type once on each device — pick a long random one.
   `DISCORD_USER_ID` is optional (see step 1).

4. **Deploy.**
   ```bash
   npm run deploy
   ```
   Open the printed `https://reminders.<your-subdomain>.workers.dev` URL, enter the token,
   open the gear menu and press *Send test*. A message should appear in Discord within a second.

5. **On the phone:** open the URL in the browser and use *Add to Home Screen*. It installs as an
   app and works offline.

## Everyday use

* Type the reminder, pick date/time and (optionally) a repeat rule, press *Add reminder*.
* Tap a reminder to edit or delete it. Repeating reminders have a switch to pause/resume.
* One-time reminders move to *Sent* after delivery and are cleaned up after 30 days.
* *Upcoming* shows exactly what the server will send next; "Now" means it goes out on the next
  minute tick.

## Development

* `npm test` — recurrence/time-zone tests and scheduler behaviour tests (Node only).
* `npm run dev` — `wrangler dev --test-scheduled` (local D1; trigger the cron with
  `curl -X POST "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`).
* `node dev-local.mjs` — runs the same Worker in plain Node with an in-memory SQLite and a mock
  Discord endpoint, for machines where `workerd` does not run. Token is `dev`.
* `npm run tail` — live logs from the deployed Worker (each cron run and any send failures).

## Upgrading an existing database

If the database was created before the `ping` column existed:
```bash
npx wrangler d1 execute reminders --remote --command "ALTER TABLE reminders ADD COLUMN ping INTEGER NOT NULL DEFAULT 0"
```

## Limits worth knowing

* Cloudflare Free: 100k requests/day, 5 cron triggers per account, 10 ms CPU per cron run.
  A personal list of even a few hundred reminders is nowhere near these.
* The page URL is public but shows nothing without the token. The token is the only auth;
  keep it secret and rotate it with `wrangler secret put APP_TOKEN` if needed.
* Minute granularity: a reminder set for 09:00 is sent at 09:00:00–09:00:59.
