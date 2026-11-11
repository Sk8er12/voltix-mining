# VOLTIX Mining

Telegram / web mini-app on the TON ecosystem: the user connects a TON wallet, starts a 24-hour
"mining" session, claims 100 VOLTIX points afterwards and invites friends for a 10% bonus.

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
| POST | `/api/mining/start` | ✓ | start a 24h session |
| POST | `/api/mining/claim` | ✓ | claim finished session (+10% to the referrer) |
| GET  | `/api/referrals` | ✓ | invited users |
| GET  | `/api/transactions` | ✓ | last 50 transactions |

### Security

Login uses TON Connect **ton_proof**: the server issues a one-time payload, the wallet signs it,
and the worker checks the domain, timestamp, that `walletStateInit` hashes to the wallet address,
and the Ed25519 signature. Only then is a session token issued (stored hashed in D1). Nobody can
mine or claim for a wallet they don't own.

Tune rewards in the constants at the top of `public/_worker.js`
(`MINING_DURATION`, `MINING_REWARD`, `REFERRAL_PERCENT`).
