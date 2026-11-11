// VOLTIX Mining API — Cloudflare Pages advanced-mode worker.
// Plain JavaScript, no build step and no npm dependencies.
//
// Bindings:
//   DB               — D1 database (see schema.sql)
//   ASSETS           — provided automatically by Cloudflare Pages
// Optional variables:
//   ALLOWED_DOMAINS  — comma separated list of domains accepted in ton_proof
//                      (default: the host of the incoming request)
//   ALLOW_TESTNET    — "true" to accept testnet wallets

const VERSION = "4.0.0";

// Mining is continuous (24/7): once started it never stops, VOLTIX accrue every
// second at the level's daily rate and can be claimed at any time.
const MINING_DURATION = 24 * 60 * 60;       // the rate is "reward per this many seconds"
const TOKEN_DECIMALS = 1_000_000;
const REFERRAL_PERCENT = 10;                // referrer gets 10% of every claim
const V = n => Math.round(n * TOKEN_DECIMALS); // VOLTIX -> micro units
const MIN_CLAIM = V(0.1);                   // smallest claim (~1.5 minutes of mining)

// Miner upgrades: VOLTIX mined per day and the price of reaching the level.
const MINER_LEVELS = [
  { reward: 100, cost: 0 },
  { reward: 120, cost: 200 },
  { reward: 145, cost: 500 },
  { reward: 175, cost: 1_000 },
  { reward: 210, cost: 2_000 },
  { reward: 250, cost: 4_000 },
  { reward: 300, cost: 8_000 },
  { reward: 360, cost: 15_000 },
  { reward: 430, cost: 30_000 },
  { reward: 520, cost: 60_000 }
];
const levelInfo = lvl => MINER_LEVELS[Math.min(Math.max(lvl || 1, 1), MINER_LEVELS.length) - 1];

// Daily check-in: 10 VOLTIX × streak day, capped at day 7.
const DAILY_BONUS = 10;
const DAILY_MAX_STREAK = 7;

// Withdrawals: requested in the app, paid out manually by an admin (1–24 h).
const WITHDRAW_MIN = V(10_000);
const WITHDRAW_FEE_PERCENT = 5;             // burned, the user receives the rest
const WITHDRAW_COOLDOWN = 48 * 60 * 60;     // one request per 48 h
// Optional variable ADMIN_WALLETS: comma separated raw addresses (0:abc...) allowed
// to approve / reject withdrawals.

// One-time tasks. "Active" friends are invited users who claimed at least one mining reward.
const TASKS = [
  { id: "first_claim", title: "Claim your first mining reward", reward: 25, goal: 1, stat: "claims" },
  { id: "invite_1", title: "Invite 1 active friend", reward: 50, goal: 1, stat: "activeRefs" },
  { id: "invite_3", title: "Invite 3 active friends", reward: 200, goal: 3, stat: "activeRefs" },
  { id: "invite_10", title: "Invite 10 active friends", reward: 1_000, goal: 10, stat: "activeRefs" },
  { id: "streak_7", title: "Check in 7 days in a row", reward: 150, goal: 7, stat: "streak" }
];

const PAYLOAD_TTL = 15 * 60;                // ton_proof payload lifetime
const PROOF_MAX_AGE = 15 * 60;              // max age of a signed proof
const SESSION_TTL = 30 * 24 * 60 * 60;      // login session lifetime

const MAINNET = "-239";
const TESTNET = "-3";

// ---------------------------------------------------------------- helpers

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS }
  });

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const now = () => Math.floor(Date.now() / 1000);

const formatBalance = v => (Number(v || 0) / TOKEN_DECIMALS).toFixed(6);

const enc = new TextEncoder();

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(str) {
  if (!/^([0-9a-fA-F]{2})*$/.test(str)) throw new HttpError("Invalid hex");
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
  return out;
}

function fromBase64(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new HttpError("Invalid JSON body"); }
}

// ---------------------------------------------------------------- TON addresses

function parseRawAddress(raw) {
  const m = /^(-1|0):([0-9a-fA-F]{64})$/.exec(String(raw || ""));
  if (!m) throw new HttpError("Invalid wallet address");
  return { workchain: Number(m[1]), hash: fromHex(m[2]) };
}

function rawAddress(a) {
  return `${a.workchain}:${hex(a.hash)}`;
}

function crc16(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return crc & 0xffff;
}

// User-friendly, non-bounceable (UQ...) form — the one wallets show for user accounts.
function friendlyAddress(raw, testnet = false) {
  const a = parseRawAddress(raw);
  const tag = 0x51 | (testnet ? 0x80 : 0);
  const body = concat(new Uint8Array([tag, a.workchain & 0xff]), a.hash);
  const c = crc16(body);
  return toBase64Url(concat(body, new Uint8Array([c >> 8, c & 0xff])));
}

// ---------------------------------------------------------------- BOC / cells
// Minimal bag-of-cells parser with representation hashes. It handles ordinary
// cells only, which is all a wallet StateInit consists of.

async function parseBoc(bytes) {
  let p = 0;
  const need = n => { if (p + n > bytes.length) throw new HttpError("Invalid state_init"); };
  const uint = n => { need(n); let v = 0; for (let i = 0; i < n; i++) v = v * 256 + bytes[p++]; return v; };

  if (uint(4) !== 0xb5ee9c72) throw new HttpError("Invalid state_init");
  const flags = uint(1);
  const hasIdx = flags & 0x80;
  const size = flags & 0x07;
  const offBytes = uint(1);
  if (size < 1 || size > 4 || offBytes < 1 || offBytes > 8) throw new HttpError("Invalid state_init");

  const cellCount = uint(size);
  const rootCount = uint(size);
  uint(size); // absent
  uint(offBytes); // total cells size
  if (cellCount > 1024 || rootCount < 1) throw new HttpError("Invalid state_init");

  const roots = [];
  for (let i = 0; i < rootCount; i++) roots.push(uint(size));
  if (hasIdx) { need(cellCount * offBytes); p += cellCount * offBytes; }

  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    const d1 = uint(1);
    const d2 = uint(1);
    const refCount = d1 & 7;
    if (refCount > 4 || d1 & 0x08 || d1 & 0x10 || d1 >> 5) {
      throw new HttpError("Unsupported cell in state_init");
    }
    const len = Math.ceil(d2 / 2);
    need(len);
    const data = bytes.slice(p, p + len);
    p += len;

    let bits = len * 8;
    if (d2 & 1) {
      const last = data[len - 1];
      if (!last) throw new HttpError("Invalid state_init");
      let tz = 0;
      while (!(last & (1 << tz))) tz++;
      bits -= tz + 1;
    }

    const refs = [];
    for (let r = 0; r < refCount; r++) {
      const idx = uint(size);
      if (idx <= i || idx >= cellCount) throw new HttpError("Invalid state_init");
      refs.push(idx);
    }
    cells.push({ d1: refCount, d2, data, bits, refIdx: refs, refs: [], depth: 0, hash: null });
  }

  // Children always have bigger indexes, so hash from the end.
  for (let i = cellCount - 1; i >= 0; i--) {
    const c = cells[i];
    c.refs = c.refIdx.map(idx => cells[idx]);
    c.depth = c.refs.length ? Math.max(...c.refs.map(r => r.depth)) + 1 : 0;
    const depths = c.refs.flatMap(r => [r.depth >> 8, r.depth & 0xff]);
    c.hash = await sha256(concat(
      new Uint8Array([c.d1, c.d2]),
      c.data,
      new Uint8Array(depths),
      ...c.refs.map(r => r.hash)
    ));
  }

  if (roots[0] >= cellCount) throw new HttpError("Invalid state_init");
  return cells[roots[0]];
}

function bitReader(cell) {
  let pos = 0;
  let ref = 0;
  return {
    bit() {
      if (pos >= cell.bits) throw new HttpError("Invalid state_init");
      const b = (cell.data[pos >> 3] >> (7 - (pos & 7))) & 1;
      pos++;
      return b;
    },
    skip(n) {
      if (pos + n > cell.bits) throw new HttpError("Invalid state_init");
      pos += n;
    },
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | this.bit();
        out[i] = v;
      }
      return out;
    },
    ref() {
      if (ref >= cell.refs.length) throw new HttpError("Invalid state_init");
      return cell.refs[ref++];
    }
  };
}

// Reads the public key from the data cell of a standard wallet (v1–v5).
// Safety: the StateInit hash is checked against the wallet address, so the data
// cell is exactly the wallet's own one and the key can't be forged.
function walletPublicKey(dataCell) {
  const skipByLayout = {
    288: 32,          // v1, v2: seqno, pubkey
    320: 64,          // v3: seqno, wallet_id, pubkey
    321: 64,          // v4: seqno, wallet_id, pubkey, plugins
    322: 65,          // v5r1: signature_allowed, seqno, wallet_id, pubkey, plugins
    370: 113          // v5 beta: signature_allowed, seqno, wallet_id(80), pubkey, plugins
  };
  const skip = skipByLayout[dataCell.bits];
  if (skip === undefined) throw new HttpError("Unsupported wallet type");
  const r = bitReader(dataCell);
  r.skip(skip);
  return r.bytes(32);
}

async function stateInitInfo(stateInitBase64) {
  const root = await parseBoc(fromBase64(stateInitBase64));
  const r = bitReader(root);
  if (r.bit()) r.skip(5);  // split_depth
  if (r.bit()) r.skip(2);  // special
  if (r.bit()) r.ref();    // code
  if (!r.bit()) throw new HttpError("state_init has no data");
  const data = r.ref();
  return { hash: root.hash, publicKey: walletPublicKey(data) };
}

// ---------------------------------------------------------------- ton_proof

async function verifyEd25519(publicKey, signature, message) {
  for (const algo of [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }]) {
    let key;
    try {
      key = await crypto.subtle.importKey("raw", publicKey, algo, false, ["verify"]);
    } catch {
      continue;
    }
    return crypto.subtle.verify(algo, key, signature, message);
  }
  throw new Error("Ed25519 is not supported by this runtime");
}

async function verifyTonProof(body, request, env, db) {
  const proof = body.proof || {};
  const address = parseRawAddress(body.address);

  const network = String(body.network ?? MAINNET);
  if (network !== MAINNET && !(network === TESTNET && env.ALLOW_TESTNET === "true")) {
    throw new HttpError("Unsupported network");
  }

  // Domain
  const domain = String(proof.domain?.value || "");
  const allowed = env.ALLOWED_DOMAINS
    ? env.ALLOWED_DOMAINS.split(",").map(s => s.trim()).filter(Boolean)
    : [new URL(request.url).host];
  if (!allowed.includes(domain)) throw new HttpError("Wrong proof domain", 401);

  // Timestamp
  const ts = Number(proof.timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > PROOF_MAX_AGE) {
    throw new HttpError("Proof expired", 401);
  }

  // Payload — must be one we issued, single use
  const payload = String(proof.payload || "");
  const used = await db.prepare(
    "DELETE FROM login_payloads WHERE payload = ? AND expires_at > ?"
  ).bind(payload, now()).run();
  if (!used.meta.changes) throw new HttpError("Unknown or expired payload", 401);

  // Wallet key from StateInit, bound to the address
  const info = await stateInitInfo(proof.state_init);
  if (!equalBytes(info.hash, address.hash)) {
    throw new HttpError("state_init does not match address", 401);
  }
  if (body.public_key && body.public_key.toLowerCase() !== hex(info.publicKey)) {
    throw new HttpError("Public key mismatch", 401);
  }

  // Signature
  const wc = new Uint8Array(4);
  new DataView(wc.buffer).setInt32(0, address.workchain, false);
  const domainBytes = enc.encode(domain);
  const domainLen = new Uint8Array(4);
  new DataView(domainLen.buffer).setUint32(0, domainBytes.length, true);
  const tsBytes = new Uint8Array(8);
  new DataView(tsBytes.buffer).setBigUint64(0, BigInt(ts), true);

  const message = concat(
    enc.encode("ton-proof-item-v2/"), wc, address.hash,
    domainLen, domainBytes, tsBytes, enc.encode(payload)
  );
  const full = concat(new Uint8Array([0xff, 0xff]), enc.encode("ton-connect"), await sha256(message));
  const ok = await verifyEd25519(info.publicKey, fromBase64(proof.signature || ""), await sha256(full));
  if (!ok) throw new HttpError("Invalid proof signature", 401);

  return { raw: rawAddress(address), testnet: network === TESTNET };
}

// ---------------------------------------------------------------- Telegram

const APP_URL = "https://voltix-mining.pages.dev";
const INIT_DATA_MAX_AGE = 24 * 60 * 60;

async function hmacSha256(key, message) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, message));
}

// Secret Telegram must send with every webhook call; derived from the token
// so the notifier worker can register the webhook with the same value.
async function webhookSecret(botToken) {
  return hex(await sha256(enc.encode("voltix-webhook:" + botToken))).slice(0, 48);
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(String(initData || ""));
  const hash = params.get("hash") || "";
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmacSha256(enc.encode("WebAppData"), enc.encode(botToken));
  const expected = hex(await hmacSha256(secret, enc.encode(check)));
  if (!/^[0-9a-f]{64}$/.test(hash) || !equalBytes(fromHex(expected), fromHex(hash))) {
    throw new HttpError("Invalid Telegram data", 401);
  }
  if (now() - Number(params.get("auth_date")) > INIT_DATA_MAX_AGE) {
    throw new HttpError("Telegram data expired", 401);
  }
  const user = JSON.parse(params.get("user") || "null");
  if (!user || !Number.isSafeInteger(user.id)) throw new HttpError("No Telegram user", 400);
  return user;
}

async function tgCall(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({ ok: false }));
}

async function handleTelegramUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private" || typeof msg.text !== "string") return;
  if (!msg.text.startsWith("/start")) return;

  // t.me/VoltixMiningBot?start=V1 → pass the referral code into the app
  const ref = /^\/start\s+(V[0-9A-Za-z]{1,10})$/.exec(msg.text.trim());
  const url = ref ? `${APP_URL}/?ref=${ref[1]}` : APP_URL;

  await tgCall(env.BOT_TOKEN, "sendMessage", {
    chat_id: msg.chat.id,
    text:
      "⚡ <b>Welcome to VOLTIX Mining!</b>\n\n" +
      "Connect your TON wallet, start the miner and claim VOLTIX every 24 hours.\n" +
      "Upgrade your miner, complete tasks and invite friends for +10%.\n\n" +
      "Your miner works 24/7 — I'll remind you here to collect your VOLTIX.",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⛏ Open VOLTIX", web_app: { url } }]] }
  });
}

// ---------------------------------------------------------------- users & sessions

const refCode = id => "V" + Number(id).toString(36).toUpperCase();

function refCodeToId(code) {
  const m = /^V([0-9A-Z]{1,10})$/i.exec(String(code || ""));
  return m ? parseInt(m[1], 36) : null;
}

async function authUser(request, db) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError("Unauthorized", 401);

  const tokenHash = hex(await sha256(enc.encode(token)));
  const user = await db.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, now()).first();
  if (!user) throw new HttpError("Unauthorized", 401);
  return { user, tokenHash };
}

// VOLTIX (micro) mined since the last claim.
function accrued(user, t = now()) {
  if (!user.mining_since) return 0;
  const perDay = V(levelInfo(user.miner_level).reward);
  return Math.floor(Math.max(t - user.mining_since, 0) * perDay / MINING_DURATION);
}

function miningView(user, t = now()) {
  const perDay = V(levelInfo(user.miner_level).reward);
  if (!user.mining_since) {
    return { state: "idle", now: t, per_day: formatBalance(perDay), min_claim: formatBalance(MIN_CLAIM) };
  }
  const mined = accrued(user, t);
  return {
    state: "mining",
    since: user.mining_since,
    now: t,
    per_day: formatBalance(perDay),
    mined: formatBalance(mined),
    claimable: mined >= MIN_CLAIM,
    min_claim: formatBalance(MIN_CLAIM)
  };
}

async function profile(db, user) {
  const [refs, refEarned] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = ?").bind(user.id).first(),
    db.prepare(
      "SELECT COALESCE(SUM(amount_micro), 0) AS total FROM transactions WHERE user_id = ? AND type = 'referral_bonus'"
    ).bind(user.id).first()
  ]);

  const level = user.miner_level || 1;
  const next = level < MINER_LEVELS.length ? MINER_LEVELS[level] : null;
  const today = dayNumber();
  const streakAlive = user.last_checkin_day >= today - 1;

  return {
    wallet: user.wallet_address,
    wallet_friendly: friendlyAddress(user.wallet_address),
    balance: formatBalance(user.balance_micro),
    created_at: user.created_at,
    ref_code: refCode(user.id),
    referrals: refs.total,
    referral_earned: formatBalance(refEarned.total),
    telegram_linked: !!user.telegram_id,
    mining: miningView(user),
    miner: {
      level,
      max_level: MINER_LEVELS.length,
      reward: formatBalance(V(levelInfo(level).reward)),
      next: next && {
        level: level + 1,
        reward: formatBalance(V(next.reward)),
        cost: formatBalance(V(next.cost))
      }
    },
    checkin: {
      available: !(user.last_checkin_day >= today),
      streak: streakAlive ? user.streak || 0 : 0,
      next_bonus: formatBalance(V(DAILY_BONUS * Math.min((streakAlive ? user.streak || 0 : 0) + 1, DAILY_MAX_STREAK))),
      next_reset: (today + 1) * 86400
    },
    config: {
      duration: MINING_DURATION,
      reward: formatBalance(V(levelInfo(level).reward)),
      referral_percent: REFERRAL_PERCENT
    }
  };
}

const dayNumber = (t = now()) => Math.floor(t / 86400);   // UTC day

async function taskStats(db, user) {
  const [claims, active] = await Promise.all([
    db.prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND type = 'mining_reward'"
    ).bind(user.id).first(),
    db.prepare(`
      SELECT COUNT(*) AS n FROM referrals r
      WHERE r.referrer_id = ? AND EXISTS (
        SELECT 1 FROM transactions t WHERE t.user_id = r.referred_id AND t.type = 'mining_reward'
      )
    `).bind(user.id).first()
  ]);
  const streak = user.last_checkin_day >= dayNumber() - 1 ? user.streak || 0 : 0;
  return { claims: claims.n, activeRefs: active.n, level: user.miner_level || 1, streak };
}

async function credit(db, userId, amountMicro, type, t = now()) {
  await db.batch([
    db.prepare("UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?").bind(amountMicro, userId),
    db.prepare(
      "INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, ?, ?)"
    ).bind(userId, amountMicro, type, t)
  ]);
}

async function freshProfile(db, userId) {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  return profile(db, user);
}

// ---------------------------------------------------------------- withdrawals

// "12345.5" -> micro units; up to 6 decimals.
function parseAmount(v) {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new HttpError("Invalid amount");
  return Number(m[1]) * TOKEN_DECIMALS + Number((m[2] || "").padEnd(6, "0"));
}

function isAdmin(env, user) {
  const list = String(env.ADMIN_WALLETS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(user.wallet_address).toLowerCase());
}

async function requireAdmin(request, env, db) {
  const auth = await authUser(request, db);
  if (!isAdmin(env, auth.user)) throw new HttpError("Forbidden", 403);
  return auth;
}

function withdrawalView(w) {
  return {
    id: w.id,
    amount: formatBalance(w.amount_micro),
    fee: formatBalance(w.fee_micro),
    net: formatBalance(w.net_micro),
    wallet: friendlyAddress(w.wallet_address),
    status: w.status,
    created_at: w.created_at,
    processed_at: w.processed_at,
    tx_hash: w.tx_hash
  };
}

async function notifyTelegram(env, telegramId, text) {
  if (!env.BOT_TOKEN || !telegramId) return;
  try {
    await tgCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: telegramId, text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Open VOLTIX", web_app: { url: APP_URL } }]] }
    });
  } catch (e) { console.warn("telegram notify failed", e.message); }
}

// ---------------------------------------------------------------- routes

const routes = {
  "GET /api/status": async () => ({
    status: "online", project: "VOLTIX", database: true, version: VERSION
  }),

  "GET /api/health": async () => ({ status: "healthy", service: "VOLTIX Mining API" }),

  // 1. Client asks for a payload, passes it to TON Connect as tonProof.
  "POST /api/auth/payload": async ({ db }) => {
    const t = now();
    const payload = randomHex(32);
    await db.batch([
      db.prepare("DELETE FROM login_payloads WHERE expires_at <= ?").bind(t),
      db.prepare("INSERT INTO login_payloads (payload, expires_at) VALUES (?, ?)").bind(payload, t + PAYLOAD_TTL)
    ]);
    return { payload, expires_in: PAYLOAD_TTL };
  },

  // 2. Client sends the signed proof, gets a session token.
  "POST /api/auth/verify": async ({ request, env, db }) => {
    const body = await readJson(request);
    const { raw } = await verifyTonProof(body, request, env, db);
    const t = now();

    const inserted = await db.prepare(
      // New accounts start mining right away.
      "INSERT OR IGNORE INTO users (wallet_address, balance_micro, created_at, mining_since) VALUES (?, 0, ?, ?)"
    ).bind(raw, t, t).run();
    const user = await db.prepare("SELECT * FROM users WHERE wallet_address = ?").bind(raw).first();

    // Referral is only attached when the account is brand new.
    const referrerId = refCodeToId(body.referral);
    if (inserted.meta.changes && referrerId && referrerId !== user.id) {
      const referrer = await db.prepare("SELECT id FROM users WHERE id = ?").bind(referrerId).first();
      if (referrer) {
        await db.prepare(
          "INSERT OR IGNORE INTO referrals (referrer_id, referred_id, created_at) VALUES (?, ?, ?)"
        ).bind(referrer.id, user.id, t).run();
      }
    }

    const token = randomHex(32);
    const tokenHash = hex(await sha256(enc.encode(token)));
    await db.batch([
      db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").bind(t),
      db.prepare(
        "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(tokenHash, user.id, t, t + SESSION_TTL)
    ]);

    return { token, expires_in: SESSION_TTL, user: await profile(db, user) };
  },

  "POST /api/auth/logout": async ({ request, db }) => {
    const { tokenHash } = await authUser(request, db);
    await db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return { message: "Logged out" };
  },

  "GET /api/me": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    return { user: await profile(db, user) };
  },

  // Switches the miner on (once — it then runs forever).
  "POST /api/mining/start": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    const started = await db.prepare(
      "UPDATE users SET mining_since = ? WHERE id = ? AND mining_since IS NULL"
    ).bind(t, user.id).run();
    const fresh = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return {
      message: started.meta.changes ? "Mining started" : "Mining already active",
      mining: miningView(fresh, t)
    };
  },

  // Moves everything mined so far to the balance; mining keeps running.
  "POST /api/mining/claim": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    if (!user.mining_since) throw new HttpError("Mining is not started", 409);

    const reward = accrued(user, t);
    if (reward < MIN_CLAIM) {
      throw new HttpError(`Nothing to claim yet (minimum ${formatBalance(MIN_CLAIM)} VOLTIX)`, 409);
    }

    // Atomic guard: only the request that still sees the old mining_since wins.
    const claimed = await db.prepare(`
      UPDATE users SET mining_since = ?, balance_micro = balance_micro + ?, reminded_at = NULL
      WHERE id = ? AND mining_since = ?
    `).bind(t, reward, user.id, user.mining_since).run();
    if (!claimed.meta.changes) throw new HttpError("Reward already claimed", 409);

    const statements = [
      db.prepare(
        "INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, 'mining_reward', ?)"
      ).bind(user.id, reward, t)
    ];

    const ref = await db.prepare("SELECT referrer_id FROM referrals WHERE referred_id = ?").bind(user.id).first();
    const bonus = Math.floor(reward * REFERRAL_PERCENT / 100);
    if (ref && bonus > 0) {
      statements.push(
        db.prepare("UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?").bind(bonus, ref.referrer_id),
        db.prepare(
          "INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, 'referral_bonus', ?)"
        ).bind(ref.referrer_id, bonus, t)
      );
    }
    await db.batch(statements);

    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return {
      message: "Reward claimed",
      reward: formatBalance(reward),
      balance: formatBalance(updated.balance_micro),
      user: await profile(db, updated)
    };
  },

  // Mini App sends Telegram initData; we store the Telegram user id for notifications.
  "POST /api/telegram/link": async ({ request, env, db }) => {
    const { user } = await authUser(request, db);
    if (!env.BOT_TOKEN) throw new HttpError("Telegram bot is not configured", 503);
    const body = await readJson(request);
    const tgUser = await verifyInitData(body.init_data, env.BOT_TOKEN);
    await db.batch([
      // One Telegram account ↔ one wallet: move the link if it was elsewhere.
      db.prepare("UPDATE users SET telegram_id = NULL WHERE telegram_id = ? AND id <> ?").bind(tgUser.id, user.id),
      db.prepare("UPDATE users SET telegram_id = ? WHERE id = ?").bind(tgUser.id, user.id)
    ]);
    return { message: "Telegram linked" };
  },

  // Bot health check (no secrets): bot username, webhook target and Telegram's last delivery error.
  // Re-registers the webhook and menu button if they don't point here.
  "GET /api/telegram/status": async ({ env }) => {
    if (!env.BOT_TOKEN) throw new HttpError("Telegram bot is not configured", 503);
    const me = await tgCall(env.BOT_TOKEN, "getMe", {});
    if (!me.ok) return { bot: null, error: me.description || "getMe failed (token invalid?)" };
    const hookUrl = `${APP_URL}/api/telegram/webhook`;
    let info = await tgCall(env.BOT_TOKEN, "getWebhookInfo", {});
    let setup = null;
    if (!info.ok || info.result.url !== hookUrl) {
      const set = await tgCall(env.BOT_TOKEN, "setWebhook", {
        url: hookUrl, secret_token: await webhookSecret(env.BOT_TOKEN), allowed_updates: ["message"]
      });
      const menu = await tgCall(env.BOT_TOKEN, "setChatMenuButton", {
        menu_button: { type: "web_app", text: "Open VOLTIX", web_app: { url: APP_URL } }
      });
      setup = { webhook: set.ok || set.description, menu: menu.ok || menu.description };
      info = await tgCall(env.BOT_TOKEN, "getWebhookInfo", {});
    }
    const w = info.result || {};
    return {
      bot: me.result.username,
      webhook: w.url || null,
      pending_updates: w.pending_update_count || 0,
      last_error: w.last_error_message || null,
      last_error_at: w.last_error_date || null,
      setup
    };
  },

  // Bot webhook (registered automatically by the notifier worker).
  "POST /api/telegram/webhook": async ({ request, env }) => {
    if (!env.BOT_TOKEN) throw new HttpError("Not configured", 503);
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (got !== await webhookSecret(env.BOT_TOKEN)) throw new HttpError("Forbidden", 403);
    await handleTelegramUpdate(await readJson(request), env);
    return {};
  },

  // Wallet tab: rules, cooldown, totals and the user's withdrawal history.
  "GET /api/withdrawals": async ({ request, env, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    const [{ results }, last, paid] = await Promise.all([
      db.prepare("SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50").bind(user.id).all(),
      db.prepare(
        "SELECT MAX(created_at) AS t FROM withdrawals WHERE user_id = ? AND status <> 'rejected'"
      ).bind(user.id).first(),
      db.prepare(
        "SELECT COALESCE(SUM(net_micro), 0) AS total FROM withdrawals WHERE user_id = ? AND status = 'paid'"
      ).bind(user.id).first()
    ]);
    const pending = results.some(w => w.status === "pending");
    const nextAt = last.t ? last.t + WITHDRAW_COOLDOWN : 0;
    return {
      balance: formatBalance(user.balance_micro),
      wallet: friendlyAddress(user.wallet_address),
      total_withdrawn: formatBalance(paid.total),
      pending,
      next_available_at: nextAt > t ? nextAt : null,
      now: t,
      rules: {
        min: formatBalance(WITHDRAW_MIN),
        fee_percent: WITHDRAW_FEE_PERCENT,
        cooldown_hours: WITHDRAW_COOLDOWN / 3600,
        processing: "1–24 hours"
      },
      is_admin: isAdmin(env, user),
      withdrawals: results.map(withdrawalView)
    };
  },

  "POST /api/withdraw": async ({ request, env, db }) => {
    const { user } = await authUser(request, db);
    const body = await readJson(request);
    const amount = parseAmount(body.amount);
    if (amount < WITHDRAW_MIN) throw new HttpError(`Minimum withdrawal is ${formatBalance(WITHDRAW_MIN)} VOLTIX`);
    const t = now();

    const last = await db.prepare(
      "SELECT MAX(created_at) AS t FROM withdrawals WHERE user_id = ? AND status <> 'rejected'"
    ).bind(user.id).first();
    if (last.t && t - last.t < WITHDRAW_COOLDOWN) {
      throw new HttpError("Only one withdrawal per 48 hours", 409);
    }

    const fee = Math.floor(amount * WITHDRAW_FEE_PERCENT / 100);
    // The partial unique index allows a single pending request per user.
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO withdrawals (user_id, amount_micro, fee_micro, net_micro, wallet_address, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).bind(user.id, amount, fee, amount - fee, user.wallet_address, t).run();
    if (!inserted.meta.changes) throw new HttpError("You already have a withdrawal in progress", 409);
    const id = inserted.meta.last_row_id;

    const paid = await db.prepare(
      "UPDATE users SET balance_micro = balance_micro - ? WHERE id = ? AND balance_micro >= ?"
    ).bind(amount, user.id, amount).run();
    if (!paid.meta.changes) {
      await db.prepare("DELETE FROM withdrawals WHERE id = ?").bind(id).run();
      throw new HttpError("Not enough VOLTIX", 409);
    }
    await db.prepare(
      "INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, 'withdrawal', ?)"
    ).bind(user.id, -amount, t).run();

    const w = await db.prepare("SELECT * FROM withdrawals WHERE id = ?").bind(id).first();
    return {
      message: "Withdrawal requested",
      withdrawal: withdrawalView(w),
      user: await freshProfile(db, user.id)
    };
  },

  // Admin: requests waiting for payout (oldest first) and the latest processed ones.
  "GET /api/admin/withdrawals": async ({ request, env, db }) => {
    await requireAdmin(request, env, db);
    const [pending, recent] = await Promise.all([
      db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id LIMIT 100").all(),
      db.prepare("SELECT * FROM withdrawals WHERE status <> 'pending' ORDER BY processed_at DESC LIMIT 30").all()
    ]);
    return { pending: pending.results.map(withdrawalView), recent: recent.results.map(withdrawalView) };
  },

  // Admin: { id, action: "paid", tx_hash? } after sending the coins, or { id, action: "reject" } (refunds).
  "POST /api/admin/withdrawals/process": async ({ request, env, db }) => {
    await requireAdmin(request, env, db);
    const body = await readJson(request);
    const id = Number(body.id);
    if (!Number.isSafeInteger(id)) throw new HttpError("Invalid id");
    if (body.action !== "paid" && body.action !== "reject") throw new HttpError("Invalid action");
    const txHash = body.tx_hash ? String(body.tx_hash).trim().slice(0, 200) : null;
    const t = now();

    const status = body.action === "paid" ? "paid" : "rejected";
    const done = await db.prepare(
      "UPDATE withdrawals SET status = ?, processed_at = ?, tx_hash = ? WHERE id = ? AND status = 'pending'"
    ).bind(status, t, txHash, id).run();
    if (!done.meta.changes) throw new HttpError("Withdrawal is not pending", 409);

    const w = await db.prepare("SELECT * FROM withdrawals WHERE id = ?").bind(id).first();
    const owner = await db.prepare("SELECT telegram_id FROM users WHERE id = ?").bind(w.user_id).first();
    if (status === "rejected") {
      await credit(db, w.user_id, w.amount_micro, "withdrawal_refund", t);
      await notifyTelegram(env, owner && owner.telegram_id,
        `↩️ Your withdrawal of <b>${Number(formatBalance(w.amount_micro)).toLocaleString("en-US")} VOLTIX</b> was declined. The coins are back on your balance.`);
    } else {
      await notifyTelegram(env, owner && owner.telegram_id,
        `✅ <b>Withdrawal sent!</b>\n\n${Number(formatBalance(w.net_micro)).toLocaleString("en-US")} VOLTIX are on the way to your wallet.`);
    }
    return { message: status === "paid" ? "Marked as paid" : "Rejected and refunded", withdrawal: withdrawalView(w) };
  },

  "POST /api/upgrade": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const level = user.miner_level || 1;
    if (level >= MINER_LEVELS.length) throw new HttpError("Miner is already at max level", 409);
    const cost = V(MINER_LEVELS[level].cost);
    const t = now();

    // Atomic: only succeeds if the level is unchanged and the balance covers the price.
    const done = await db.prepare(`
      UPDATE users SET balance_micro = balance_micro - ?, miner_level = ?
      WHERE id = ? AND COALESCE(miner_level, 1) = ? AND balance_micro >= ?
    `).bind(cost, level + 1, user.id, level, cost).run();
    if (!done.meta.changes) throw new HttpError("Not enough VOLTIX", 409);

    await db.prepare(
      "INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, 'upgrade', ?)"
    ).bind(user.id, -cost, t).run();

    return { message: `Miner upgraded to level ${level + 1}`, user: await freshProfile(db, user.id) };
  },

  "POST /api/checkin": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    const today = dayNumber(t);

    const done = await db.prepare(`
      UPDATE users SET
        streak = CASE WHEN last_checkin_day = ? THEN MIN(COALESCE(streak, 0) + 1, 100000) ELSE 1 END,
        last_checkin_day = ?
      WHERE id = ? AND (last_checkin_day IS NULL OR last_checkin_day < ?)
    `).bind(today - 1, today, user.id, today).run();
    if (!done.meta.changes) throw new HttpError("Already checked in today", 409);

    const { streak } = await db.prepare("SELECT streak FROM users WHERE id = ?").bind(user.id).first();
    const bonus = V(DAILY_BONUS * Math.min(streak, DAILY_MAX_STREAK));
    await credit(db, user.id, bonus, "daily_bonus", t);

    return { message: "Daily bonus claimed", bonus: formatBalance(bonus), streak, user: await freshProfile(db, user.id) };
  },

  "GET /api/tasks": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const [stats, claimed] = await Promise.all([
      taskStats(db, user),
      db.prepare("SELECT task_id FROM user_tasks WHERE user_id = ?").bind(user.id).all()
    ]);
    const done = new Set(claimed.results.map(r => r.task_id));
    return {
      tasks: TASKS.map(task => ({
        id: task.id,
        title: task.title,
        reward: formatBalance(V(task.reward)),
        progress: Math.min(stats[task.stat], task.goal),
        goal: task.goal,
        claimed: done.has(task.id),
        claimable: !done.has(task.id) && stats[task.stat] >= task.goal
      }))
    };
  },

  "POST /api/tasks/claim": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const body = await readJson(request);
    const task = TASKS.find(x => x.id === body.task_id);
    if (!task) throw new HttpError("Unknown task", 404);

    const stats = await taskStats(db, user);
    if (stats[task.stat] < task.goal) throw new HttpError("Task is not completed yet", 409);

    const t = now();
    const ins = await db.prepare(
      "INSERT OR IGNORE INTO user_tasks (user_id, task_id, claimed_at) VALUES (?, ?, ?)"
    ).bind(user.id, task.id, t).run();
    if (!ins.meta.changes) throw new HttpError("Task reward already claimed", 409);

    await credit(db, user.id, V(task.reward), "task_reward", t);
    return { message: "Task reward claimed", reward: formatBalance(V(task.reward)), user: await freshProfile(db, user.id) };
  },

  "GET /api/leaderboard": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const [top, rank] = await Promise.all([
      db.prepare(
        "SELECT id, wallet_address, balance_micro, miner_level FROM users ORDER BY balance_micro DESC, id ASC LIMIT 50"
      ).all(),
      db.prepare(
        "SELECT COUNT(*) + 1 AS rank FROM users WHERE balance_micro > ? OR (balance_micro = ? AND id < ?)"
      ).bind(user.balance_micro, user.balance_micro, user.id).first()
    ]);
    return {
      my_rank: rank.rank,
      top: top.results.map((u, i) => ({
        rank: i + 1,
        wallet: friendlyAddress(u.wallet_address),
        balance: formatBalance(u.balance_micro),
        level: u.miner_level || 1,
        me: u.id === user.id
      }))
    };
  },

  "GET /api/referrals": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const list = await db.prepare(`
      SELECT u.wallet_address, r.created_at FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ?
      ORDER BY r.id DESC LIMIT 100
    `).bind(user.id).all();
    return {
      ref_code: refCode(user.id),
      total_referrals: list.results.length,
      referrals: list.results.map(r => ({
        wallet: friendlyAddress(r.wallet_address),
        created_at: r.created_at
      }))
    };
  },

  "GET /api/transactions": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const result = await db.prepare(`
      SELECT amount_micro, type, created_at FROM transactions
      WHERE user_id = ? ORDER BY id DESC LIMIT 50
    `).bind(user.id).all();
    return {
      transactions: result.results.map(tx => ({
        amount: formatBalance(tx.amount_micro),
        type: tx.type,
        created_at: tx.created_at
      }))
    };
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) return json({ success: false, error: "Endpoint not found" }, 404);
    if (!env.DB) return json({ success: false, error: "Database unavailable" }, 500);

    try {
      const data = await handler({ request, env, db: env.DB, url });
      return json({ success: true, ...data });
    } catch (err) {
      if (err instanceof HttpError) {
        if (url.pathname.startsWith("/api/auth/")) console.warn(`${url.pathname}: ${err.message}`);
        return json({ success: false, error: err.message }, err.status);
      }
      console.error(err);
      return json({ success: false, error: "Internal server error" }, 500);
    }
  }
};
