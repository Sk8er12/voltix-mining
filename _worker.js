
const MINING_DURATION = 24 * 60 * 60;
const MINING_REWARD = 100000000; // 100 VOLTIX
const TOKEN_DECIMALS = 1000000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });

const error = (message, status = 400) =>
  json({ success: false, error: message }, status);

function formatBalance(value) {
  return (Number(value || 0) / TOKEN_DECIMALS).toFixed(6);
}

function validWallet(wallet) {
  return typeof wallet === "string" &&
    wallet.length >= 40 &&
    wallet.length <= 100 &&
    /^[a-zA-Z0-9_-]+$/.test(wallet);
}

async function getUser(db, wallet) {
  return db.prepare(
    "SELECT * FROM users WHERE wallet_address = ?"
  ).bind(wallet).first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        }
      });
    }

    if (!db) return error("Database unavailable", 500);

    try {
      if (path === "/api/status") {
        return json({
          status: "online",
          project: "VOLTIX",
          database: true,
          version: "2.0.0"
        });
      }

      if (path === "/api/health") {
        return json({
          status: "healthy",
          service: "VOLTIX Mining API"
        });
      }

      // REGISTER USER
      if (path === "/api/register" && request.method === "POST") {
        const body = await request.json();
        const wallet = body.wallet;
        const referral = body.referral || null;

        if (!validWallet(wallet)) {
          return error("Invalid wallet address");
        }

        await db.prepare(`
          INSERT OR IGNORE INTO users
          (wallet_address, balance_micro, created_at)
          VALUES (?, 0, ?)
        `).bind(wallet, Math.floor(Date.now() / 1000)).run();

        const user = await getUser(db, wallet);

        if (referral && referral !== wallet) {
          const referrer = await getUser(db, referral);

          if (referrer) {
            await db.prepare(`
              INSERT OR IGNORE INTO referrals
              (referrer_id, referred_id, created_at)
              VALUES (?, ?, ?)
            `).bind(
              referrer.id,
              user.id,
              Math.floor(Date.now() / 1000)
            ).run();
          }
        }

        return json({
          success: true,
          user: {
            wallet: user.wallet_address,
            balance: formatBalance(user.balance_micro)
          }
        });
      }

      // USER PROFILE
      if (path === "/api/me" && request.method === "GET") {
        const wallet = url.searchParams.get("wallet");

        if (!validWallet(wallet)) return error("Invalid wallet");

        const user = await getUser(db, wallet);
        if (!user) return error("User not found", 404);

        return json({
          success: true,
          wallet: user.wallet_address,
          balance: formatBalance(user.balance_micro),
          created_at: user.created_at
        });
      }

      // START MINING
      if (path === "/api/mining/start" &&
          request.method === "POST") {
        const body = await request.json();
        const wallet = body.wallet;

        if (!validWallet(wallet)) return error("Invalid wallet");

        const user = await getUser(db, wallet);
        if (!user) return error("Register first", 404);

        const now = Math.floor(Date.now() / 1000);

        const active = await db.prepare(`
          SELECT * FROM mining_sessions
          WHERE user_id = ? AND claimed_at IS NULL
          ORDER BY id DESC LIMIT 1
        `).bind(user.id).first();

        if (active && active.ends_at > now) {
          return json({
            success: true,
            message: "Mining already active",
            started_at: active.started_at,
            ends_at: active.ends_at,
            reward: formatBalance(active.reward_micro)
          });
        }

        if (active && active.ends_at <= now) {
          return error("Please claim your previous mining reward");
        }

        const endsAt = now + MINING_DURATION;

        const result = await db.prepare(`
          INSERT INTO mining_sessions
          (user_id, started_at, ends_at, reward_micro)
          VALUES (?, ?, ?, ?)
        `).bind(
          user.id,
          now,
          endsAt,
          MINING_REWARD
        ).run();

        return json({
          success: true,
          message: "Mining started",
          session_id: result.meta.last_row_id,
          started_at: now,
          ends_at: endsAt,
          reward: formatBalance(MINING_REWARD)
        });
      }

      // CLAIM REWARD
      if (path === "/api/mining/claim" &&
          request.method === "POST") {
        const body = await request.json();
        const wallet = body.wallet;

        if (!validWallet(wallet)) return error("Invalid wallet");

        const user = await getUser(db, wallet);
        if (!user) return error("User not found", 404);

        const now = Math.floor(Date.now() / 1000);
        const claimStamp = Date.now();

        const session = await db.prepare(`
          SELECT * FROM mining_sessions
          WHERE user_id = ? AND claimed_at IS NULL
          ORDER BY id DESC LIMIT 1
        `).bind(user.id).first();

        if (!session) return error("No reward available");

        if (session.ends_at > now) {
          return error("Mining is not finished");
        }

        // Claim can only happen once.
        const claimed = await db.prepare(`
          UPDATE mining_sessions
          SET claimed_at = ?
          WHERE id = ?
          AND user_id = ?
          AND claimed_at IS NULL
          AND ends_at <= ?
        `).bind(
          claimStamp,
          session.id,
          user.id,
          now
        ).run();

        if (!claimed.meta.changes) {
          return error("Reward already claimed");
        }

        await db.prepare(`
          UPDATE users
          SET balance_micro = balance_micro + ?
          WHERE id = ?
        `).bind(session.reward_micro, user.id).run();

        await db.prepare(`
          INSERT INTO transactions
          (user_id, amount_micro, type, created_at)
          VALUES (?, ?, 'mining_reward', ?)
        `).bind(
          user.id,
          session.reward_micro,
          now
        ).run();

        const updated = await getUser(db, wallet);

        return json({
          success: true,
          message: "Reward claimed",
          reward: formatBalance(session.reward_micro),
          balance: formatBalance(updated.balance_micro)
        });
      }

      // REFERRALS
      if (path === "/api/referrals" &&
          request.method === "GET") {
        const wallet = url.searchParams.get("wallet");

        if (!validWallet(wallet)) return error("Invalid wallet");

        const user = await getUser(db, wallet);
        if (!user) return error("User not found", 404);

        const result = await db.prepare(`
          SELECT COUNT(*) AS total
          FROM referrals WHERE referrer_id = ?
        `).bind(user.id).first();

        return json({
          success: true,
          total_referrals: result.total,
          referral_wallet: wallet
        });
      }

      // TRANSACTION HISTORY
      if (path === "/api/transactions" &&
          request.method === "GET") {
        const wallet = url.searchParams.get("wallet");

        if (!validWallet(wallet)) return error("Invalid wallet");

        const user = await getUser(db, wallet);
        if (!user) return error("User not found", 404);

        const result = await db.prepare(`
          SELECT amount_micro, type, created_at
          FROM transactions
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT 50
        `).bind(user.id).all();

        return json({
          success: true,
          transactions: result.results.map(tx => ({
            amount: formatBalance(tx.amount_micro),
            type: tx.type,
            created_at: tx.created_at
          }))
        });
      }

      // WEBSITE FILES
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return error("Endpoint not found", 404);

    } catch (err) {
      return json({
        success: false,
        error: "Internal server error"
      }, 500);
    }
  }
};
