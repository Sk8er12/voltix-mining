import { Address } from "@ton/ton";
import { verifyTonProof } from "./ton-proof.js";

const MINING_DURATION = 86400;
const MINING_REWARD = 100000000;
const TOKEN_DECIMALS = 1000000;
const APP_ORIGIN = "https://voltix-mining.pages.dev";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }
});
const error = (message, status = 400) => json({ success: false, error: message }, status);
const formatBalance = value => (Number(value || 0) / TOKEN_DECIMALS).toFixed(6);
async function getUser(db, wallet) {
  return db.prepare("SELECT * FROM users WHERE wallet_address = ?").bind(wallet).first();
}
function parseCookies(request) {
  const out = {};
  for (const item of (request.headers.get("Cookie") || "").split(";")) {
    const p = item.trim(); if (!p) continue; const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  }
  return out;
}
function randomHex(bytes = 32) {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data);
  return Array.from(data, x => x.toString(16).padStart(2, "0")).join("");
}
function cookie(name, value, age) {
  return name + "=" + encodeURIComponent(value) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + age;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url); const path = url.pathname; const db = env.DB;
    if (!db) return error("Database unavailable", 500);
    const origin = request.headers.get("Origin");
    if (origin && origin !== APP_ORIGIN) return error("Origin not allowed", 403);
    const cookies = parseCookies(request); const now = Math.floor(Date.now() / 1000);
    try {
      if (path === "/api/status" && request.method === "GET") return json({ status: "online", project: "VOLTIX", database: true, version: "3.0.0" });
      if (path === "/api/health" && request.method === "GET") return json({ status: "healthy", service: "VOLTIX Mining API" });
      if (path === "/api/ton-proof/payload" && request.method === "POST") {
        const attemptId = cookies.vtx_attempt || randomHex(); const payload = randomHex();
        await db.prepare("INSERT INTO ton_proof_challenges (payload, attempt_id, expires_at) VALUES (?, ?, ?)").bind(payload, attemptId, now + 600).run();
        return json({ success: true, payload }, 200, { "Set-Cookie": cookie("vtx_attempt", attemptId, 600) });
      }
      if (path === "/api/ton-proof/verify" && request.method === "POST") {
        const attemptId = cookies.vtx_attempt; if (!attemptId) return error("Login attempt expired. Reconnect wallet.", 401);
        const body = await request.json();
        if (!body || !body.proof || typeof body.address !== "string" || typeof body.network !== "string") return error("Invalid proof request");
        if (body.network !== "-3") return error("Only TON Testnet is enabled", 403);
        const challenge = await db.prepare("SELECT payload FROM ton_proof_challenges WHERE payload = ? AND attempt_id = ? AND expires_at > ?").bind(body.proof.payload, attemptId, now).first();
        if (!challenge) return error("Challenge expired or already used", 401);
        const valid = await verifyTonProof({ address: body.address, network: body.network, public_key: body.public_key, proof: { ...body.proof, state_init: body.proof.state_init || body.walletStateInit }, expectedPayload: challenge.payload });
        if (!valid) return error("TON Proof verification failed", 401);
        const consumed = await db.prepare("DELETE FROM ton_proof_challenges WHERE payload = ? AND attempt_id = ? AND expires_at > ?").bind(challenge.payload, attemptId, now).run();
        if (!consumed.meta || !consumed.meta.changes) return error("Challenge already used", 401);
        const wallet = Address.parse(body.address).toRawString();
        await db.prepare("INSERT OR IGNORE INTO users (wallet_address, balance_micro, created_at) VALUES (?, 0, ?)").bind(wallet, now).run();
        const sessionId = randomHex();
        await db.prepare("INSERT INTO auth_sessions (id, wallet_address, network, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(sessionId, wallet, body.network, now, now + 2592000).run();
        return json({ success: true, address: wallet, network: body.network }, 200, { "Set-Cookie": [cookie("vtx_session", sessionId, 2592000), cookie("vtx_attempt", "", 0)] });
      }
      if (path === "/api/logout" && request.method === "POST") {
        if (cookies.vtx_session) await db.prepare("DELETE FROM auth_sessions WHERE id = ?").bind(cookies.vtx_session).run();
        return json({ success: true }, 200, { "Set-Cookie": cookie("vtx_session", "", 0) });
      }
      const protectedPaths = ["/api/me", "/api/mining/start", "/api/mining/claim", "/api/referrals", "/api/transactions"];
      let user = null;
      if (protectedPaths.includes(path)) {
        const sid = cookies.vtx_session; if (!sid) return error("Authentication required", 401);
        const session = await db.prepare("SELECT wallet_address FROM auth_sessions WHERE id = ? AND expires_at > ?").bind(sid, now).first();
        if (!session) return error("Session expired. Reconnect wallet.", 401);
        user = await getUser(db, session.wallet_address); if (!user) return error("Account not found", 404);
      }
      if (path === "/api/register") return error("Use TON Proof authentication", 410);
      if (path === "/api/me" && request.method === "GET") return json({ success: true, wallet: user.wallet_address, balance: formatBalance(user.balance_micro), created_at: user.created_at });
      if (path === "/api/mining/start" && request.method === "POST") {
        const active = await db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND claimed_at IS NULL ORDER BY id DESC LIMIT 1").bind(user.id).first();
        if (active && active.ends_at > now) return json({ success: true, message: "Mining already active", started_at: active.started_at, ends_at: active.ends_at, reward: formatBalance(active.reward_micro) });
        if (active) return error("Please claim your previous mining reward");
        const endsAt = now + MINING_DURATION;
        const result = await db.prepare("INSERT INTO mining_sessions (user_id, started_at, ends_at, reward_micro) VALUES (?, ?, ?, ?)").bind(user.id, now, endsAt, MINING_REWARD).run();
        return json({ success: true, message: "Mining started", session_id: result.meta.last_row_id, started_at: now, ends_at: endsAt, reward: formatBalance(MINING_REWARD) });
      }
      if (path === "/api/mining/claim" && request.method === "POST") {
        const session = await db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND claimed_at IS NULL ORDER BY id DESC LIMIT 1").bind(user.id).first();
        if (!session) return error("No reward available"); if (session.ends_at > now) return error("Mining is not finished");
        const claimed = await db.prepare("UPDATE mining_sessions SET claimed_at = ? WHERE id = ? AND user_id = ? AND claimed_at IS NULL AND ends_at <= ?").bind(Date.now(), session.id, user.id, now).run();
        if (!claimed.meta || !claimed.meta.changes) return error("Reward already claimed");
        await db.prepare("UPDATE users SET balance_micro = balance_micro + ? WHERE id = ?").bind(session.reward_micro, user.id).run();
        await db.prepare("INSERT INTO transactions (user_id, amount_micro, type, created_at) VALUES (?, ?, ?, ?)").bind(user.id, session.reward_micro, "mining_reward", now).run();
        const updated = await getUser(db, user.wallet_address);
        return json({ success: true, message: "Reward claimed", reward: formatBalance(session.reward_micro), balance: formatBalance(updated.balance_micro) });
      }
      if (path === "/api/referrals" && request.method === "GET") {
        const result = await db.prepare("SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = ?").bind(user.id).first();
        return json({ success: true, total_referrals: result.total, referral_wallet: user.wallet_address });
      }
      if (path === "/api/transactions" && request.method === "GET") {
        const result = await db.prepare("SELECT amount_micro, type, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50").bind(user.id).all();
        return json({ success: true, transactions: (result.results || []).map(tx => ({ amount: formatBalance(tx.amount_micro), type: tx.type, created_at: tx.created_at })) });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return error("Endpoint not found", 404);
    } catch (err) {
      console.error("VOLTIX API error", err); return error("Internal server error", 500);
    }
  }
};