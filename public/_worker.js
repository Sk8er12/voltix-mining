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

const VERSION = "3.0.0";

const MINING_DURATION = 24 * 60 * 60;       // seconds
const MINING_REWARD = 100_000_000;          // 100 VOLTIX (micro units)
const TOKEN_DECIMALS = 1_000_000;
const REFERRAL_PERCENT = 10;                // referrer gets 10% of every claim

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

async function activeSession(db, userId) {
  return db.prepare(`
    SELECT * FROM mining_sessions
    WHERE user_id = ? AND claimed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).bind(userId).first();
}

function miningView(session, t = now()) {
  if (!session) return { state: "idle", now: t };
  const total = session.ends_at - session.started_at;
  const done = Math.min(Math.max(t - session.started_at, 0), total);
  return {
    state: session.ends_at <= t ? "ready" : "mining",
    started_at: session.started_at,
    ends_at: session.ends_at,
    now: t,
    reward: formatBalance(session.reward_micro),
    mined: formatBalance(Math.floor(session.reward_micro * done / total))
  };
}

async function profile(db, user) {
  const [session, refs, refEarned] = await Promise.all([
    activeSession(db, user.id),
    db.prepare("SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = ?").bind(user.id).first(),
    db.prepare(
      "SELECT COALESCE(SUM(amount_micro), 0) AS total FROM transactions WHERE user_id = ? AND type = 'referral_bonus'"
    ).bind(user.id).first()
  ]);

  return {
    wallet: user.wallet_address,
    wallet_friendly: friendlyAddress(user.wallet_address),
    balance: formatBalance(user.balance_micro),
    created_at: user.created_at,
    ref_code: refCode(user.id),
    referrals: refs.total,
    referral_earned: formatBalance(refEarned.total),
    mining: miningView(session),
    config: {
      duration: MINING_DURATION,
      reward: formatBalance(MINING_REWARD),
      referral_percent: REFERRAL_PERCENT
    }
  };
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
      "INSERT OR IGNORE INTO users (wallet_address, balance_micro, created_at) VALUES (?, 0, ?)"
    ).bind(raw, t).run();
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

  "POST /api/mining/start": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    const active = await activeSession(db, user.id);

    if (active && active.ends_at > t) {
      return { message: "Mining already active", mining: miningView(active, t) };
    }
    if (active) throw new HttpError("Please claim your previous mining reward", 409);

    await db.prepare(
      "INSERT INTO mining_sessions (user_id, started_at, ends_at, reward_micro) VALUES (?, ?, ?, ?)"
    ).bind(user.id, t, t + MINING_DURATION, MINING_REWARD).run();

    return { message: "Mining started", mining: miningView(await activeSession(db, user.id), t) };
  },

  "POST /api/mining/claim": async ({ request, db }) => {
    const { user } = await authUser(request, db);
    const t = now();
    const session = await activeSession(db, user.id);

    if (!session) throw new HttpError("No reward available", 409);
    if (session.ends_at > t) throw new HttpError("Mining is not finished", 409);

    // Atomic guard: only one request can flip claimed_at.
    const claimed = await db.prepare(`
      UPDATE mining_sessions SET claimed_at = ?
      WHERE id = ? AND user_id = ? AND claimed_at IS NULL AND ends_at <= ?
    `).bind(t, session.id, user.id, t).run();
    if (!claimed.meta.changes) throw new HttpError("Reward already claimed", 409);

    const reward = session.reward_micro;
    const statements = [
      db.prepare("UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?").bind(reward, user.id),
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
      if (err instanceof HttpError) return json({ success: false, error: err.message }, err.status);
      console.error(err);
      return json({ success: false, error: "Internal server error" }, 500);
    }
  }
};
