// VOLTIX notifier — scheduled Cloudflare Worker (every 10 minutes).
//  * Keeps the Telegram bot webhook and menu button pointing at the app.
//  * Reminds users who haven't collected their 24/7 mining for a day.
//
// Bindings: DB (same D1 as the app), secret BOT_TOKEN.

const APP_URL = "https://voltix-mining.pages.dev";
const WEBHOOK_URL = `${APP_URL}/api/telegram/webhook`;
const BATCH = 200;

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

async function webhookSecret(botToken) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("voltix-webhook:" + botToken)));
  return [...h].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({ ok: false }));
}

async function ensureBotSetup(env) {
  const info = await tg(env, "getWebhookInfo", {});
  if (!info.ok) {
    console.warn("getWebhookInfo failed:", info.error_code, info.description);
    return;
  }
  // Re-apply once an hour anyway, in case the token (and so the secret) changed.
  if (info.result.url === WEBHOOK_URL && new Date().getUTCMinutes() >= 10) return;

  const set = await tg(env, "setWebhook", {
    url: WEBHOOK_URL,
    secret_token: await webhookSecret(env.BOT_TOKEN),
    allowed_updates: ["message"]
  });
  const menu = await tg(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "Open VOLTIX", web_app: { url: APP_URL } }
  });
  console.log("bot setup", JSON.stringify({ webhook: set.ok || set.description, menu: menu.ok || menu.description }));
}

// VOLTIX per day by miner level (same table as the app's MINER_LEVELS).
const DAILY_BY_LEVEL = [100, 120, 145, 175, 210, 250, 300, 360, 430, 520];
const DAY = 86400;

// Mining runs 24/7. Once a user hasn't collected for a full day, remind them
// (at most once a day while they stay away).
export async function notifyFinished(env) {
  const t = now();
  const { results } = await env.DB.prepare(`
    SELECT id, telegram_id, mining_since, miner_level, reminded_at
    FROM users
    WHERE telegram_id IS NOT NULL AND mining_since IS NOT NULL
      AND mining_since <= ? AND (reminded_at IS NULL OR reminded_at <= ?)
    ORDER BY mining_since LIMIT ?
  `).bind(t - DAY, t - DAY, BATCH).all();

  let sent = 0;
  for (const row of results) {
    // Mark first so overlapping runs never send twice.
    const mark = await env.DB.prepare(
      "UPDATE users SET reminded_at = ? WHERE id = ? AND reminded_at IS ?"
    ).bind(t, row.id, row.reminded_at).run();
    if (!mark.meta.changes) continue;

    const perDay = DAILY_BY_LEVEL[Math.min(Math.max(row.miner_level || 1, 1), DAILY_BY_LEVEL.length) - 1];
    const mined = Math.floor((t - row.mining_since) * perDay / DAY);
    const res = await tg(env, "sendMessage", {
      chat_id: row.telegram_id,
      text: `⛏ <b>Your miner has collected ${mined.toLocaleString("en-US")} VOLTIX!</b>\n\nIt keeps working 24/7 — come grab your coins.`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "⚡ Claim VOLTIX", web_app: { url: APP_URL } }]] }
    });

    if (!res.ok) console.warn("sendMessage failed:", res.error_code, res.description);
    if (res.ok) {
      sent++;
    } else if (res.error_code === 403) {
      // User blocked the bot — stop trying.
      await env.DB.prepare("UPDATE users SET telegram_id = NULL WHERE telegram_id = ?").bind(row.telegram_id).run();
    } else if (res.error_code === 429) {
      // Rate limited — retry this one next run.
      await env.DB.prepare("UPDATE users SET reminded_at = ? WHERE id = ?").bind(row.reminded_at, row.id).run();
      break;
    }
  }
  return { due: results.length, sent };
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.BOT_TOKEN) {
      console.warn("BOT_TOKEN secret is not set");
      return;
    }
    await ensureBotSetup(env);
    const result = await notifyFinished(env);
    console.log("notifier", JSON.stringify(result));
  },

  async fetch() {
    return new Response("VOLTIX notifier", { status: 200 });
  }
};
