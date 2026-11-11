// VOLTIX notifier — scheduled Cloudflare Worker (every 10 minutes).
//  * Keeps the Telegram bot webhook and menu button pointing at the app.
//  * Messages users whose mining session has finished and isn't claimed yet.
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
  // Re-apply once an hour anyway, in case the token (and so the secret) changed.
  if (info.ok && info.result.url === WEBHOOK_URL && new Date().getUTCMinutes() >= 10) return;

  await tg(env, "setWebhook", {
    url: WEBHOOK_URL,
    secret_token: await webhookSecret(env.BOT_TOKEN),
    allowed_updates: ["message"]
  });
  await tg(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "Open VOLTIX", web_app: { url: APP_URL } }
  });
}

export async function notifyFinished(env) {
  const t = now();
  const { results } = await env.DB.prepare(`
    SELECT ms.id, ms.reward_micro, u.telegram_id
    FROM mining_sessions ms JOIN users u ON u.id = ms.user_id
    WHERE ms.claimed_at IS NULL AND ms.notified_at IS NULL
      AND ms.ends_at <= ? AND u.telegram_id IS NOT NULL
    ORDER BY ms.ends_at LIMIT ?
  `).bind(t, BATCH).all();

  let sent = 0;
  for (const row of results) {
    // Mark first so overlapping runs never send twice.
    const mark = await env.DB.prepare(
      "UPDATE mining_sessions SET notified_at = ? WHERE id = ? AND notified_at IS NULL"
    ).bind(t, row.id).run();
    if (!mark.meta.changes) continue;

    const reward = Math.round(row.reward_micro / 1_000_000);
    const res = await tg(env, "sendMessage", {
      chat_id: row.telegram_id,
      text: `⛏ <b>Mining complete!</b>\n\n${reward} VOLTIX are ready. Claim them and start your next session.`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "⚡ Claim VOLTIX", web_app: { url: APP_URL } }]] }
    });

    if (res.ok) {
      sent++;
    } else if (res.error_code === 403) {
      // User blocked the bot — stop trying.
      await env.DB.prepare("UPDATE users SET telegram_id = NULL WHERE telegram_id = ?").bind(row.telegram_id).run();
    } else if (res.error_code === 429) {
      // Rate limited — retry this one next run.
      await env.DB.prepare("UPDATE mining_sessions SET notified_at = NULL WHERE id = ?").bind(row.id).run();
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
