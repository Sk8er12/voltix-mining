# VOLTIX Mining

Telegram / web mini-app on the TON ecosystem: the user connects a TON wallet and the miner runs
24/7 — 100 VOLTIX points per day accrue every second and can be claimed at any time. Friends
bring a 10% bonus on everything they claim.

Hosted on **Cloudflare Pages** (static files + `_worker.js` API) with a **D1** database.
No build step — plain HTML/JS.

## Structure

```
public/
  index.html               app UI (TON Connect login, mining, friends, history)
  _worker.js               API (Cloudflare Pages advanced mode)
  tonconnect-manifest.json TON Connect manifest
  icon.png                 app icon
  terms.html, privacy.html legal pages (referenced in the manifest)
schema.sql                 D1 tables
wrangler.toml              Pages + D1 configuration
```

## Deploy

1. Create the database (once) and put its id into `wrangler.toml`:
   ```bash
   npx wrangler d1 create voltaic-db
   ```
2. Create the tables:
   ```bash
   npx wrangler d1 execute voltaic-db --remote --file=schema.sql
   ```
3. Deploy:
   ```bash
   npx wrangler pages deploy
   ```
   Or connect the GitHub repo in the Cloudflare dashboard → Pages, with
   **Build command:** *(empty)* and **Build output directory:** `public`.
   In *Settings → Bindings* add a D1 binding named `DB` → `voltaic-db`.

If the site is served from a domain other than the one in `tonconnect-manifest.json`, update the
manifest URLs, and (optionally) set the `ALLOWED_DOMAINS` variable.

### Telegram Mini App

Create a bot with @BotFather → `/newapp`, point it to your Pages URL, then set
`TELEGRAM_APP_URL` at the top of the script in `public/index.html`
(e.g. `https://t.me/VoltixBot/app`) so invite links open inside Telegram
(`?startapp=<code>` is used as the referral code).

### Telegram bot & notifications

Bot: `@VoltixMiningBot`, Mini App: `https://t.me/VoltixMiningBot/VTX`.

- The app links the Telegram account (validated `initData`) via `POST /api/telegram/link`.
- `notifier/` is a separate Worker on a 10-minute cron: it keeps the bot webhook
  (`/api/telegram/webhook`, answers `/start`) and menu button set, and reminds users who
  haven't collected their mining for a day (at most once a day).

The bot token is a secret in both places (never in git):

```bash
npx wrangler pages secret put BOT_TOKEN --project-name voltix-mining
```
```bash
npx wrangler secret put BOT_TOKEN --name voltix-notifier
```

Deploy the notifier: `cd notifier && npx wrangler deploy`.

### Admin (withdrawal approval)

Wallets that can approve payouts are listed (raw form, comma separated) in `ADMIN_WALLETS`.
Store it as a **secret** — plain variables set in the dashboard are replaced on every
`wrangler pages deploy` because `wrangler.toml` is the source of truth:

```bash
npx wrangler pages secret put ADMIN_WALLETS --project-name voltix-mining
```

## Local development

```bash
npm install
npm run db:init:local
npm run dev
```

## API

All responses are JSON `{ success, ... }`. Authenticated routes need `Authorization: Bearer <token>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET  | `/api/status`, `/api/health` | – | service status |
| POST | `/api/auth/payload` | – | one-time `ton_proof` payload (15 min) |
| POST | `/api/auth/verify` | – | verify signed `ton_proof`, create user, returns `token` |
| POST | `/api/auth/logout` | ✓ | end session |
| GET  | `/api/me` | ✓ | profile, balance, mining state, referral stats |
| POST | `/api/mining/start` | ✓ | switch the miner on (new accounts start automatically; it never stops) |
| POST | `/api/mining/claim` | ✓ | collect everything mined so far, min 0.1 (+10% to the referrer) |
| POST | `/api/holding/refresh` | ✓ | re-read the VTX held in the wallet now; level 1–10 (100 → 520 VOLTIX/day) depends on it |
| GET  | `/api/withdrawals` | ✓ | wallet tab: rules, cooldown, history, VTX token info |
| POST | `/api/withdraw` | ✓ | `{ amount }` request a payout (min 10,000, 5% fee, 1 per 48 h) |
| GET/POST | `/api/admin/withdrawals[/process]` | admin | pending payouts; mark paid / reject (refund) |
| POST | `/api/checkin` | ✓ | daily bonus: 10 VOLTIX × streak day (max 70) |
| GET  | `/api/tasks` | ✓ | one-time tasks with progress |
| POST | `/api/tasks/claim` | ✓ | `{ task_id }` claim a completed task |
| GET  | `/api/leaderboard` | ✓ | top 50 by balance + your rank |
| GET  | `/api/referrals` | ✓ | invited users |
| GET  | `/api/transactions` | ✓ | last 50 transactions |

### Security

Login uses TON Connect **ton_proof**: the server issues a one-time payload, the wallet signs it,
and the worker checks the domain, timestamp, that `walletStateInit` hashes to the wallet address,
and the Ed25519 signature. Only then is a session token issued (stored hashed in D1). Nobody can
mine or claim for a wallet they don't own.

Tune rewards in the constants at the top of `public/_worker.js`
(`MINER_LEVELS` daily rates, `MIN_CLAIM`, `REFERRAL_PERCENT`).

Existing databases: apply the migrations in `migrations/` in order (0004 switches to 24/7 mining).
