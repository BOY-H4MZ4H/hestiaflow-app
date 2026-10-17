// Telegram bot backend for HestiaFlow (@hestiaflow_bot).
// Polls getUpdates. Shares the HestiaFlow SQLite DB (vouchers) via db passed in.
// Env: TELEGRAM_BOT_TOKEN (required), ADMIN_TELEGRAM_ID (optional, set after /id).
const crypto = require("crypto");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || "");
const API = `https://api.telegram.org/bot${TOKEN}`;
const TIER_PRICE = { plus: { amount: "Rp 5.000", dur: "3 Hari", days: 3 }, pro: { amount: "Rp 8.000", dur: "1 Minggu", days: 7 }, premium: { amount: "Rp 15.000", dur: "2 Minggu", days: 14 } };
const TIER_NAME = { gratis: "Gratis", plus: "Plus", pro: "Pro", premium: "Premium" };
function genVoucherCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += chars[crypto.randomInt(chars.length)];
  return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12) + "-" + out.slice(12, 16);
}
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({}));
}
const GROUP_URL = "https://t.me/+MXrvI2tkFjg5ZmQ1";
const WEB_URL = "https://hestiaflow-app-production.up.railway.app/";
function mainKeyboard() {
  return { inline_keyboard: [[{ text: "💬 Gabung Grup Tele", url: GROUP_URL }], [{ text: "🌐 Buka Web HestiaFlow", url: WEB_URL }]] };
}
async function sendMsg(chatId, text, withKeyboard) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (withKeyboard) body.reply_markup = mainKeyboard();
  return tg("sendMessage", body);
}
function tierInfo(slug) {
  const p = TIER_PRICE[slug];
  if (!p) return null;
  return `<b>Paket ${TIER_NAME[slug]}</b>\nHarga: <b>${p.amount}</b> (${p.dur})\n\nUntuk pembayaran, hubungi Admin. Setelah bayar, kirim <b>foto bukti pembayaran</b> ke sini.`;
}
async function handleUpdate(db, u) {
  const m = u.message; if (!m) return;
  const chatId = m.chat.id;
  const fromId = String(m.from ? m.from.id : "");
  const text = String(m.text || "").trim();
  const username = m.from ? (m.from.username || "") : "";
  if (text === "/id") { await sendMsg(chatId, `ID Telegram kamu: <code>${fromId}</code>`); return; }
  if (text === "/grup") { await sendMsg(chatId, `Gabung grup HestiaFlow di sini: ${GROUP_URL}`, true); return; }
  if (text.startsWith("/start")) {
    const payload = text.replace("/start", "").trim();
    let slug = "";
    if (payload.startsWith("hestiaflow_")) slug = payload.slice("hestiaflow_".length).toLowerCase();
    if (slug && TIER_PRICE[slug]) {
      db.prepare("INSERT OR REPLACE INTO bot_state (tg_user_id, last_tier_slug, updated_at) VALUES (?, ?, ?)").run(fromId, slug, new Date().toISOString());
      await sendMsg(chatId, `Halo! Kamu mau pesan <b>Paket ${TIER_NAME[slug]}</b>.\n\n${tierInfo(slug)}\n\nKirim foto bukti pembayaran ke sini setelah bayar.`, true);
    } else {
      await sendMsg(chatId, `Halo! Ini bot <b>HestiaFlow</b>.\n\nPilih paket di web (klik tombol <b>Pesan</b> di kartu tier), lalu kembali ke sini untuk kirim bukti pembayaran.\n\nPerintah: /id (lihat ID Telegram kamu), /myorders (lihat pesananmu), /grup (link grup).`, true);
    }
    return;
  }
  if (text === "/myorders") {
    const rows = db.prepare("SELECT id, tier_slug, status, voucher_code, created_at FROM bot_orders WHERE tg_user_id=? ORDER BY id DESC LIMIT 10").all(fromId);
    if (!rows.length) { await sendMsg(chatId, "Kamu belum punya pesanan."); return; }
    const lines = rows.map((o) => `#${o.id} — ${TIER_NAME[o.tier_slug] || o.tier_slug} — ${o.status}${o.voucher_code ? ` — Vocher: <code>${o.voucher_code}</code>` : ""}`).join("\n");
    await sendMsg(chatId, `<b>Pesananmu:</b>\n${lines}`);
    return;
  }
  if (text.startsWith("/approve") || text.startsWith("/reject")) {
    if (!ADMIN_ID || fromId !== ADMIN_ID) { await sendMsg(chatId, "Perintah ini hanya untuk Admin."); return; }
    const parts = text.split(/\s+/); const orderId = parseInt(parts[1], 10);
    if (!orderId) { await sendMsg(chatId, "Pakai: /approve <id_pesanan> atau /reject <id_pesanan>"); return; }
    const o = db.prepare("SELECT * FROM bot_orders WHERE id=? AND status='pending'").get(orderId);
    if (!o) { await sendMsg(chatId, `Pesanan #${orderId} tidak ditemukan / sudah diproses.`); return; }
    if (text.startsWith("/approve")) {
      const days = (TIER_PRICE[o.tier_slug] || {}).days || 3;
      const code = genVoucherCode();
      db.prepare("INSERT INTO vouchers (code, tier_slug, duration_days, used, created_at) VALUES (?, ?, ?, 0, ?)").run(code, o.tier_slug, days, new Date().toISOString());
      db.prepare("UPDATE bot_orders SET status='approved', voucher_code=?, decided_at=? WHERE id=?").run(code, o.tier_slug, new Date().toISOString(), orderId);
      await sendMsg(chatId, `Pesanan #${orderId} disetujui. Vocher dikirim ke user.`);
      await sendMsg(o.tg_user_id, `Pembayaranmu disetujui! 🎉\n\nKode Vocher kamu: <code>${code}</code>\nPaket: <b>${TIER_NAME[o.tier_slug]}</b> (${(TIER_PRICE[o.tier_slug] || {}).dur || ""})\n\nRedeem kode ini di web HestiaFlow (section Voucher).`);
    } else {
      db.prepare("UPDATE bot_orders SET status='rejected', decided_at=? WHERE id=?").run(new Date().toISOString(), orderId);
      await sendMsg(chatId, `Pesanan #${orderId} ditolak.`);
      await sendMsg(o.tg_user_id, `Maaf, pembayaran untuk pesanan #${orderId} ditolak. Hubungi Admin untuk info lebih lanjut.`);
    }
    return;
  }
  if (m.photo && m.photo.length) {
    const st = db.prepare("SELECT last_tier_slug FROM bot_state WHERE tg_user_id=?").get(fromId);
    const slug = st ? st.last_tier_slug : "";
    if (!slug || !TIER_PRICE[slug]) { await sendMsg(chatId, "Klik tombol <b>Pesan</b> di web dulu (pilih paket), baru kirim bukti pembayaran ke sini."); return; }
    const photo = m.photo[m.photo.length - 1];
    const info = db.prepare("INSERT INTO bot_orders (tg_user_id, tg_username, tier_slug, photo_file_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(fromId, username, slug, photo.file_id, new Date().toISOString());
    const orderId = Number(info.lastInsertRowid);
    await sendMsg(chatId, `Bukti pembayaran diterima! Pesanan #${orderId} (${TIER_NAME[slug]}) sedang dicek Admin. Tunggu ya.`);
    if (ADMIN_ID) {
      await sendMsg(ADMIN_ID, `Pesanan baru #${orderId}\nUser: @${username || "-"} (ID ${fromId})\nPaket: ${TIER_NAME[slug]} (${(TIER_PRICE[slug] || {}).amount})\n\nSetujui: /approve ${orderId}\nTolak: /reject ${orderId}`);
      await tg("sendPhoto", { chat_id: ADMIN_ID, photo: photo.file_id, caption: `Bukti pembayaran pesanan #${orderId} (@${username || "-"})` });
    }
    return;
  }
  await sendMsg(chatId, `Halo! Pilih paket di web (klik tombol <b>Pesan</b>), lalu kirim foto bukti pembayaran ke sini.\n\nPerintah: /id, /myorders.`);
}
function startBot(db) {
  if (!TOKEN) { console.log("[bot] TELEGRAM_BOT_TOKEN not set, bot disabled."); return; }
  try {
    db.exec("CREATE TABLE IF NOT EXISTS bot_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_user_id TEXT, tg_username TEXT, tier_slug TEXT, photo_file_id TEXT, status TEXT DEFAULT 'pending', voucher_code TEXT, created_at TEXT, decided_at TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS bot_state (tg_user_id TEXT PRIMARY KEY, last_tier_slug TEXT, updated_at TEXT)");
  } catch (e) { console.error("[bot] migrate err", e.message); return; }
  let offset = 0;
  async function poll() {
    try {
      const r = await fetch(`${API}/getUpdates?offset=${offset}&timeout=25`);
      const data = await r.json();
      if (data.ok) {
        for (const u of data.result || []) { offset = u.update_id + 1; await handleUpdate(db, u).catch((e) => console.error("[bot] handle err", e.message)); }
      }
    } catch (e) { console.error("[bot] poll err", e.message); }
    setTimeout(poll, 1500);
  }
  poll();
  console.log("[bot] polling started (@hestiaflow_bot)");
}
module.exports = { startBot };
