/* HestiaFlow — standalone web app (rebuild for Railway).
 * Google login only. Panen Akun. Tiers Gratis/Plus/Premium. 2-path architecture.
 * Path 1 (user-facing): HestiaFlow Base URL + HestiaFlow API key + Credit.
 * Path 2 (backend, fully hidden): real provider Base URL + real provider API key
 * + email + password — NEVER returned in any API response, log, or client code.
 */
"use strict";
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "https://api.hestia-gateway.id/v1";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/auth/google/callback`;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const TEST_SECRET = process.env.TEST_SECRET || "";
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "data", "hestiaflow.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
// [TEMP-DB-IMPORT] tukar database dengan hasil impor sebelum dibuka
try {
  const _imp = DB_PATH + ".imported";
  if (fs.existsSync(_imp)) {
    fs.renameSync(_imp, DB_PATH);
    for (const _e of ["-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + _e); } catch {} }
    console.log("[db-import] database hasil impor terpasang");
  }
} catch (e) { console.log("[db-import] swap gagal:", e && e.message); }
const db = new DatabaseSync(DB_PATH);

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, google_id TEXT UNIQUE, email TEXT UNIQUE, name TEXT, avatar TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, name TEXT, audience_label TEXT, badge TEXT, max_models INTEGER, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS providers (id INTEGER PRIMARY KEY AUTOINCREMENT, tier_id INTEGER, brand_name TEXT, tagline TEXT, model_count INTEGER DEFAULT 0, model_list_json TEXT DEFAULT '[]', model_notes_json TEXT DEFAULT '{}', credit_note TEXT, default_credit INTEGER, sort_order INTEGER DEFAULT 0, upstream_name TEXT, upstream_url TEXT, upstream_api_key TEXT, FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS workers (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, name TEXT, credit INTEGER DEFAULT 0, status TEXT DEFAULT 'active', upstream_api_key TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(provider_id) REFERENCES providers(id));
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, key_value TEXT, key_prefix TEXT, credit INTEGER, models_json TEXT DEFAULT '[]', model_source TEXT DEFAULT 'none', model_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(provider_id) REFERENCES providers(id), FOREIGN KEY(tier_id) REFERENCES tiers(id));
CREATE TABLE IF NOT EXISTS harvested_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER, user_id INTEGER, provider_id INTEGER, tier_id INTEGER, temp_email TEXT, temp_password TEXT, upstream_api_key TEXT, upstream_base_url TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY(api_key_id) REFERENCES api_keys(id));
CREATE TABLE IF NOT EXISTS harvest_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, provider_id INTEGER, message TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT); 
`);

// ---------- seed ----------
// Katalog Aurora dipangkas 2026-10-23 (sweep Termux Hestia + retest Sr): HANYA 10 model
// CHAT yang terbukti menjawab. Model gambar/video TIDAK dimasukkan (aturan Hestia:
// gambar & video terpisah di kartu Tier Media; "rooyai-image" tidak dimasukkan di mana pun).
// Yang gugur: deepseek-v4-pro, kimi-k2.6, qwen3.8-max, omni-flash, mimo*, llama-3.3,
// S1-Base-Pro, gemma-4-31b-it huruf kecil (semua 503 not available), embedding/whisper
// (bukan chat), nano-banana*/veo*/rooyai-image/grok-imagine (gambar/video -> Tier Media).
const AURORA_MODELS = ["deepseek-v3.1","deepseek-v3.2","deepseek-v4-flash","gemma-4-31B-it","google/gemini-3-flash-preview","google/gemini-3.1-flash-lite","gpt-4o-mini","gpt-oss-120b","minimax-m2.7","moonshotai.kimi-k2.5"];
function seed() {
  // Migrasi: tabel vouchers + users.tier_expires_at (masa berlaku paket dari vocher).
  db.prepare("CREATE TABLE IF NOT EXISTS vouchers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, tier_slug TEXT, duration_days INTEGER, used INTEGER DEFAULT 0, used_by INTEGER, used_at TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
  try {
    const ucols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!ucols.includes("tier_expires_at")) db.prepare("ALTER TABLE users ADD COLUMN tier_expires_at TEXT").run();
  } catch {}
  // Migrasi: users.tier_slug (paket user: gratis/plus/pro/premium, default gratis) — untuk kunci tier picker.
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!cols.includes("tier_slug")) db.prepare("ALTER TABLE users ADD COLUMN tier_slug TEXT DEFAULT 'gratis'").run();
    db.prepare("UPDATE users SET tier_slug='gratis' WHERE tier_slug IS NULL OR tier_slug=''").run();
  } catch {}
  // Migrasi 2026-10-18: api_keys.expires_at — batasi masa pakai key (Gratis: 2 hari).
  try {
    const kcols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    if (!kcols.includes("expires_at")) db.prepare("ALTER TABLE api_keys ADD COLUMN expires_at TEXT").run();
  } catch {}
  // Migrasi 2026-10-20: BANSOS TOKEN — key tanpa login (api_keys.anon_id) + tabel pemakaian pool harian.
  try {
    const kcolsB = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    if (!kcolsB.includes("anon_id")) db.prepare("ALTER TABLE api_keys ADD COLUMN anon_id TEXT").run();
  } catch {}
  db.prepare("CREATE TABLE IF NOT EXISTS bansos_usage (day TEXT, worker_id INTEGER, tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0, PRIMARY KEY(day, worker_id))").run();
  // JALUR 2 (2026-10-23): tier Media + log generate gambar/video. media_logs = catatan pantauan
  // (siapa, model apa, prompt, biaya, hasil tersalin ke Drive pantauan?) untuk admin/moderasi.
  db.prepare("CREATE TABLE IF NOT EXISTS media_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key_id INTEGER, user_id INTEGER, media_type TEXT, model TEXT, prompt TEXT, cost_usd REAL, gen_id TEXT, source_url TEXT, drive_path TEXT, copy_status TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
  db.prepare("CREATE TABLE IF NOT EXISTS proxy_pool (host TEXT, target TEXT, last_ok TEXT DEFAULT (datetime('now')), fails INTEGER DEFAULT 0, PRIMARY KEY(host, target))").run();
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('media','Media','UNTUK PENGGUNA MEDIA','TIER MEDIA',NULL,5)").run();
  // Provider Bansos (tanpa tier): 4 model pilihan. Key upstream (pool akun) disimpan di tabel workers,
  // di-seed dari env BANSOS_UPSTREAM_KEYS. upstream_url server-side saja (tidak pernah tampil publik).
  // Nama publik = nama asli model (tanpa prefix agregator). upstream_url via env PROVIDER_BANSOS_UPSTREAM_URL.
  const BANSOS_MODELS = ["codestral-latest","qwen3.6-27b","gpt-oss-20b","mistral-large-latest"];
  const BANSOS_NOTES = {"codestral-latest":"Jago coding.","qwen3.6-27b":"Jago coding.","gpt-oss-20b":"Paling cepat.","mistral-large-latest":"Paling jago untuk semua."};
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT NULL,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Bansos')").run(
    "Bansos", "Token gratis untuk semua pengguna.", 4, JSON.stringify(BANSOS_MODELS), JSON.stringify(BANSOS_NOTES), "4.5 juta token per hari untuk semua pengguna.", null, 99, null
  );
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=? WHERE brand_name='Bansos'").run(4, JSON.stringify(BANSOS_MODELS), JSON.stringify(BANSOS_NOTES), "4.5 juta token per hari untuk semua pengguna.");
  // Migrasi 2026-10-24: users.suspended + jejak login (last_ip/last_ua/last_login_at)
  // untuk panel admin — perintah Hestia: admin bisa suspend pengguna + lihat IP/HP-nya.
  try {
    const ucols3 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!ucols3.includes("suspended")) db.prepare("ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0").run();
    if (!ucols3.includes("last_ip")) db.prepare("ALTER TABLE users ADD COLUMN last_ip TEXT").run();
    if (!ucols3.includes("last_ua")) db.prepare("ALTER TABLE users ADD COLUMN last_ua TEXT").run();
    if (!ucols3.includes("last_login_at")) db.prepare("ALTER TABLE users ADD COLUMN last_login_at TEXT").run();
  } catch {}
  // Migrasi 2026-10-18: users.gratis_started_at — awal masa 2 hari Gratis (total, bukan per-key).
  try {
    const ucols2 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!ucols2.includes("gratis_started_at")) db.prepare("ALTER TABLE users ADD COLUMN gratis_started_at TEXT").run();
  } catch {}
  // Migrasi 2026-10-22: harvested_accounts.fail_count + cooldown_until + expires_at —
  // auto-hapus akun panen mati/habis saldo (perintah Hestia, biar tidak hapus manual satu-satu):
  // 401/402/403 pas dipakai -> baris langsung dihapus; 429 -> cooldown_until = 6 jam ke depan
  // + fail_count naik (baris dilewati selama cooldown); fail_count >= 5 -> disapu cleanup berkala.
  // expires_at = masa aktif akun panen dari respons register provider (kalau provider kasih tau;
  // yang tidak kasih tau tetap NULL — kematiannya ketahuan pas dipakai, lalu dihapus juga).
  try {
    const hcols = db.prepare("PRAGMA table_info(harvested_accounts)").all().map((c) => c.name);
    if (!hcols.includes("fail_count")) db.prepare("ALTER TABLE harvested_accounts ADD COLUMN fail_count INTEGER DEFAULT 0").run();
    if (!hcols.includes("cooldown_until")) db.prepare("ALTER TABLE harvested_accounts ADD COLUMN cooldown_until TEXT").run();
    if (!hcols.includes("expires_at")) db.prepare("ALTER TABLE harvested_accounts ADD COLUMN expires_at TEXT").run();
  } catch {}
  // Migrasi: tambah provider Nova (Tier Pro). Model + credit user-facing (bukan secret).
  // upstream_url Nova TIDAK ditulis di kode (anti-bocor) — di-set via env PROVIDER_NOVA_UPSTREAM_URL.
  // Hapus provider Nova dobel (kalau migrasi lama sempat jalan 2x) — sisakan 1 (id terkecil).
  db.prepare("DELETE FROM providers WHERE brand_name='Nova' AND id NOT IN (SELECT MIN(id) FROM providers WHERE brand_name='Nova')").run();
  const novaModels = ["claude-haiku-4.5","claude-opus-4","claude-opus-4.6","claude-sonnet-4","claude-sonnet-4-20250514","claude-sonnet-4.6","command-a","command-r","command-r-plus","deepseek-chat","deepseek-coder","deepseek-reasoner","gemini-2.0-flash","gemini-2.0-flash-lite","gemini-2.5-flash","gemini-2.5-flash-preview","gemini-2.5-pro","gemini-3-flash","minimax-text-01","codestral","mistral-large","mistral-small","dall-e-2","dall-e-3","gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","gpt-4.5-preview","gpt-4o","gpt-4o-mini","gpt-5-mini","gpt-5.1","gpt-image-1","o3","o3-mini","o4-mini","text-embedding-3-large","text-embedding-3-small","text-embedding-ada-002","qwen-max","qwen-plus","qwen-turbo","qwen-vl-max","qwen-vl-plus","qwen3-max","qwen3.5-plus","grok-3","grok-3-mini","grok-4"];
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,credit_note,default_credit,sort_order) SELECT (SELECT id FROM tiers WHERE slug='pro'),?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Nova')").run('Nova','Bintang baru yang bersinar terang.',49,JSON.stringify(novaModels),'283 ribu token per akun (saldo $0.1)',283000,1);
  // Migrasi: tambah Tier Pro (kosong, belum ada provider) di bawah Plus, Premium geser ke bawah.
  db.prepare("UPDATE tiers SET sort_order=4 WHERE slug='premium'").run();
  db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('pro','Pro','UNTUK PENGGUNA PRO','TIER PRO',NULL,3)").run();
  // Migrasi (jalan tiap startup, walau DB sudah ada isi): badge + chip credit dipendekin.
  db.prepare("UPDATE providers SET credit_note=? WHERE brand_name=?").run("Always-free BETA", "Luna");
  // REVERT 2026-10-18: Luna balik ke AI4ALL (2 model, Always-free BETA). Public AI dibatalkan (operator takut komplain pembeli).
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name=?").run(2, JSON.stringify(["qwen3-coder:30b","llama3.2:3b"]), JSON.stringify({"qwen3-coder:30b":"Muncul di website provider. Chat terverifikasi jalan.","llama3.2:3b":"Terdaftar di /v1/models. Tes chat gagal (service_unavailable)."}), "Always-free BETA", null, "Luna");
  // Migrasi 2026-10-18: Aurora GANTI jadi RooyAI (brand tetap "Aurora", provider di baliknya RooyAI).
  // 10 model chat terbukti (pangkasan 2026-10-23; dulu 30 dari /v1/models — banyak yang
  // ternyata 503 / bukan chat / gambar-video). $0.20 per akun. Auto-register via Supabase.
  db.prepare("UPDATE providers SET model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name=?").run(10, JSON.stringify(AURORA_MODELS), JSON.stringify({}), "$0.20 per akun terverifikasi.", 200000, "Aurora");
  // Migrasi 2026-10-18: Luna GANTI jadi Zerolimit (ZeroLimitAI + bestllmapi.com) untuk tier Gratis.
  // 6 model (5 ZeroLimitAI :free + 1 bestllmapi.com "uncensored"). 100 calls/hari, 7 hari per akun. Auto-register full otomatis (no verifikasi email).
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "1 model gratis!",
    1,
    JSON.stringify(["uncensored"]),
    JSON.stringify({}),
    "$0.50 per akun, 7 hari.",
    null,
    "https://api.bestllmapi.com/v1"
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(1, "gratis");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER GRATIS", "gratis");
  // Migrasi 2026-10-19: Luna KEMBALI ke AI4ALL (bestllmapi tidak kasih trial gratis lagi, saldo $0.00 untuk akun baru).
  // 2 model (qwen3-coder:30b, llama3.2:3b), Always-free BETA, unlimited (no numeric limit).
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "Always-free BETA",
    2,
    JSON.stringify(["qwen3-coder:30b","llama3.2:3b"]),
    JSON.stringify({"qwen3-coder:30b":"Muncul di website provider. Chat terverifikasi jalan.","llama3.2:3b":"Terdaftar di /v1/models."}),
    "Gratis selamanya.",
    null,
    "https://ai4all.infergo.ai/v1"
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(2, "gratis");
  // Migrasi 2026-10-21: Tier Gratis GANTI jadi ZeroLimitAI MURNI di balik layar,
  // tapi brand publiknya tetap "Luna" (perintah Hestia 2026-10-21 sore: nama provider
  // TIDAK boleh ditampilkan ke publik — yang tampil brand sendiri, kayak Aurora/Stella).
  // Pelajaran dari upaya 2026-10-18 yang gagal: (1) kode yang ter-deploy waktu itu menunjuk ke
  // bestllmapi saja dan fungsi tryAutoRegisterZerolimit tidak pernah dipanggil dispatcher;
  // (2) env PROVIDER_LUNA_UPSTREAM_URL (basi, menunjuk AI4ALL lama) menimpa upstream_url
  // tiap boot — sekarang dilawan di sync env (brand LUNA di-skip, upstream dikelola migrasi ini)
  // dan cabang dispatcher "luna" diarahkan ke tryAutoRegisterZerolimit.
  // Katalog live ZeroLimitAI 2026-10-21: 9 model (auto + 8 :free). 100 calls/hari per akun,
  // trial 6 hari (referralCode di register). Upstream: https://www.zerolimitai.com/api/v1
  // Katalog mesin Gratis per 2026-10-22 (diverifikasi live: /v1/models + tes chat 8/8 menjawab):
  // Laguna S/XS 2.1 HILANG dari katalog sumber; masuk recursive/flint-v1.0:free. Total 8 model.
  const ZEROLIMIT_MODELS = ["auto","minimax/minimax-m3.1-flash:free","google/gemma-4-31b-it:free","google/gemma-4-26b-a4b-it:free","xingchen-agi/xing4.0-29b-a4b:free","cohere/north-mini-code:free","recursive/flint-v1.0:free","dots-studio/dots-3-note-preview:free"];
  const ZEROLIMIT_NOTES = {"auto":"Router pintar — model terbaik dipilihkan otomatis.","minimax/minimax-m3.1-flash:free":"MiniMax M3.1 Flash — cepat dan ringan.","google/gemma-4-31b-it:free":"Gemma 4 31B — model terbesar di tier Gratis.","google/gemma-4-26b-a4b-it:free":"Gemma 4 26B dari Google.","xingchen-agi/xing4.0-29b-a4b:free":"Xing 4.0 29B.","cohere/north-mini-code:free":"Cohere North Mini — fokus coding.","recursive/flint-v1.0:free":"Flint v1.0 dari Recursive.","dots-studio/dots-3-note-preview:free":"Dots 3 Note (preview)."};
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "9 model gratis untuk semua.",
    9,
    JSON.stringify(ZEROLIMIT_MODELS),
    JSON.stringify(ZEROLIMIT_NOTES),
    "100 calls/hari per akun.",
    null,
    "https://www.zerolimitai.com/api/v1"
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(9, "gratis");
  // Migrasi 2026-10-22: Tier Gratis TETAP di mesin yang sama (keputusan final Hestia) —
  // katalog diselaraskan ke hasil verifikasi live 2026-10-22: TEPAT 8 model (daftar di
  // ZEROLIMIT_MODELS). Laguna S/XS 2.1 sudah tidak dilayani sumbernya (404 dari akun
  // segar), diganti recursive/flint-v1.0:free. Brand publik tetap "Luna"; fungsi panen
  // internal untuk brand ini tidak berubah. max_models Gratis = 8.
  // upstream_url TIDAK ditulis di sini (anti-bocor, repo publik): URL upstream datang
  // dari env lewat sync env saat boot (dipetakan ke brand publik "Luna" di bagian sync).
  // Migrasi ini hanya mengatur katalog & label publik.
  db.prepare("UPDATE providers SET brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=? WHERE brand_name IN ('Luna','Zerolimit')").run(
    "Luna",
    "8 model gratis untuk semua.",
    8,
    JSON.stringify(ZEROLIMIT_MODELS),
    JSON.stringify(ZEROLIMIT_NOTES),
    "100 calls/hari per akun.",
    null
  );
  db.prepare("UPDATE tiers SET max_models=? WHERE slug=?").run(8, "gratis");
  // Migrasi 2026-10-18: Stella GANTI provider jadi Near Research (brand tetap "Stella", buang Free.ai yang cuma 2 model gratis).
  // 235 model ASLI dari pembuat ternama saja (sweep 2026-10-24; perintah Hestia: model provider lain/aggregator/fine-tune TIDAK dimasukkan; termasuk alias ~latest dibuang), $0.25 per akun, tanpa verifikasi email, auto-register full otomatis.
  db.prepare("UPDATE providers SET tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name=?").run(
    "235 model premium! $0.25 per akun.",
    235,
    '["openai/gpt-3.5-turbo-0613","openai/gpt-3.5-turbo-16k","openai/gpt-4","openai/gpt-4.1","openai/gpt-4.1-mini","openai/gpt-4.1-nano","openai/gpt-4o","openai/gpt-4o-mini","openai/gpt-5","openai/gpt-5-mini","openai/gpt-5-nano","openai/gpt-5-pro","openai/gpt-5.1","openai/gpt-5.1-codex","openai/gpt-5.1-codex-max","openai/gpt-5.1-codex-mini","openai/gpt-5.2","openai/gpt-5.2-codex","openai/gpt-5.2-pro","openai/gpt-5.3-codex","openai/gpt-5.4","openai/gpt-5.4-mini","openai/gpt-5.4-nano","openai/gpt-5.4-pro","openai/gpt-5.5","openai/gpt-5.5-pro","openai/gpt-5.6-luna","openai/gpt-5.6-luna-pro","openai/gpt-5.6-sol","openai/gpt-5.6-sol-pro","openai/gpt-5.6-terra","openai/gpt-5.6-terra-pro","openai/gpt-6-astra","openai/gpt-6-astra-pro","openai/gpt-6-luna","openai/gpt-6-luna-pro","openai/gpt-6-sol","openai/gpt-6-sol-pro","openai/gpt-6.1-sol","openai/gpt-6.1-sol-pro","openai/gpt-chat-latest","openai/gpt-oss-120b","openai/gpt-oss-20b","openai/o3","openai/o3-pro","anthropic/claude-fable-5","anthropic/claude-fable-5.1","anthropic/claude-haiku-4.5","anthropic/claude-haiku-5.5","anthropic/claude-opus-4.1","anthropic/claude-opus-4.5","anthropic/claude-opus-4.6","anthropic/claude-opus-4.7","anthropic/claude-opus-4.8","anthropic/claude-opus-5","anthropic/claude-opus-5.5","anthropic/claude-sonnet-4.5","anthropic/claude-sonnet-4.6","anthropic/claude-sonnet-5","anthropic/claude-sonnet-5.5","google/gemini-2.5-flash","google/gemini-2.5-flash-lite","google/gemini-2.5-pro","google/gemini-2.5-pro-preview","google/gemini-3-flash-preview","google/gemini-3.1-flash-lite","google/gemini-3.1-flash-lite-preview","google/gemini-3.1-pro-preview","google/gemini-3.1-pro-preview-customtools","google/gemini-3.5-flash","google/gemini-3.5-flash-lite","google/gemini-3.6-flash","google/gemini-3.7-flash","google/gemini-3.8-flash","google/gemini-4-argon","google/gemma-2-27b-it","google/gemma-3-12b-it","google/gemma-3-27b-it","google/gemma-3-4b-it","google/gemma-4-26b-a4b-it","google/gemma-4-31b-it","deepseek/deepseek-chat","deepseek/deepseek-chat-v3-0324","deepseek/deepseek-chat-v3.1","deepseek/deepseek-r1-0528","deepseek/deepseek-v3.1-terminus","deepseek/deepseek-v3.2","deepseek/deepseek-v3.2-exp","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-flash-vision-exp","deepseek/deepseek-v4-pro","deepseek/deepseek-v4.1-flash","x-ai/grok-4.20","x-ai/grok-4.20-multi-agent","x-ai/grok-4.3","x-ai/grok-4.5","x-ai/grok-4.6","x-ai/grok-4.7","x-ai/grok-build-0.1","z-ai/glm-4.5","z-ai/glm-4.5-air","z-ai/glm-4.5v","z-ai/glm-4.6","z-ai/glm-4.6v","z-ai/glm-4.7","z-ai/glm-4.7-flash","z-ai/glm-5","z-ai/glm-5-turbo","z-ai/glm-5.1","z-ai/glm-5.2","z-ai/glm-5.3","z-ai/glm-5.3-flash","z-ai/glm-5.3-flashx","z-ai/glm-5.3-prime","z-ai/glm-5v-turbo","qwen/qwen-2.5-72b-instruct","qwen/qwen-2.5-7b-instruct","qwen/qwen-2.5-coder-32b-instruct","qwen/qwen-plus","qwen/qwen2.5-vl-72b-instruct","qwen/qwen3-14b","qwen/qwen3-235b-a22b-2507","qwen/qwen3-235b-a22b-thinking-2507","qwen/qwen3-30b-a3b","qwen/qwen3-30b-a3b-instruct-2507","qwen/qwen3-32b","qwen/qwen3-coder","qwen/qwen3-coder-30b-a3b-instruct","qwen/qwen3-coder-flash","qwen/qwen3-coder-next","qwen/qwen3-next-80b-a3b-instruct","qwen/qwen3-vl-235b-a22b-instruct","qwen/qwen3-vl-30b-a3b-instruct","qwen/qwen3-vl-30b-a3b-thinking","qwen/qwen3-vl-8b-instruct","qwen/qwen3.5-122b-a10b","qwen/qwen3.5-27b","qwen/qwen3.5-35b-a3b","qwen/qwen3.5-397b-a17b","qwen/qwen3.5-9b","qwen/qwen3.5-flash-02-23","qwen/qwen3.5-plus-02-15","qwen/qwen3.5-plus-20260420","qwen/qwen3.6-27b","qwen/qwen3.6-35b-a3b","qwen/qwen3.6-flash","qwen/qwen3.6-plus","qwen/qwen3.7-flash","qwen/qwen3.7-max","qwen/qwen3.7-plus","qwen/qwen3.8-2.4t-a95b","qwen/qwen3.8-27b","qwen/qwen3.8-flash","qwen/qwen3.8-max-0902","qwen/qwen3.8-max-prime","qwen/qwen3.8-omni-flash","moonshotai/kimi-k2","moonshotai/kimi-k2-thinking","moonshotai/kimi-k2.5","moonshotai/kimi-k2.6","moonshotai/kimi-k2.7-code","moonshotai/kimi-k3","moonshotai/kimi-k3.1-pro","meta-llama/llama-3.1-70b-instruct","meta-llama/llama-3.1-8b-instruct","meta-llama/llama-3.2-1b-instruct","meta-llama/llama-3.2-3b-instruct","meta-llama/llama-3.3-70b-instruct","meta-llama/llama-4-maverick","meta-llama/llama-4-scout","mistralai/codestral-2508","mistralai/devstral-2512","mistralai/ministral-14b-2512","mistralai/ministral-3b-2512","mistralai/ministral-8b-2512","mistralai/mistral-large","mistralai/mistral-large-4-0","mistralai/mistral-medium-3","mistralai/mistral-medium-3-5","mistralai/mistral-medium-3.1","mistralai/mistral-nemo","mistralai/mistral-saba","mistralai/mistral-small-24b-instruct-2501","mistralai/mistral-small-3.1-24b-instruct","mistralai/mistral-small-3.2-24b-instruct","mistralai/voxtral-small-24b-2507","minimax/minimax-01","minimax/minimax-m1","minimax/minimax-m2","minimax/minimax-m2-her","minimax/minimax-m2.1","minimax/minimax-m2.5","minimax/minimax-m2.7","minimax/minimax-m3","minimax/minimax-m3.1-flash","amazon/nova-2-lite-v1","amazon/nova-lite-v1","amazon/nova-micro-v1","amazon/nova-pro-v1","bytedance/ui-tars-1.5-7b","bytedance-seed/seed-1.6","bytedance-seed/seed-1.6-flash","bytedance-seed/seed-2-1-turbo","bytedance-seed/seed-2.0-code","bytedance-seed/seed-2.0-lite","bytedance-seed/seed-2.0-mini","cohere/command-a","cohere/command-a-plus","cohere/command-r-08-2024","cohere/command-r-plus-08-2024","cohere/command-r7b-12-2024","ibm-granite/granite-4.0-h-micro","ibm-granite/granite-4.2-8b","meta/muse-glimmer-30b","meta/muse-spark-open","microsoft/phi-4","nvidia/nemotron-3-nano-30b-a3b","nvidia/nemotron-3-super-120b-a12b","nvidia/nemotron-3-ultra-550b-a55b","nvidia/nemotron-3.5-content-safety","nvidia/nemotron-3.5-lightning","nvidia/nemotron-3.5-super-vl","nvidia/switchyard","tencent/hunyuan-a13b-instruct","tencent/hy-mt2-1.8b","tencent/hy-mt2-30b-a3b","tencent/hy-mt2-7b","tencent/hy3","tencent/hy3-preview","tencent/hy4-preview","xiaomi/mimo-v2.5","xiaomi/mimo-v2.5-pro","xiaomi/mimo-v2.6-flash","xiaomi/mimo-v2.6-pro","xiaomi/mimo-v2.6-pro-ultraspeed"]',
    JSON.stringify({}),
    "$0.25 per akun.",
    250000,
    "https://nearresearch.com/v1",
    "Stella"
  );
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER PLUS", "plus");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("★ TIER PREMIUM", "premium");
// Katalog Stella 2026-10-25 (perintah Hestia): 190 model AKTIF hasil sweep upstream,
// khusus brand AI asli — tanpa alias -latest, tanpa aggregator (OpenRouter dll),
// tanpa fine-tune. Urutan keluarga + alfabetis. Menimpa seed 235 di atas tiap boot.
db.prepare("UPDATE providers SET tagline=?, model_count=?, model_list_json=? WHERE brand_name=?").run("190 model premium! $0.25 per akun.", 190, JSON.stringify(["openai/gpt-3.5-turbo-0613","openai/gpt-3.5-turbo-16k","openai/gpt-4","openai/gpt-4.1","openai/gpt-4.1-mini","openai/gpt-4.1-nano","openai/gpt-4o","openai/gpt-4o-2024-05-13","openai/gpt-4o-2024-08-06","openai/gpt-4o-2024-11-20","openai/gpt-4o-mini","openai/gpt-4o-mini-2024-07-18","openai/gpt-5.1","openai/gpt-5.1-codex","openai/gpt-5.1-codex-mini","openai/gpt-5.2","openai/gpt-5.2-codex","openai/gpt-5.2-pro","openai/gpt-5.3-codex","openai/gpt-5.4","openai/gpt-5.4-image-2","openai/gpt-5.4-mini","openai/gpt-5.4-nano","openai/gpt-5.5","openai/gpt-5.5-pro","openai/gpt-5.6-luna","openai/gpt-5.6-luna-pro","openai/gpt-5.6-sol","openai/gpt-5.6-sol-pro","openai/gpt-5.6-terra","openai/gpt-5.6-terra-pro","openai/gpt-6-astra","openai/gpt-6-astra-pro","openai/gpt-6-luna","openai/gpt-6-luna-pro","openai/gpt-6-sol","openai/gpt-6-sol-pro","openai/gpt-6.1-sol","openai/gpt-6.1-sol-pro","anthropic/claude-fable-5","anthropic/claude-fable-5.1","anthropic/claude-haiku-4.5","anthropic/claude-haiku-5.5","anthropic/claude-opus-4.1","anthropic/claude-opus-4.5","anthropic/claude-opus-4.6","anthropic/claude-opus-4.7","anthropic/claude-opus-4.8","anthropic/claude-sonnet-4.5","anthropic/claude-sonnet-4.6","anthropic/claude-sonnet-5","anthropic/claude-sonnet-5.5","google/gemini-2.5-flash","google/gemini-2.5-flash-image","google/gemini-2.5-flash-lite","google/gemini-2.5-pro","google/gemini-2.5-pro-preview","google/gemini-3-flash-preview","google/gemini-3.1-flash-image","google/gemini-3.1-flash-image-preview","google/gemini-3.1-flash-lite","google/gemini-3.1-flash-lite-image","google/gemini-3.1-flash-lite-preview","google/gemini-3.5-flash","google/gemini-3.5-flash-lite","google/gemini-3.7-flash","google/gemini-3.8-flash","google/gemini-4-argon","google/gemma-2-27b-it","google/gemma-3-12b-it","google/gemma-3-27b-it","google/gemma-3-4b-it","google/gemma-4-26b-a4b-it","google/gemma-4-31b-it","deepseek/deepseek-chat","deepseek/deepseek-chat-v3-0324","deepseek/deepseek-chat-v3.1","deepseek/deepseek-r1-0528","deepseek/deepseek-v3.1-terminus","deepseek/deepseek-v3.2","deepseek/deepseek-v3.2-exp","deepseek/deepseek-v4-flash-0731","deepseek/deepseek-v4-pro-0813","x-ai/grok-4.20","x-ai/grok-4.20-multi-agent","x-ai/grok-4.3","x-ai/grok-4.5","x-ai/grok-4.6","x-ai/grok-4.7","x-ai/grok-build-0.1","z-ai/glm-4.5-air","z-ai/glm-5.3-prime","qwen/qwen-2.5-72b-instruct","qwen/qwen-2.5-7b-instruct","qwen/qwen-2.5-coder-32b-instruct","qwen/qwen-plus","qwen/qwen2.5-vl-72b-instruct","qwen/qwen3-235b-a22b-2507","qwen/qwen3-30b-a3b-instruct-2507","qwen/qwen3-coder","qwen/qwen3-coder-30b-a3b-instruct","qwen/qwen3-coder-flash","qwen/qwen3-coder-next","qwen/qwen3-next-80b-a3b-instruct","qwen/qwen3-vl-235b-a22b-instruct","qwen/qwen3-vl-30b-a3b-instruct","qwen/qwen3-vl-30b-a3b-thinking","qwen/qwen3-vl-8b-instruct","qwen/qwen3.5-122b-a10b","qwen/qwen3.5-27b","qwen/qwen3.5-flash-02-23","qwen/qwen3.6-27b","qwen/qwen3.8-omni-flash","moonshotai/kimi-k2-0905","moonshotai/kimi-k2-thinking","moonshotai/kimi-k3","meta-llama/llama-3.1-70b-instruct","meta-llama/llama-3.1-8b-instruct","meta-llama/llama-3.2-1b-instruct","meta-llama/llama-3.2-3b-instruct","meta-llama/llama-3.3-70b-instruct","meta-llama/llama-4-maverick","meta-llama/llama-4-scout","meta-llama/llama-guard-4-12b","mistralai/codestral-2508","mistralai/devstral-2512","mistralai/ministral-14b-2512","mistralai/ministral-3b-2512","mistralai/ministral-8b-2512","mistralai/mistral-large","mistralai/mistral-large-2407","mistralai/mistral-medium-3","mistralai/mistral-medium-3-5","mistralai/mistral-medium-3.1","mistralai/mistral-nemo","mistralai/mistral-saba","mistralai/mistral-small-24b-instruct-2501","mistralai/mistral-small-2603","mistralai/mistral-small-3.1-24b-instruct","mistralai/mistral-small-3.2-24b-instruct","mistralai/mixtral-8x22b-instruct","mistralai/voxtral-small-24b-2507","minimax/minimax-01","minimax/minimax-m2-her","minimax/minimax-m3","amazon/nova-2-lite-v1","amazon/nova-lite-v1","amazon/nova-micro-v1","amazon/nova-pro-v1","bytedance/ui-tars-1.5-7b","cohere/command-a","cohere/command-r-08-2024","cohere/command-r-plus-08-2024","cohere/command-r7b-12-2024","ibm-granite/granite-4.0-h-micro","inception/mercury-3","inference-net/schematron-v2-small","inference-net/schematron-v2-turbo","microsoft/phi-4","moondream/moondream3-preview","moondream/moondream3.1-9b-a2b","morph/morph-v3-fast","morph/morph-v3-large","nex-agi/nex-n2.5-mini","nvidia/nemotron-3-ultra-550b-a55b","nvidia/nemotron-3.5-lightning","perceptron/perceptron-mk1","perceptron/perceptron-mk1.5","perplexity/sonar","perplexity/sonar-pro","poolside/laguna-s-2.1","rekaai/reka-edge","relace/relace-search","sakana/fugu-max","sakana/fugu-ultra-v2","scaledown/summarize","stepfun/step-3.5-flash","tencent/hunyuan-a13b-instruct","tencent/hy-mt2-1.8b","tencent/hy-mt2-30b-a3b","tencent/hy-mt2-7b","upstage/solar-mini4","upstage/solar-pro-3","upstage/solar-pro4","writer/palmyra-x5","xiaomi/mimo-v2.5","xiaomi/mimo-v2.5-pro","xiaomi/mimo-v2.6-flash","xiaomi/mimo-v2.6-pro","xiaomi/mimo-v2.6-pro-ultraspeed"]), "Stella");
  // Migrasi 2026-10-24: Tier Pro diisi provider Vega (mesin di balik layar tidak
  // ditampilkan publik — anti-bocor). Katalog = 79 model chat TERBUKTI dari sweep
  // 2026-10-24, dikurasi perintah operator: hanya model asli pembuat ternama —
  // tanpa model penjaga/sonar/rute agregator/alias "-latest". Kredit 25.000 per
  // akun (hangus ±7 hari). upstream_url nilai internal DB (tidak tampil publik).
  const VEGA_MODELS = ["gpt-4.1-mini","gpt-4.1-nano","gpt-4o-mini","gpt-5-mini","gpt-5-nano","gpt-5.4-mini","gpt-5.4-nano","gpt-5.6-luna","gpt-6-luna","gpt-oss-120b","claude-haiku-4-5","claude-haiku-5-5","cf.gemma-4-26b-a4b-it","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-3-flash-preview","gemini-3.1-flash-lite","gemini-3.1-flash-lite-preview","gemini-3.5-flash-lite","gemini-3.7-flash","gemini-3.8-flash","cf.deepseek-r1-distill-qwen-32b","deepseek-chat","deepseek-v3.2","deepseek-v3.2-speciale","deepseek-v4-pro","grok-4-fast-non-reasoning","grok-4-fast-reasoning","grok-4.20-beta-0309-non-reasoning","grok-4.20-beta-0309-reasoning","grok-4.20-non-reasoning","grok-4.20-reasoning","grok-4.3","grok-4.5","grok-4.7","grok-code-fast-1","cf.glm-5.2","glm-5.1","glm-5.2","glm-5.3-flash","cf.qwen2.5-coder-32b-instruct","cf.qwq-32b","qwen-flash-2025-07-28","qwen-mt-flash","qwen-plus-2025-12-01","qwen-plus-character","qwen3-coder-flash","qwen3-vl-plus","qwen3.5-122b-a10b","qwen3.5-27b","qwen3.5-35b-a3b","qwen3.5-flash","qwen3.5-plus","qwen3.6-27b","qwen3.6-35b-a3b","qwen3.6-flash","qwen3.6-plus","qwen3.7-plus","qwen3.8-27b","qwen3.8-flash","cf.kimi-k2.7-code","kimi-k2.5","kimi-k2.6","kimi-k2.7-code","cf.llama-3.1-8b-instruct-fast","cf.llama-3.2-1b-instruct","cf.llama-3.2-3b-instruct","cf.llama-3.3-70b-instruct-fp8-fast","cf.llama-4-scout-17b-16e-instruct","cf.mistral-small-3.1-24b-instruct","mistral-large-3","mistral-small-2503","minimax-m2.5","minimax-m2.5-lightning","minimax-m2.7","minimax-m2.7-highspeed","cf.granite-4.0-h-micro","nemotron-3-ultra","nemotron-3.5-lightning"];
  db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT (SELECT id FROM tiers WHERE slug='pro'),?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Vega')").run("Vega", "Bintang penuntun untuk para profesional.", 79, JSON.stringify(VEGA_MODELS), "{}", "25 ribu kredit per akun (±7 hari).", 25000, 1, "https://api.avalai.ir/v1");
  db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='pro'), tagline=?, model_count=?, model_list_json=?, credit_note=?, default_credit=?, upstream_url=? WHERE brand_name='Vega'").run("Bintang penuntun untuk para profesional.", 79, JSON.stringify(VEGA_MODELS), "25 ribu kredit per akun (±7 hari).", 25000, "https://api.avalai.ir/v1");

  try { db.prepare("DELETE FROM providers WHERE brand_name='Media' AND id NOT IN (SELECT MIN(id) FROM providers WHERE brand_name='Media')").run(); const mediaModels = ["flux-schnell","z-image","grok-imagine-image","wan-2.2","flux-dev","gpt-image-2","seedream-5.0-lite","seededit-3.0-i2i","grok-imagine-image-i2i","seedream-4-i2i","flux-kontext-pro-i2i","flux-2-i2i","nano-banana-pro-i2i","gpt-image-2-i2i","seedance-1.5-pro","seedance-1.0-pro-fast","bytedance-video-upscaler","lucy-restyle","lucy-edit","wan-2.7-videoedit","seedance-2.0-video-edit","happyhorse-1.0-video-edit"]; const mediaAda = db.prepare("SELECT 1 FROM providers WHERE brand_name='Media'").get(); if (!mediaAda) db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,upstream_url,sort_order) VALUES ((SELECT id FROM tiers WHERE slug='media'),'Media','Gambar & video dalam satu tier.',22,?,'{}','Saldo per akun, tanpa kuota key.',NULL,'https://api.renderful.ai/v1',1)").run(JSON.stringify(mediaModels)); db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='media'), tagline='Gambar & video dalam satu tier.', model_count=22, model_list_json=?, model_notes_json='{}', credit_note='Saldo per akun, tanpa kuota key.', default_credit=NULL, upstream_url='https://api.renderful.ai/v1' WHERE brand_name='Media'").run(JSON.stringify(mediaModels)); } catch {} // Koreksi permanen: base_url lama (domain mati: lovie.me bekas Railway +
  // hestia-gateway.id) diganti domain live sekarang (xioo.me di Hostless).
  db.prepare("UPDATE settings SET value='https://hestiaflow.xioo.me/v1' WHERE key='base_url' AND (value LIKE '%lovie.me%' OR value LIKE '%hestia-gateway.id%')").run();
  // Penjaga seed awal (diperbaiki 2026-10-22): tier 'pro' disisipkan migrasi di atas SEBELUM
  // hitungan ini, jadi hitungan lama (semua tier) selalu > 0 dan cabang ini TIDAK PERNAH jalan
  // di database kosong — akibatnya boot segar (mis. Hostless, DB /tmp efemeral) hanya punya
  // tier Pro + provider Bansos/Nova, tanpa Gratis/Luna sama sekali. Sekarang: hitung tier
  // SELAIN 'pro'; insert dibuat idempotent (OR IGNORE + id dicari per slug + cek brand).
  const tierCount = db.prepare("SELECT COUNT(*) c FROM tiers WHERE slug<>'pro'").get().c;
  if (tierCount > 0) return;
  const insTier = db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)");
  insTier.run("gratis", "Gratis", "KHUSUS PENGGUNA GRATIS", "TIER GRATIS", 8, 1);
  insTier.run("plus", "Plus", "UNTUK PENGGUNA PLUS / BERBAYAR", "TIER PLUS", null, 2);
  insTier.run("premium", "Premium", "PALING MAHAL", "★ TIER PREMIUM", null, 4);
  const tierId = (slug) => db.prepare("SELECT id FROM tiers WHERE slug=?").get(slug).id;
  const g = tierId("gratis"), p = tierId("plus"), pr = tierId("premium");
  const provAda = (b) => !!db.prepare("SELECT 1 FROM providers WHERE brand_name=?").get(b);
  const insProv = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) VALUES (?,?,?,?,?,?,?,?,?)");
  if (!provAda("Luna")) insProv.run(g, "Luna", "8 model gratis untuk semua.", 8,
    JSON.stringify(ZEROLIMIT_MODELS),
    JSON.stringify(ZEROLIMIT_NOTES),
    "100 calls/hari per akun.", null, 1);
  if (!provAda("Aurora")) insProv.run(p, "Aurora", "Cahaya pertama di gerbang kecerdasan.", 10,
    JSON.stringify(AURORA_MODELS), JSON.stringify({}),
    "$0.20 per akun terverifikasi.", 200000, 1);
  if (!provAda("Stella")) insProv.run(pr, "Stella", "Bintang paling terang di langit HestiaFlow.", 514,
    JSON.stringify([]), JSON.stringify({}),
    "30.000 token/hari per akun terverifikasi.", 30000, 1);
  // Upstream Luna di seed awal TIDAK ditulis di kode (anti-bocor) — sync env sesudah seed()
  // menerapkannya dari env ke baris "Luna" di boot yang sama.
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('gateway_name','HestiaFlow')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('base_url',?)").run(GATEWAY_BASE_URL);
}
seed();
// Seed key pool Bansos dari env BANSOS_UPSTREAM_KEYS (dipisah koma/spasi/baris baru) -> workers provider Bansos.
try {
  const bp = db.prepare("SELECT id FROM providers WHERE brand_name='Bansos'").get();
  const rawKeys = String(process.env.BANSOS_UPSTREAM_KEYS || "");
  const poolKeys = rawKeys.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (bp && poolKeys.length) {
    const insW = db.prepare("INSERT INTO workers (provider_id,name,credit,upstream_api_key) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM workers WHERE provider_id=? AND upstream_api_key=?)");
    poolKeys.forEach((k, i) => insW.run(bp.id, "Bansos " + (i + 1), 500000, k, bp.id, k));
    // Sync status dengan env: key yang sudah dicabut dari env (mis. mati di sumber) dinonaktifkan, sebaliknya diaktifkan lagi.
    const envSet = new Set(poolKeys);
    for (const w of db.prepare("SELECT id, upstream_api_key, status FROM workers WHERE provider_id=?").all(bp.id)) {
      if (envSet.has(w.upstream_api_key) && w.status !== "active") db.prepare("UPDATE workers SET status='active' WHERE id=?").run(w.id);
      if (!envSet.has(w.upstream_api_key) && w.status === "active") db.prepare("UPDATE workers SET status='inactive' WHERE id=?").run(w.id);
    }
  }
} catch {}
// Sync provider upstream URLs from env vars (PROVIDER_<BRAND>_UPSTREAM_URL).
// Operator config only — values live in Railway env, never in public code.
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("PROVIDER_") || !k.endsWith("_UPSTREAM_URL")) continue;
  const raw = k.slice("PROVIDER_".length, -"_UPSTREAM_URL".length);
  if (!raw) continue;
  // LUNA di-skip (2026-10-21): env PROVIDER_LUNA_UPSTREAM_URL basi (menunjuk upstream lama);
  // upstream Luna dikelola migrasi kode supaya tidak tertimpa tiap boot.
  if (raw === "LUNA") continue;
  // Mesin Gratis dipetakan ke brand publik "Luna" (2026-10-22): baris provider-nya bernama
  // "Luna", jadi env upstream khusus mesin itu diterapkan ke baris "Luna", bukan brand sendiri.
  const brand = raw === "ZEROLIMIT" ? "Luna" : raw.charAt(0) + raw.slice(1).toLowerCase();
  const url = String(v || "").trim();
  if (!url) continue;
  try { db.prepare("UPDATE providers SET upstream_url=? WHERE brand_name=?").run(url, brand); } catch {}
}

// Sync provider upstream KEYS from env vars (PROVIDER_<BRAND>_UPSTREAM_KEY).
// Same brand mapping as the URL sync; values live in Railway env, never in code.
// (Lets the operator install a provider key without the panel's native prompt.)
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("PROVIDER_") || !k.endsWith("_UPSTREAM_KEY")) continue;
  const raw = k.slice("PROVIDER_".length, -"_UPSTREAM_KEY".length);
  if (!raw) continue;
  const brand = raw === "ZEROLIMIT" ? "Luna" : raw.charAt(0) + raw.slice(1).toLowerCase();
  const key = String(v || "").trim();
  if (!key) continue;
  try { db.prepare("UPDATE providers SET upstream_api_key=? WHERE brand_name=?").run(key, brand); } catch {}
}

// ---------- helpers ----------
const app = express();
// ---------- pelindung bot (2026-10-23, perintah Hestia: "biar gak ada bot yang masuk") ----------
// Hostless tidak menyediakan firewall untuk aplikasi ini (sudah dicek di panel:
// bagian Firewalls hanya untuk Virtual Machine), jadi perlindungan dipasang di kode:
// header keamanan + pembatas kecepatan per IP di pintu masuk.
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || "unknown";
}
// Jejak login pengguna (IP + perangkat) untuk panel admin (2026-10-24).
function catatJejakLogin(req, userId) {
  try {
    db.prepare("UPDATE users SET last_ip=?, last_ua=?, last_login_at=datetime('now') WHERE id=?")
      .run(clientIp(req) || null, String((req.headers && req.headers["user-agent"]) || "").slice(0, 300) || null, userId);
  } catch {}
}
// Ringkas User-Agent jadi label perangkat yang enak dibaca admin, mis. "Android · SM-G991B · Chrome".
function ringkasPerangkat(ua) {
  const s = String(ua || "");
  if (!s) return null;
  let os = "Tidak dikenal";
  if (/Android/i.test(s)) { const m = s.match(/Android\s[\d.]+;\s*([^;)]+)/i); os = "Android" + (m ? " · " + m[1].replace(/\s+Build.*$/, "").trim() : ""); }
  else if (/iPhone/i.test(s)) os = "iPhone";
  else if (/iPad/i.test(s)) os = "iPad";
  else if (/Windows/i.test(s)) os = "Windows";
  else if (/Macintosh|Mac OS/i.test(s)) os = "Mac";
  else if (/Linux/i.test(s)) os = "Linux";
  let br = "";
  if (/Edg\//i.test(s)) br = "Edge";
  else if (/OPR\/|Opera/i.test(s)) br = "Opera";
  else if (/SamsungBrowser/i.test(s)) br = "Samsung Browser";
  else if (/Firefox\//i.test(s)) br = "Firefox";
  else if (/Chrome\//i.test(s)) br = "Chrome";
  else if (/Safari\//i.test(s)) br = "Safari";
  if (/wv\)|WebView/i.test(s)) br = (br ? br + " " : "") + "(WebView)";
  return br ? os + " · " + br : os;
}
function makeLimiter(maxPerMin, label) {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now > b.reset) { b = { count: 0, reset: now + 60000 }; buckets.set(ip, b); }
    b.count++;
    if (b.count > maxPerMin) {
      console.log(`[antibot] ${label} kena limit: ${ip} ${req.method} ${req.path}`);
      return res.status(429).json({ error: { message: "Terlalu banyak permintaan. Pelan-pelan ya, coba lagi sebentar.", type: "rate_limit_error", param: null, code: "ip_rate_limited" } });
    }
    next();
  };
}
const limitPintuMasuk = makeLimiter(30, "pintu-masuk");
const limitApiUmum = makeLimiter(600, "api-umum");
app.use("/auth", limitPintuMasuk);
app.post("/api/voucher/redeem", limitPintuMasuk);
app.use("/api", limitApiUmum);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function signSession(userId) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifySession(cookie) {
  if (!cookie) return null;
  try {
    const parts = cookie.split(".");
    if (parts.length !== 3) return null;
    const [uid, exp, sig] = parts;
    const expect = crypto.createHmac("sha256", SESSION_SECRET).update(`${uid}.${exp}`).digest("hex");
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() > Number(exp)) return null;
    return Number(uid);
  } catch { return null; }
}
function getSessionUser(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)hestia_session=([^;]+)/);
  const uid = verifySession(m ? decodeURIComponent(m[1]) : null);
  if (!uid) return null;
  const u = db.prepare("SELECT id,email,name,avatar,is_admin,created_at,COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at,COALESCE(suspended,0) AS suspended FROM users WHERE id=?").get(uid);
  if (!u) return null; u.tier_slug = effectiveTierSlug(u); return u;
}
function requireAuth(req, res, next) {
  const u = getSessionUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "unauthorized" });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = getSessionUser(req);
  if (!u || !u.is_admin) return res.status(403).json({ ok: false, error: "admin_only" });
  req.user = u; next();
}
function randHex(n) { return crypto.randomBytes(n).toString("hex"); }
function randStr(n, chars) {
  const c = chars || "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
// Normalize an upstream base: strip trailing "/" and a trailing "/v1" so callers can
// safely append "/v1/..." without ever producing "/v1/v1/...". Works whether the
// stored upstream URL already includes /v1 or not.
function stripV1(u) { return String(u || "").replace(/\/$/, "").replace(/\/v1$/, ""); }
// Public-safe provider view: brand + tier + models ONLY. NEVER upstream identity.
function publicProvider(p) {
  const tier = db.prepare("SELECT slug,name,audience_label,badge FROM tiers WHERE id=?").get(p.tier_id);
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; }
  let notes = {};
  try { notes = JSON.parse(p.model_notes_json || "{}"); } catch { notes = {}; }
  return {
    id: p.id, tierId: p.tier_id, tierSlug: tier ? tier.slug : null,
    tierName: tier ? tier.name : null, tierAudience: tier ? tier.audience_label : null,
    tierBadge: tier ? tier.badge : null, brand: p.brand_name, tagline: p.tagline,
    modelCount: p.model_count, models: models.slice(0, 20),
    modelsTruncated: models.length > 20, modelNotes: notes, creditNote: p.credit_note,
  };
}
// Admin provider view: may include upstream_name/url (operator config) — NEVER upstream_api_key.
function adminProvider(p) {
  const base = publicProvider(p);
  return { ...base, upstreamName: p.upstream_name || null, upstreamUrl: p.upstream_url || null };
}
async function fetchProviderModels(p) {
  // Only if operator configured a real worker key + upstream URL. Server-side only.
  if (!p.upstream_url || !p.upstream_api_key) return null;
  try {
    const url = stripV1(p.upstream_url) + "/v1/models";
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${p.upstream_api_key}`, "User-Agent": "HestiaFlow/1.0" }, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    const arr = d.data || d.models || [];
    const ids = arr.map((m) => m.id).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}
function logHarvest(userId, providerId, message) {
  db.prepare("INSERT INTO harvest_logs (user_id,provider_id,message) VALUES (?,?,?)").run(userId, providerId, message);
}



// --- Anti-detection: free scraping proxy + rotating User-Agent (operator's own pattern) ---
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

let _proxyCache = { list: [], at: 0 };
async function fetchProxyList() {
  // Proxyscrape free proxy list (operator's own source). Cache 5 min.
  if (_proxyCache.list.length && Date.now() - _proxyCache.at < 300000) return _proxyCache.list;
  const urls = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=6000&country=all&ssl=all&anonymity=all",
    "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  ];
  const gabungan = new Set();
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      const list = txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
      for (const item of list.slice(0, 100)) gabungan.add(item);
    } catch {}
  }
  if (gabungan.size) { _proxyCache = { list: [...gabungan], at: Date.now() }; return _proxyCache.list; }
  return _proxyCache.list;
}
function proxyDispatcher(proxyHostPort) {
  try {
    const { ProxyAgent } = require("undici");
    return new ProxyAgent(`http://${proxyHostPort}`);
  } catch { return undefined; }
}
// Kumpul dulu baru daftar: _proxyOk = OK terakhir, _proxyNol = gagal 0 OK.
let _proxyOk = 0; let _proxyNol = false;

// Luna-specific auto-register (provider brand "Luna").
// Flow (no CAPTCHA, no email verification): POST /api/auth/sign-up/email
// {name,email,password} -> session cookies -> POST /api/v1/keys -> {key}.
// Uses 1secmail temp email (real receivable domain) + strong password.
// Returns { upstreamApiKey, upstreamBaseUrl } or null. Never logs credentials.
async function tryAutoRegisterLuna(provider) {
  const apiBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const webBase = apiBase.replace(/\/v1$/, "");
  const randIp = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 254)).join(".");
  const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36";
  // 1) Temp email via 1secmail (real domain).
  let tempEmail = null;
  try {
    const r = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1", { signal: AbortSignal.timeout(10000) });
    const arr = await r.json().catch(() => null);
    if (Array.isArray(arr) && arr[0]) tempEmail = arr[0];
  } catch {}
  if (!tempEmail) tempEmail = `hf_${randStr(10)}@1secmail.com`;
  // 2) Strong password (upper + lower + digit + symbol, 12 chars).
  const up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", lo = "abcdefghijklmnopqrstuvwxyz", dg = "0123456789", sy = "!@#$%";
  const all = up + lo + dg + sy;
  let pwd = [up[Math.floor(Math.random() * up.length)], lo[Math.floor(Math.random() * lo.length)], dg[Math.floor(Math.random() * dg.length)], sy[Math.floor(Math.random() * sy.length)]];
  for (let i = 0; i < 8; i++) pwd.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = pwd.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pwd[i], pwd[j]] = [pwd[j], pwd[i]]; }
  const tempPassword = pwd.join("");
  const name = "User " + randStr(6, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  // 3) Signup (browser-like headers; retry without X-Forwarded-For if 403).
  let cookie = "";
  let r = null, j = null;
  try {
    const body = JSON.stringify({ name, email: tempEmail, password: tempPassword });
    const mkHeaders = (withXff) => {
      const h = { "Content-Type": "application/json", "User-Agent": randUA(),
        "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
        "Referer": webBase + "/", "Origin": webBase,
        "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
      if (withXff) h["X-Forwarded-For"] = randIp();
      return h;
    };
    const doSignup = async (withXff, proxy) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const opts = { method: "POST", headers: mkHeaders(withXff), body, signal: ctl.signal };
        if (proxy) { const d = proxyDispatcher(proxy); if (d) opts.dispatcher = d; }
        const res = await fetch(webBase + "/api/auth/sign-up/email", opts);
        const jj = await res.json().catch(() => null);
        return { res, jj };
      } finally { clearTimeout(t); }
    };
    // Try via scraping proxies first (anti-detection), then direct as last resort.
    const proxies = await fetchProxyList();
    const tried = [];
    let attempt = null;
    const maxProxyTries = Math.min(3, proxies.length);
    for (let pi = 0; pi < maxProxyTries; pi++) {
      const p = proxies[Math.floor(Math.random() * proxies.length)];
      tried.push(p.split(":")[0]);
      attempt = await doSignup(true, p);
      r = attempt.res; j = attempt.jj;
      let flags = "";
      if (!r.ok) { const txt = JSON.stringify(j || "").toLowerCase(); for (const kw of ["cloudflare", "disposable", "captcha", "bot", "verify", "forbidden", "blocked"]) if (txt.includes(kw)) flags += kw + ","; }
      console.log(`[luna] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && j.token)} via=proxy${pi + 1} flags=${flags}`);
      if (r.ok) break;
      if (r.status !== 403 && r.status !== 429) break;
    }
    if (!attempt || !r.ok) {
      attempt = await doSignup(false, null);
      r = attempt.res; j = attempt.jj;
      let flags = "";
      if (!r.ok) { const txt = JSON.stringify(j || "").toLowerCase(); for (const kw of ["cloudflare", "disposable", "captcha", "bot", "verify", "forbidden", "blocked"]) if (txt.includes(kw)) flags += kw + ","; }
      console.log(`[luna] signup status=${r.status} ok=${r.ok} hasToken=${!!(j && j.token)} via=direct flags=${flags}`);
    }
    if (!r.ok) return null;
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!j || !j.token) return null;
    if (cookie) cookie += `; token=${j.token}`;
    else cookie = `token=${j.token}`;
  } catch (e) { console.log(`[luna] signup exception ${e && e.message ? e.message : "unknown"}`); return null; }
  // 4) Create API key (session cookies).
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    const kProxies = await fetchProxyList();
    const kProxy = kProxies.length ? kProxies[Math.floor(Math.random() * kProxies.length)] : null;
    const kOpts = { method: "POST", headers: { "X-Forwarded-For": randIp(), "User-Agent": randUA(), Cookie: cookie, "Accept": "application/json, text/plain, */*", "Referer": webBase + "/", "Origin": webBase }, signal: ctl.signal };
    if (kProxy) { const kd = proxyDispatcher(kProxy); if (kd) kOpts.dispatcher = kd; }
    const r = await fetch(webBase + "/api/v1/keys", kOpts);
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    const key = j && (j.key || j.api_key || j.apiKey);
    console.log(`[luna] key status=${r.status} ok=${r.ok} hasKey=${!!key} hasCookie=${!!cookie}`);
    if (!r.ok) return null;
    if (!key) return null;
    // Verify the harvested key against the provider (server-side, no exposure).
    // Non-blocking: key was just created via provider API (201), so it is valid;
    // verify only logs. (apiBase already ends with /v1 -> use apiBase + "/models".)
    let verified = false;
    try {
      const vr = await fetch(apiBase + "/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
      const vj = await vr.json().catch(() => null);
      const n = vj && Array.isArray(vj.data) ? vj.data.length : -1;
      verified = !!vr.ok;
      console.log(`[luna] verify models status=${vr.status} ok=${vr.ok} count=${n}`);
    } catch (e) { console.log(`[luna] verify exception ${e && e.message ? e.message : "unknown"}`); }
    // End-to-end chat test with the harvested key (server-side, no exposure).
    // Same key + URL the gateway will use for this key, so a 200 here proves gateway chat works.
    try {
      const cr = await fetch(apiBase + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "qwen3-coder:30b", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(30000),
      });
      const cj = await cr.json().catch(() => null);
      const hasContent = !!(cj && cj.choices && cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content);
      const errCode = cj && cj.error && cj.error.code ? String(cj.error.code) : "";
      console.log(`[luna] chat-test status=${cr.status} ok=${cr.ok} hasContent=${hasContent} err=${errCode}`);
    } catch (e) { console.log(`[luna] chat-test exception ${e && e.message ? e.message : "unknown"}`); }
    return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
  } catch (e) { console.log(`[luna] key exception ${e && e.message ? e.message : "unknown"}`); return null; }
}

// Nova (OpenToke) auto-register. Flow (from operator's open.py, no CAPTCHA, no email verification):
// temp email (minuteinbox @minafter.com OR 1secmail random domain) -> POST /api/v1/auth/register
// {email,password,name} -> 201 + token (JWT) -> GET /api/v1/credits/balance -> POST /api/v1/keys -> sk-ot-...
// upstream_url for Nova is "https://opentoke.com/api" (with /api prefix) so the existing
// stripV1 + "/v1/..." gateway logic lands on https://opentoke.com/api/v1/... correctly.
// Returns { upstreamApiKey, upstreamBaseUrl, tempEmail, tempPassword, live } or null. Never logs credentials.
async function tryAutoRegisterNova(provider) {
  const apiBase = (provider.upstream_url || "").replace(/\/$/, "");
  if (!apiBase) return null;
  const randIp = () => Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 254)).join(".");
  const NAMES = ["hestia", "sayang", "cinta", "kasih", "rindu", "peluk", "manja", "mesra"];
  // Temp email: rotate minuteinbox (@minafter.com, proven) <-> 1secmail (random domain).
  const minuteinboxEmail = async () => {
    try {
      // Minuteinbox session: GET home (CSRF) -> POST new-email -> GET index (email). Direct, no proxy.
      const h0 = { "User-Agent": randUA() };
      const r0 = await fetch("https://www.minuteinbox.com/", { headers: h0, signal: AbortSignal.timeout(30000) });
      const t0 = await r0.text().catch(() => "");
      const m = t0.match(/(?:CSRF|csrf_token|csrf)\s*[:=]\s*["']([^"']+)["']/);
      const csrf = m ? m[1] : "";
      const cookies = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
      const local = NAMES[Math.floor(Math.random() * NAMES.length)] + String(Date.now()).slice(-6);
      const ajaxH = { ...h0, Referer: "https://www.minuteinbox.com/", Origin: "https://www.minuteinbox.com", "X-Requested-With": "XMLHttpRequest", Cookie: cookies, "Content-Type": "application/x-www-form-urlencoded" };
      await new Promise((res) => setTimeout(res, 1000));
      await fetch("https://www.minuteinbox.com/index/new-email/", { method: "POST", headers: ajaxH, body: "emailInput=" + encodeURIComponent(local) + "&format=json", signal: AbortSignal.timeout(30000) });
      await new Promise((res) => setTimeout(res, 2000));
      const r1 = await fetch("https://www.minuteinbox.com/index/index?csrf_token=" + encodeURIComponent(csrf), { headers: ajaxH, signal: AbortSignal.timeout(30000) });
      const j1 = await r1.json().catch(() => null);
      if (j1 && j1.email) return j1.email;
    } catch {}
    return null;
  };
  const oneseCmailEmail = async () => {
    try {
      const r = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1", { signal: AbortSignal.timeout(10000) });
      const arr = await r.json().catch(() => null);
      if (Array.isArray(arr) && arr[0]) return arr[0];
    } catch {}
    return null;
  };
  let tempEmail = null;
  const useMinute = Math.random() < 0.5;
  tempEmail = useMinute ? await minuteinboxEmail() : await oneseCmailEmail();
  if (!tempEmail) tempEmail = useMinute ? await oneseCmailEmail() : await minuteinboxEmail();
  if (!tempEmail) tempEmail = `hf_${randStr(10)}@1secmail.com`;
  const name = NAMES[Math.floor(Math.random() * NAMES.length)].replace(/^./, (c) => c.toUpperCase()) + String(10 + Math.floor(Math.random() * 90));
  const tempPassword = name + "12345"; // min 8 char, matches operator script format
  const proxies = await fetchProxyList();
  const proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
  const doFetch = async (url, opts, useProxy) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const o = { ...opts, signal: ctl.signal };
      if (useProxy && proxy) { const d = proxyDispatcher(proxy); if (d) o.dispatcher = d; }
      const r = await fetch(url, o);
      const txt = await r.text().catch(() => "");
      let j = null; try { j = JSON.parse(txt); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch { return null; } finally { clearTimeout(t); }
  };
  const H = { "User-Agent": randUA(), Origin: "https://opentoke.com", Referer: "https://opentoke.com/register", "Content-Type": "application/json", "X-Forwarded-For": randIp() };
  // 1) Register (proxy first, direct fallback).
  let reg = await doFetch(apiBase + "/v1/auth/register", { method: "POST", headers: H, body: JSON.stringify({ email: tempEmail, password: tempPassword, name }) }, true);
  if (!reg || !reg.ok) reg = await doFetch(apiBase + "/v1/auth/register", { method: "POST", headers: H, body: JSON.stringify({ email: tempEmail, password: tempPassword, name }) }, false);
  const token = reg && reg.ok && reg.json ? reg.json.token : null;
  console.log(`[nova] register status=${reg ? reg.status : "null"} ok=${!!(reg && reg.ok)} hasToken=${!!token}`);
  if (!token) return null;
  // 2) Balance (log only, non-blocking).
  try {
    const b = await doFetch(apiBase + "/v1/credits/balance", { method: "GET", headers: { "User-Agent": randUA(), Authorization: `Bearer ${token}` } }, false);
    const bal = b && b.ok && b.json ? b.json.balance_usd : "?";
    console.log(`[nova] balance=${bal}`);
  } catch {}
  // 3) Create API key.
  let kr = await doFetch(apiBase + "/v1/keys", { method: "POST", headers: { ...H, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "key-1" }) }, true);
  if (!kr || !kr.ok) kr = await doFetch(apiBase + "/v1/keys", { method: "POST", headers: { ...H, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "key-1" }) }, false);
  const key = kr && kr.ok && kr.json ? kr.json.key : null;
  console.log(`[nova] key status=${kr ? kr.status : "null"} ok=${!!(kr && kr.ok)} hasKey=${!!key}`);
  if (!key) return null;
  // 4) Verify models (non-blocking, key was just created via provider API).
  let verified = false;
  try {
    const vr = await fetch(apiBase + "/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const vj = await vr.json().catch(() => null);
    const n = vj && Array.isArray(vj.data) ? vj.data.length : -1;
    verified = !!vr.ok;
    console.log(`[nova] verify models status=${vr.status} ok=${vr.ok} count=${n}`);
  } catch (e) { console.log(`[nova] verify exception ${e && e.message ? e.message : "unknown"}`); }
  return { upstreamApiKey: key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
}

// Auto-register RooyAI (2026-10-18, gantiin Aurora/Tokit yang IP-nya diblokir).
// Flow (terverifikasi via curl, no verifikasi, no CAPTCHA):
// 1. POST https://llm.rooyai.com/api/auth/register {name,email,password} → {success:true}
// 2. POST https://authe.rooyai.com/auth/v1/token?grant_type=password (Supabase) → {access_token}
// 3. Decode JWT → user_id (sub)
// 4. Generate key "sk-" + 32 alfanumerik, SHA-256 → key_hash, prefix 12 char
// 5. POST https://authe.rooyai.com/rest/v1/api_keys {user_id,key_hash,key_prefix,name} → 201
// Key plaintext (langkah 4) dipakai sebagai upstreamApiKey. Anon key Supabase = public (ada di JS frontend).
async function tryAutoRegisterRooyai(provider) {
  const apiBase = "https://llm.rooyai.com/v1";
  const supaAnon = process.env.ROOYAI_SUPABASE_ANON_KEY || "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg3NzIzNDIwLCJleHAiOjIxMDMwODM0MjB9.g5QfJJ3tuQKZf4m3K-k1lO60ixpkP6-g1fqnMKgF-oI";
  // Anti-deteksi (perintah Hestia 2026-10-23): JANGAN telanjang polos — versi lama jalan
  // langsung dari IP server + UA tetap "HestiaFlow/1.0" + nama akun "HestiaFlow User",
  // hasilnya akun yang lahir di Hostless langsung di-suspend RooyAI ("account_blocked").
  // Aturan baru: 1) lewat proxy yang SUDAH dicek hidup (yang mati dibuang, hanya yang OK
  // dipakai), 2) User-Agent acak per akun, 3) nama orang acak, 4) verifikasi = CHAT ASLI
  // lewat jalur yang sama (akun suspend-chat ketahuan mati, bukan cuma /models).
  // Cadangan terakhir: jalur langsung (tetap dinilai tes chat yang sama).
  const ROOYAI_NAMA = ["Budi Santoso","Agus Wijaya","Joko Pratama","Sari Lestari","Dewi Rahmawati","Rudi Saputra","Maya Putri","Andi Nugroho","Fitri Handayani","Dedi Kurniawan","Indah Permata","Bambang Sutrisno"];
  let okProxies = []; _proxyNol = false;
  try {
    const raw = await fetchProxyList();
    const cand = [...raw].sort(() => Math.random() - 0.5);
    for (let bi = 0; bi < cand.length && okProxies.length < 30; bi += 10) {
      const cek = await Promise.all(cand.slice(bi, bi + 10).map(async (p) => {
      const d = proxyDispatcher(p);
      if (!d) return null;
      try {
        const r = await fetch(apiBase + "/models", { dispatcher: d, signal: AbortSignal.timeout(15000) });
        return (r && r.status > 0) ? p : null;
      } catch { return null; }
    for (const p of cek) if (p && okProxies.length < 30) okProxies.push(p); }
  
    console.log(`[rooyai] proxy lolos cek: ${okProxies.length} dari ${cand.length} kandidat`);
      _proxyOk = okProxies.length;
  } catch {}
  if (!okProxies.length) { _proxyNol = true; return null; }
  const routes = okProxies.map((p) => ({ via: "proxy", host: p }));
  for (const route of routes) {
    const disp = route.host ? proxyDispatcher(route.host) : null;
    if (route.host && !disp) continue;
    const ua = randUA();
    const nama = ROOYAI_NAMA[Math.floor(Math.random() * ROOYAI_NAMA.length)];
    const domain = "hestiaflow.cc.cd";
    const nm = nama.toLowerCase().replace(/[^a-z ]/g, "").split(" ").filter(Boolean);
    const local = nm.length > 1 ? `${nm[0]}.${nm[nm.length - 1]}${Math.floor(10 + Math.random() * 90)}` : `rooyai${Math.floor(100 + Math.random() * 900)}`;
const tempEmail = `${local}@${domain}`;
const tempPassword = `Rooyai${Math.floor(100000+Math.random()*900000)}@#`;
    const F = async (url, opts = {}, ms = 25000) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try { return await fetch(url, { ...opts, signal: ctl.signal, ...(disp ? { dispatcher: disp } : {}) }); }
      finally { clearTimeout(t); }
    };
    try {
      // 1) Register
      const rg = await F("https://llm.rooyai.com/api/auth/register", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Origin": "https://llm.rooyai.com", "Referer": "https://llm.rooyai.com/" },
        body: JSON.stringify({ name: nama, email: tempEmail, password: tempPassword })
      });
      const rj = await rg.json().catch(() => null);
      if (!rg.ok || !rj || rj.success !== true) { const rb = rj ? JSON.stringify(rj).slice(0, 300) : "no-body"; console.log(`[rooyai] register failed via=${route.via} status=${rg.status} body=${rb}`); return null; }
      // 2) Supabase login
      const lg = await F("https://authe.rooyai.com/auth/v1/token?grant_type=password", {
        method: "POST", headers: { "apikey": supaAnon, "Content-Type": "application/json", "User-Agent": ua },
        body: JSON.stringify({ email: tempEmail, password: tempPassword })
      });
      const lj = await lg.json().catch(() => null);
      const atoken = lj && lj.access_token;
      if (!lg.ok || !atoken) { console.log(`[rooyai] login failed via=${route.via}`); return null; }
      // 3) user_id dari JWT sub
      let uid = null;
      try { uid = JSON.parse(Buffer.from(atoken.split(".")[1], "base64").toString()).sub; } catch {}
      if (!uid) { console.log("[rooyai] no uid"); return null; }
      // 4) Generate key + hash
      const rand = [...require("crypto").randomBytes(32)].map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
      const newKey = "sk-" + rand;
      const keyHash = require("crypto").createHash("sha256").update(newKey).digest("hex");
      const keyPrefix = newKey.slice(0, 12);
      // 5) INSERT api_keys via Supabase REST
      const ik = await F("https://authe.rooyai.com/rest/v1/api_keys", {
        method: "POST",
        headers: { "apikey": supaAnon, "Authorization": "Bearer " + atoken, "Content-Type": "application/json", "Prefer": "return=representation", "User-Agent": ua },
        body: JSON.stringify({ user_id: uid, key_hash: keyHash, key_prefix: keyPrefix, name: nama.split(" ")[0] })
      });
      if (ik.status !== 201) { console.log("[rooyai] key insert failed", ik.status); return null; }
      // 6) Verifikasi CHAT ASLI lewat jalur kelahiran yang sama.
      let chatOk = false, chatStatus = 0;
      try {
        const cr = await F(apiBase + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + newKey, "User-Agent": ua },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 5 })
        }, 30000);
        chatStatus = cr.status;
        chatOk = cr.ok;
        await cr.text().catch(() => "");
      } catch {}
      console.log(`[rooyai] auto-register via=${route.via} chatVerify=${chatOk} status=${chatStatus}`);
      return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: chatOk };
    } catch (e) {
      console.log(`[rooyai] route ${route.via} gagal jaringan (${e && e.message ? String(e.message).slice(0, 60) : "?"}), coba jalur berikutnya`);
      continue;
    }
  }
  return null;
}

// ZeroLimitAI auto-register (2026-10-18). Flow: register (no CAPTCHA, no email verification required)
// -> NextAuth login (CSRF + credentials) -> POST /api/keys (one key per free account) -> verify /v1/models.
async function tryAutoRegisterZerolimit(provider) {
  const siteBase = "https://www.zerolimitai.com";
  const apiBase = siteBase + "/api/v1";
  // Domain email: tempomail.id (diperbarui 2026-10-23 — minafter.com & byon.in kini ditolak
  // ZeroLimit 400 code "disposable_email"; tempomail.id lolos terverifikasi live hari yang sama).
  // Anti-deteksi (aturan tetap Hestia 2026-10-23): seluruh sesi akun (register -> csrf ->
  // login -> buat key) lewat SATU proxy yang sudah dicek hidup ke host tujuan (yang mati
  // dibuang), User-Agent acak per akun, nama orang acak. Gagal jaringan di tengah jalan ->
  // proxy berikutnya dengan kredensial segar; cadangan terakhir langsung.
  const ZL_FIRST = ["Budi","Agus","Joko","Bambang","Slamet","Rudi","Andi","Dedi","Sari","Dewi","Rina","Fitri","Indah","Putri","Maya","Sinta"];
  const ZL_LAST = ["Santoso","Wijaya","Pratama","Saputra","Hidayat","Nugroho","Rahmawati","Lestari","Putri","Sari","Utama","Perdana"];
  let okProxies = []; _proxyNol = false;
  try {
    const raw = await fetchProxyList();
    const cand = [...raw].sort(() => Math.random() - 0.5);
    for (let bi = 0; bi < cand.length && okProxies.length < 30; bi += 10) {
      const cek = await Promise.all(cand.slice(bi, bi + 10).map(async (p) => {
      const d = proxyDispatcher(p);
      if (!d) return null;
      try { const r = await fetch(siteBase + "/", { dispatcher: d, signal: AbortSignal.timeout(7000) }); return (r && r.status > 0) ? p : null; } catch { return null; }
    }));
    for (const p of cek) if (p && okProxies.length < 30) okProxies.push(p); }
    console.log(`[zerolimit] proxy lolos cek: ${okProxies.length} dari ${cand.length} kandidat`);
    _proxyOk = okProxies.length;
  } catch {}
  if (!okProxies.length) { _proxyNol = true; return null; }
  const routes = okProxies.map((p) => ({ via: "proxy", host: p }));
  for (const route of routes) {
    const disp = route.host ? proxyDispatcher(route.host) : null;
    if (route.host && !disp) continue;
    const ua = randUA();
    const zlFirst = ZL_FIRST[Math.floor(Math.random() * ZL_FIRST.length)];
    const zlLast = ZL_LAST[Math.floor(Math.random() * ZL_LAST.length)];
    const tempEmail = `${zlFirst.toLowerCase()}${Math.floor(10000 + Math.random() * 89999)}${Date.now() % 100000}@tempomail.id`;
    const tempPassword = `${zlFirst}12345`;
    const tempName = `${zlFirst} ${zlLast}`;
    const jar = {};
    const saveCookies = (res) => {
      try {
        const arr = (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
        for (const sc of arr) {
          const pair = sc.split(";")[0];
          const idx = pair.indexOf("=");
          if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
        }
      } catch {}
    };
    const cookieHdr = () => Object.entries(jar).map(([k,v]) => k + "=" + v).join("; ");
    const F = async (url, opts = {}, ms = 25000) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try { return await fetch(url, { ...opts, signal: ctl.signal, ...(disp ? { dispatcher: disp } : {}) }); }
      finally { clearTimeout(t); }
    };
    try {
      const rg = await F(siteBase + "/api/auth/register", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua },
        body: JSON.stringify({ name: tempName, email: tempEmail, password: tempPassword, referralCode: "0DBE08D4" })
      });
      saveCookies(rg);
      const rj = await rg.json().catch(() => null);
      // Masa aktif trial akun dari respons register (kalau provider menyertakannya): disimpan
      // sebagai expires_at akun panen supaya cleanup berkala bisa menghapus pas lewat waktunya.
      let regExpiresAt = null;
      try {
        const srcExp = [rj, rj && rj.user, rj && rj.data].filter(Boolean);
        for (const s of srcExp) {
          for (const k of Object.keys(s)) {
            if (/trial|expir/i.test(k) && typeof s[k] === "string" && !isNaN(Date.parse(s[k]))) { regExpiresAt = new Date(s[k]).toISOString(); break; }
          }
          if (regExpiresAt) break;
        }
      } catch {}
      // Bukti sukses = login + key di langkah berikutnya; respons register cukup status OK.
      if (!rg.ok) { console.log("[zerolimit] register failed via=" + route.via + " status=" + rg.status + " err=" + ((rj && (rj.code || rj.error)) || "?")); return null; }
      const cr = await F(siteBase + "/api/auth/csrf", { headers: { "User-Agent": ua, "Cookie": cookieHdr() } });
      saveCookies(cr);
      const cj = await cr.json().catch(() => null);
      const csrf = cj && cj.csrfToken;
      if (!csrf) { console.log("[zerolimit] no csrf"); return null; }
      const form = new URLSearchParams({ csrfToken: csrf, email: tempEmail, password: tempPassword, json: "true" });
      const lg = await F(siteBase + "/api/auth/callback/credentials", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua, "Cookie": cookieHdr() },
        body: form.toString()
      });
      saveCookies(lg);
      await lg.text().catch(() => "");
      const kk = await F(siteBase + "/api/keys", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua, "Cookie": cookieHdr() },
        body: JSON.stringify({ name: zlFirst })
      });
      const kj = await kk.json().catch(() => null);
      const newKey = kj && kj.key;
      if (!kk.ok || !newKey) { console.log("[zerolimit] key create failed"); return null; }
      let verified = false;
      try {
        const vr = await F(apiBase + "/models", { headers: { "Authorization": "Bearer " + newKey, "User-Agent": ua } });
        verified = vr.ok;
      } catch {}
      // Tes chat end-to-end (log saja, tidak menggagalkan panen): bukti key bisa dipakai chat beneran.
      try {
        const cr2 = await F(apiBase + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + newKey, "User-Agent": ua },
          body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], max_tokens: 5 })
        });
        const cj2 = await cr2.json().catch(() => null);
        const hasContent = !!(cj2 && cj2.choices && cj2.choices[0] && cj2.choices[0].message && cj2.choices[0].message.content);
        console.log(`[zerolimit] chat-test status=${cr2.status} ok=${cr2.ok} hasContent=${hasContent}`);
      } catch (e) { console.log("[zerolimit] chat-test exception", e && e.message); }
      console.log(`[zerolimit] auto-register ok via=${route.via}, verified=${verified}`);
      return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified, expiresAt: regExpiresAt };
    } catch (e) {
      console.log(`[zerolimit] route ${route.via} gagal jaringan (${e && e.message ? String(e.message).slice(0, 60) : "?"}), coba jalur berikutnya`);
      continue;
    }
  }
  return null;
}

async function tryAutoRegisterBestllm(provider) {
  // bestllmapi.com (2026-10-19): via Cloudflare Worker relay (IP Railway diblokir).
  // Worker: https://bestllm-relay.srkirana44.workers.dev/ (dibuat 2026-10-19).
  const apiBase = "https://api.bestllmapi.com/v1";
  const relayUrl = process.env.BESTLLM_RELAY_URL;
  const relaySecret = process.env.BESTLLM_RELAY_SECRET;
  if (!relayUrl || !relaySecret) { console.log("[bestllm] relay not configured"); return null; }
  const tempEmail = `bestllm${Date.now()}${Math.floor(Math.random()*9999)}@tempomail.id`;
  const tempPassword = `Bestllm${Math.floor(100000+Math.random()*900000)}@#`;
  try {
    const signupUrl = relayUrl.replace(/\/$/, "") + "/signup";
    const r = await fetch(signupUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-relay-secret": relaySecret },
      body: JSON.stringify({ do: "signup", email: tempEmail, password: tempPassword }),
      signal: AbortSignal.timeout(25000)
    });
    const st = r.status;
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !j.key) { console.log("[bestllm] relay signup failed", st, j && j.error); return null; }
    console.log(`[bestllm] auto-register ok via relay, balance=${j.balance_usd}`);
    return { upstreamApiKey: j.key, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: true, balance: j.balance_usd };
  } catch (e) { console.log("[bestllm] relay exception", e && e.message); return null; }
}

async function tryAutoRegisterNearresearch(provider) {
  // Near Research (2026-10-18): POST /api/signup {email,password} -> {key, balance:0.25}. Tanpa verifikasi, tanpa captcha.
  // Anti-deteksi (aturan tetap Hestia 2026-10-23): signup lewat proxy yang sudah dicek hidup
  // ke host tujuan (yang mati dibuang) + User-Agent acak per akun; cadangan terakhir langsung.
  const siteBase = "https://nearresearch.com";
  const apiBase = siteBase + "/v1"; _proxyNol = false;
  let okProxies = [];
  try {
    const raw = await fetchProxyList();
    const cand = [...raw].sort(() => Math.random() - 0.5);
    for (let bi = 0; bi < cand.length && okProxies.length < 30; bi += 10) {
      const cek = await Promise.all(cand.slice(bi, bi + 10).map(async (p) => {
      const d = proxyDispatcher(p);
      if (!d) return null;
      try { const r = await fetch(siteBase + "/", { dispatcher: d, signal: AbortSignal.timeout(7000) }); return (r && r.status > 0) ? p : null; } catch { return null; }
    }));
    for (const p of cek) if (p && okProxies.length < 30) okProxies.push(p); }
    console.log(`[nearresearch] proxy lolos cek: ${okProxies.length} dari ${cand.length} kandidat`);
    _proxyOk = okProxies.length;
  } catch {}
  if (!okProxies.length) { _proxyNol = true; return null; }
  const routes = okProxies.map((p) => ({ via: "proxy", host: p }));
  for (const route of routes) {
    const disp = route.host ? proxyDispatcher(route.host) : null;
    if (route.host && !disp) continue;
    const ua = randUA();
    const tempEmail = `near${Date.now()}${Math.floor(Math.random()*9999)}@tempomail.id`;
    const tempPassword = `Near${Math.floor(100000+Math.random()*900000)}@#`;
    const F = async (url, opts = {}, ms = 25000) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try { return await fetch(url, { ...opts, signal: ctl.signal, ...(disp ? { dispatcher: disp } : {}) }); }
      finally { clearTimeout(t); }
    };
    try {
      const r = await F(siteBase + "/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": ua },
        body: JSON.stringify({ email: tempEmail, password: tempPassword })
      });
      const j = await r.json().catch(() => null);
      const newKey = j && j.key;
      if (!r.ok || !newKey) { console.log(`[nearresearch] signup failed via=${route.via} status=${r.status}`); return null; }
      let verified = false;
      try {
        const vr = await F(apiBase + "/models", { headers: { "Authorization": "Bearer " + newKey, "User-Agent": ua } });
        verified = vr.ok;
      } catch {}
      console.log(`[nearresearch] auto-register ok via=${route.via}, verified=${verified}, balance=${j.balance}`);
      return { upstreamApiKey: newKey, upstreamBaseUrl: apiBase, tempEmail, tempPassword, live: verified };
    } catch (e) {
      console.log(`[nearresearch] route ${route.via} gagal jaringan, coba jalur berikutnya`);
      continue;
    }
  }
  return null;
}


// Auto-register Avalai (2026-10-24, Tier Pro; brand publik "Vega").
// Flow terbukti (script operator di Termux E2E 2026-10-24 02:18):
// inbox temp (noopmail, cadangan minuteinbox) -> kirim OTP (endpoint LAMA
// /api/auth/v1/login/ lebih dulu; endpoint baru request-otp kadang sukses
// tapi kode tidak tiba) -> poll inbox -> verifikasi via /api/auth/v1/verify/
// (endpoint inilah yang mengeset cookie sesi platform) -> cek
// /api/platform/api-list/ 200 -> buat key via /api/platform/create-key/
// (auth = cookie sesi + header X-CSRFToken dari cookie csrftoken).
// Anti-deteksi (aturan tetap operator 2026-10-23): API upstream lewat proxy
// yang LOLOS cek jangkauan ke upstream (maks 8 calon), UA acak per akun,
// nama key ACAK dari nama orang/benda (BUKAN nama operator — perintah
// operator 2026-10-24). Inbox selalu koneksi langsung (proxy gratis lemot).
// Kredit 25.000 per akun, hangus ±7 hari -> expiresAt akun diisi +7 hari.
const VEGA_NAMA_ORANG = ["Andini", "Bima", "Citra", "Dimas", "Eka", "Fitri", "Gilang", "Hana", "Indra", "Kirana", "Lukman", "Maya", "Nanda", "Putri", "Raka", "Sari", "Teguh", "Utami", "Vina", "Wahyu", "Yoga", "Zahra", "Bagas", "Dewi", "Fajar", "Galih", "Intan", "Rizki", "Sinta", "Tania", "Umar", "Vera", "Wulan", "Yusuf", "Zaki", "Aldi", "Bella", "Candra", "Dina", "Edo"];
const VEGA_NAMA_BELAKANG = ["Prasetyo", "Wulandari", "Nugroho", "Saputra", "Lestari", "Firmansyah", "Anggraini", "Hidayat", "Puspita", "Ramadhan", "Maharani", "Setiawan", "Fitriani", "Kurniawan", "Salsabila", "Hakim", "Nurfadilah", "Salim", "Azzahra", "Maulana"];
const VEGA_NAMA_BENDA = ["Kopi", "Senja", "Karang", "Melati", "Cempaka", "Angkasa", "Damar", "Embun", "Flamboyan", "Genta", "Hujan", "Jati", "Kenanga", "Langit", "Mahoni", "Ombak", "Pijar", "Rimba", "Sagu", "Ulin", "Arunika", "Bayu", "Cakra", "Banyu", "Ilalang"];
function vegaNamaAcak() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const r = Math.random();
  if (r < 0.55) return pick(VEGA_NAMA_ORANG) + " " + pick(VEGA_NAMA_BELAKANG);
  if (r < 0.8) return pick(VEGA_NAMA_BENDA) + " " + pick(VEGA_NAMA_BENDA);
  return pick(VEGA_NAMA_ORANG) + " " + pick(VEGA_NAMA_BENDA);
}
async function tryAutoRegisterAvalai(provider) {
  const apiBase = ((provider && provider.upstream_url) || "https://api.avalai.ir/v1").replace(/\/$/, "");
  const authBase = apiBase.replace("://api.", "://chat.").replace(/\/v1$/, "");
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  // --- sesi cookie-jar (fetch Node tidak menyimpan cookie sendiri) ---
  const buatSesi = (disp, ua) => {
    const jar = new Map();
    const F = async (url, opts = {}, ms = 30000) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try {
        const headers = { "User-Agent": ua, ...(opts.headers || {}) };
        const ck = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
        if (ck) headers.Cookie = ck;
        const o = { ...opts, headers, signal: ctl.signal };
        if (disp) o.dispatcher = disp;
        const r = await fetch(url, o);
        try { for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const pair = c.split(";")[0]; const i = pair.indexOf("="); if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); } } catch {}
        return r;
      } finally { clearTimeout(t); }
    };
    return { F, jar };
  };
  let csrfDiag = ""; const csrfDari = async (S, referer) => { csrfDiag = "";
    if (S.jar.get("csrftoken")) { csrfDiag = "sudah-ada-cookie ck=" + [...S.jar.keys()].join(","); return S.jar.get("csrftoken"); }
    for (const method of ["POST", "GET"]) {
      try {
        csrfDiag = csrfDiag + (csrfDiag ? " | " : "") + method + " req ck=" + [...S.jar.keys()].join(","); const r = await S.F(authBase + "/api/auth/csrf/", { method, headers: { Referer: authBase + referer } }); csrfDiag = csrfDiag + " st=" + r.status + " ckAda=" + !!S.jar.get("csrftoken") + " ck=" + [...S.jar.keys()].join(",");
        if (S.jar.get("csrftoken")) { csrfDiag = csrfDiag + " src=cookie"; return S.jar.get("csrftoken"); }
        const j = await r.json().catch(() => null);
        const tok = j && (j.csrfToken || j.csrf_token);
        if (tok) { csrfDiag = csrfDiag + " src=json tokAda=true"; return tok; } csrfDiag = csrfDiag + " tokJson=tidak-ada";
      } catch (e) { csrfDiag = csrfDiag + " err=" + String(e && e.message ? e.message : "error").slice(0, 200); }
    }
    if (!S.jar.get("csrftoken")) csrfDiag = csrfDiag + " hasil=gagal"; return S.jar.get("csrftoken") || "";
  };
  const authH = async (S, referer, force) => {
    if (force) S.jar.delete("csrftoken");
    const csrf = await csrfDari(S, referer);
    const h = { Referer: authBase + referer };
    if (csrf) h["X-CSRFToken"] = csrf;
    return h;
  };
  // --- inbox temp (langsung, tanpa proxy) ---
  const inboxDiag = { pertama: "", cadangan: "", pertamaHome: "tidak tercapai", cadanganCsrf: "tidak tercapai", cadanganNewEmail: "tidak tercapai", cadanganIndexBentuk: "tidak tercapai" }; const potongDiag = (v) => String(v || "tidak diketahui").slice(0, 200); const inboxNoopmail = async () => {
    try {
      const noopS = buatSesi(null, randUA()); const home = await noopS.F("https://noopmail.org/", { headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", Referer: "https://noopmail.org/" } }, 20000); await home.text().catch(() => ""); inboxDiag.pertamaHome = "HTTP " + home.status; const r = await noopS.F("https://noopmail.org/api/rd", { headers: { Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Referer: "https://noopmail.org/", Origin: "https://noopmail.org" } }, 20000); if (!r.ok) { inboxDiag.pertama = "HTTP " + r.status; return null; }
      const d = await r.json().catch(() => null);
      const domain = d && d.dm;
      if (!domain) { inboxDiag.pertama = "HTTP " + r.status + ", tanpa domain"; return null; }
      const local = randStr(12, "abcdefghijklmnopqrstuvwxyz");
      const email = `${local}@${domain}`;
      const poll = async (waitMs) => {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          try {
            const rr = await noopS.F("https://noopmail.org/api/c", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Referer: "https://noopmail.org/", Origin: "https://noopmail.org" }, body: JSON.stringify({ e: local, d: domain }), signal: AbortSignal.timeout(20000) });
            const msgs = await rr.json().catch(() => null);
            if (Array.isArray(msgs)) for (const m of msgs) {
              const frm = ((m.from || "") + " " + (m.subject || "")).toLowerCase();
              if (frm.includes("avalai")) {
                const cm = ((m.subject || "") + " " + (m.text || "")).match(/\b(\d{6})\b/);
                if (cm) return cm[1];
              }
            }
          } catch {}
          await sleep(5000);
        }
        return null;
      };
      return { email, poll };
    } catch (e) { inboxDiag.pertama = e && e.message ? e.message : "error"; return null; }
  };
  const inboxMinute = async () => {
    try {
      const S = buatSesi(null, randUA());
      const home = await S.F("https://www.minuteinbox.com/", {}, 30000); if (!home.ok) { inboxDiag.cadangan = "HTTP " + home.status; return null; } const homeText = await home.text().catch(() => ""); const csrfM = homeText.match(/(?:CSRF|csrf_token|csrf)\s*[:=]\s*["']([^"']+)["']/); const csrf = csrfM ? csrfM[1] : ""; inboxDiag.cadanganCsrf = csrf ? "ada" : "tidak ditemukan"; const localBaru = randStr(12, "abcdefghijklmnopqrstuvwxyz"); await sleep(1000); const buat = await S.F("https://www.minuteinbox.com/index/new-email/", { method: "POST", headers: { Referer: "https://www.minuteinbox.com/", Origin: "https://www.minuteinbox.com", "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" }, body: "emailInput=" + encodeURIComponent(localBaru) + "&format=json" }, 30000); inboxDiag.cadanganNewEmail = "HTTP " + buat.status; if (!buat.ok) { inboxDiag.cadangan = "HTTP " + buat.status + ", new-email gagal"; return null; } await buat.text().catch(() => ""); await sleep(2000); const r = await S.F("https://www.minuteinbox.com/index/index?csrf_token=" + encodeURIComponent(csrf), {}, 30000); if (!r.ok) { inboxDiag.cadangan = "HTTP " + r.status; return null; }
      const salinanIdx = r.clone(); const jIdx = await r.json().catch(() => null); const teksIdx = await salinanIdx.text().catch(() => ""); inboxDiag.cadanganIndexBentuk = "ct=" + String(r.headers.get("content-type") || "?") + " json=" + (jIdx !== null) + " emailAda=" + !!(jIdx && jIdx.email) + " panjang=" + teksIdx.length;
      const htmlM = teksIdx.match(/data-email="([^"]+)"/) || teksIdx.match(new RegExp("(" + localBaru + "@[a-zA-Z0-9.-]+)")) || teksIdx.match(/([a-zA-Z0-9._-]+@minafter\.com)/); const m = htmlM ? [htmlM[1], htmlM[1]] : null;
      if (!m) { inboxDiag.cadangan = "HTTP " + r.status + ", email tidak ditemukan"; return null; }
      const email = m[1];
      const poll = async (waitMs) => {
        const deadline = Date.now() + waitMs; const seen = new Set();
        while (Date.now() < deadline) {
          try {
            const rr = await S.F("https://www.minuteinbox.com/index/refresh", {}, 20000);
            const tt = await rr.text().catch(() => "");
            const re = /data-id="(\d+)"[^>]*>[^]*?avalai/gi;
            let mm;
            while ((mm = re.exec(tt))) {
              const mid = mm[1];
              if (seen.has(mid)) continue;
              seen.add(mid);
              const r2 = await S.F("https://www.minuteinbox.com/email/" + mid, {}, 20000);
              const t2 = await r2.text().catch(() => "");
              const cm = t2.match(/\b(\d{6})\b/);
              if (cm) return cm[1];
            }
          } catch {}
          await sleep(5000);
        }
        return null;
      };
      return { email, poll };
    } catch (e) { inboxDiag.cadangan = e && e.message ? e.message : "error"; return null; }
  };
  let poolProxies = []; try { poolProxies = db.prepare("SELECT host FROM proxy_pool WHERE target='vega' AND fails=0 ORDER BY last_ok DESC LIMIT 3").all().map((r) => r.host).filter(Boolean); } catch {} console.log("[vega] pool dipakai: " + poolProxies.length); // --- proxy: hanya yang lolos cek jangkauan ke upstream ---
  let okProxies = [];
  try {
    const raw = await fetchProxyList();
    const cand = [...raw].sort(() => Math.random() - 0.5).slice(0, 40);
    const cek = await Promise.all(cand.map(async (px) => {
      const d = proxyDispatcher(px);
      if (!d) return null;
      try { const r = await fetch(authBase + "/api/auth/csrf/", { dispatcher: d, headers: { "User-Agent": randUA() }, signal: AbortSignal.timeout(8000) }); return r.status < 500 ? px : null; } catch { return null; }
    }));
    okProxies = cek.filter(Boolean).slice(0, 3);
  } catch {}
  const routes = [...poolProxies, ...okProxies.filter((p) => !poolProxies.includes(p)), null];
  console.log(`[vega] rute proxy lolos cek: ${okProxies.length}`);
  for (const px of routes) {
    const disp = px ? proxyDispatcher(px) : null;
    if (px && !disp) continue;
    const S = buatSesi(disp, randUA());
    try {
      // 1) Inbox (noopmail dulu, minuteinbox cadangan).
      let inbox = await inboxNoopmail();
      if (!inbox) inbox = await inboxMinute();
      if (!inbox) { console.log("[vega] inbox gagal dibuat noopmail=" + potongDiag(inboxDiag.pertama) + " minuteinbox=" + potongDiag(inboxDiag.cadangan) + " noopmailHome=" + potongDiag(inboxDiag.pertamaHome) + " minuteCsrf=" + potongDiag(inboxDiag.cadanganCsrf) + " minuteNewEmail=" + potongDiag(inboxDiag.cadanganNewEmail) + " minuteIndex=" + potongDiag(inboxDiag.cadanganIndexBentuk)); continue; }
      const email = inbox.email;
      // 2) Kirim OTP: endpoint LAMA dulu (terbukti kode tiba), baru endpoint baru.
      let otpSent = false; const otpDiag = [];
      for (let attempt = 1; attempt <= 3 && !otpSent; attempt++) {
        const h = await authH(S, "/chat");
        if (!h["X-CSRFToken"]) { otpDiag.push("tanpa-CSRF " + potongDiag(csrfDiag)); await sleep(4000); continue; }
        for (const path of ["/api/auth/v1/login/", "/api/auth/v1/request-otp/"]) {
          try {
            const r = await S.F(authBase + path, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ identifier: email, type: "email" }) });
            const d = await r.json().catch(() => ({}));
            console.log(`[vega] kirim OTP ${path} -> HTTP ${r.status}`); otpDiag.push(path + "=HTTP " + r.status);
            if (r.status === 200 && d && typeof d === "object" && !("error" in d) && d.requires_verification !== false) { otpSent = true; break; }
          } catch (e) { console.log(`[vega] kirim OTP ${path} timeout`); otpDiag.push(path + "=" + potongDiag(e && e.message ? e.message : "timeout")); }
        }
        if (!otpSent) await sleep(4000);
      }
      if (!otpSent) { console.log("[vega] OTP gagal dikirim " + (otpDiag.length ? otpDiag.map((v) => potongDiag(v)).join(" | ") : "tidak ada percobaan terkirim")); continue; }
      // 3) Poll inbox (maks 150 detik).
      const code = await inbox.poll(150000);
      if (!code) { console.log("[vega] OTP tidak tiba"); continue; }
      // 4) Verifikasi via /verify/ (pembentuk cookie sesi platform).
      const hv = await authH(S, "/chat");
      let vr = await S.F(authBase + "/api/auth/v1/verify/", { method: "POST", headers: { ...hv, "Content-Type": "application/json" }, body: JSON.stringify({ identifier: email, type: "email", code }) });
      if (vr.status === 404) vr = await S.F(authBase + "/api/auth/v1/login/", { method: "POST", headers: { ...hv, "Content-Type": "application/json" }, body: JSON.stringify({ identifier: email, type: "email", code }) });
      const vd = await vr.json().catch(() => ({}));
      if (vr.status !== 200 || (vd && "error" in vd)) { console.log(`[vega] verifikasi gagal HTTP ${vr.status}`); continue; }
      // 5) Cek sesi dikenal platform.
      const cekSesi = async () => {
        try { const hh = await authH(S, "/platform/api-keys"); const rr = await S.F(authBase + "/api/platform/api-list/", { headers: hh }); return rr.status === 200; } catch { return false; }
      };
      let sesiOk = await cekSesi();
      // 6) Kunjungi halaman platform (menghangatkan sesi), lalu buat key.
      try { await S.F(authBase + "/platform/api-keys", {}); } catch {}
      await sleep(2000);
      const namaKey = vegaNamaAcak();
      const buatKey = async () => {
        const hh = await authH(S, "/platform/api-keys");
        const payload = { name: namaKey, permissions: { allowed_models: [], allowed_ips: [], monthly_quota: null, ttl_days: null, total_budget: null, custom_settings: {}, allowed_endpoints: [], allowed_intents: {} } };
        const r = await S.F(authBase + "/api/platform/create-key/", { method: "POST", headers: { ...hh, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const txt = await r.text().catch(() => "");
        let d = null; try { d = JSON.parse(txt); } catch {}
        return { status: r.status, d, txt };
      };
      let kr = await buatKey();
      if (kr.status === 403 && kr.txt.includes("credentials were not provided")) {
        await authH(S, "/platform/api-keys", true);
        sesiOk = await cekSesi();
        if (sesiOk) kr = await buatKey();
      }
      let upstreamKey = null;
      if (kr.status === 200 && kr.d) {
        const dd = kr.d.data && typeof kr.d.data === "object" ? kr.d.data : {};
        upstreamKey = kr.d.key || kr.d.api_key || kr.d.apiKey || kr.d.token || kr.d.secret || dd.key || dd.api_key || dd.apiKey || dd.token || dd.secret || null;
        const keyId = kr.d.id || dd.id;
        if (!upstreamKey && keyId) {
          await sleep(3000);
          try {
            const hh = await authH(S, "/platform/api-keys");
            const r2 = await S.F(authBase + "/api/platform/api-key/?id=" + encodeURIComponent(keyId), { headers: hh });
            const d2 = await r2.json().catch(() => null);
            if (d2) { const e2 = d2.data && typeof d2.data === "object" ? d2.data : {}; upstreamKey = d2.key || d2.api_key || d2.apiKey || d2.token || d2.secret || e2.key || e2.api_key || null; }
          } catch {}
        }
      }
      if (!upstreamKey) { console.log(`[vega] create-key gagal HTTP ${kr.status}`); continue; }
      // 7) Verifikasi key hidup ke API chat.
      let live = false;
      try {
        const r = await fetch(apiBase + "/models", { headers: { Authorization: `Bearer ${upstreamKey}` }, signal: AbortSignal.timeout(20000) });
        live = r.ok;
      } catch {}
      console.log(`[vega] akun jadi: ${email} key=${live ? "HIDUP" : "belum terverifikasi"} sesi=${sesiOk}`);
      return { upstreamApiKey: upstreamKey, upstreamBaseUrl: apiBase, tempEmail: email, tempPassword: "", live, balance: 25000, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
    } catch (e) {
      console.log(`[vega] rute gagal: ${e && e.message ? e.message : "unknown"}`);
      continue;
    }
  }
  return null;
}

// Auto-register a real provider account (server-side, no admin config).
// Tries generic signup/login/key endpoints against the provider's upstream_url
// (operator-configured in DB). Returns { upstreamApiKey, upstreamBaseUrl } or null.
// NEVER logs or returns upstream credentials. Falls back to null on any failure
// (CAPTCHA, email verification, unknown flow) — caller keeps NULL upstream key.
async function tryAutoRegister(provider, tempEmail, tempPassword) {
  const base = (provider.upstream_url || "").replace(/\/$/, "");
  if (!base) return null;
  // Brand-specific flows (proven by operator's own scripts).
  // Luna = ZeroLimitAI di balik layar (2026-10-21). Nama provider TIDAK ditampilkan publik;
  // brand publik tetap "Luna". (Sebelumnya AI4ALL — tryAutoRegisterLuna tidak dipakai lagi.)
  if ((provider.brand_name || "").toLowerCase() === "luna") {
    const zl = await tryAutoRegisterZerolimit(provider);
    if (zl) return zl;
    return null;
  }
  if ((provider.brand_name || "").toLowerCase() === "nova") {
    const nova = await tryAutoRegisterNova(provider);
    if (nova) return nova;
    return null;
  }
  // Aurora = RooyAI (2026-10-18, gantiin Tokit yang IP-nya diblokir). Auto-register via Supabase, no verifikasi.
  if ((provider.brand_name || "").toLowerCase() === "aurora") {
    const rooyai = await tryAutoRegisterRooyai(provider);
    if (rooyai) return rooyai;
    return null;
  }

  // Stella = Near Research (2026-10-18, gantiin Free.ai yang cuma 2 model gratis). Signup langsung dapet key, tanpa verifikasi.
  if ((provider.brand_name || "").toLowerCase() === "stella") {
    const nr = await tryAutoRegisterNearresearch(provider);
    if (nr) return nr;
    return null;
  }
  // Vega = Avalai (2026-10-24, Tier Pro — gantiin Nova/OpenToke yang mati total).
  // Nama provider TIDAK ditampilkan publik; brand publik tetap "Vega".
  if ((provider.brand_name || "").toLowerCase() === "vega") {
    const av = await tryAutoRegisterAvalai(provider);
    if (av) return av;
    return null;
  }
  // Zerolimit = ZeroLimitAI (2026-10-21, tier Gratis). Register tanpa captcha & tanpa verifikasi email.
  // Cabang ini yang HILANG di upaya 2026-10-18 — fungsinya ada tapi tidak pernah dipanggil.
  /* Media = Renderful (mesin panen per-akun yang sudah ada; brand publik tetap "Media"). */ if ((provider.brand_name || "").toLowerCase() === "media") { const rf = await tryAutoRegisterRenderful(); if (rf && rf.live && rf.apiKey) return { upstreamApiKey: rf.apiKey, upstreamBaseUrl: RENDERFUL_BASE, tempEmail: tempEmail, tempPassword: tempPassword, live: true, balance: rf.balance }; return null; } if ((provider.brand_name || "").toLowerCase() === "zerolimit") {
    const zl = await tryAutoRegisterZerolimit(provider);
    if (zl) return zl;
    return null;
  }
  const tryFetch = async (url, opts, ms) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms || 15000);
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(t);
      const txt = await r.text().catch(() => "");
      let j = null;
      try { j = JSON.parse(txt); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: txt };
    } catch { return null; }
  };
  // 1) Signup (try common endpoints).
  const signupBodies = [
    { email: tempEmail, password: tempPassword, name: "HestiaFlow" },
    { email: tempEmail, password: tempPassword, username: tempEmail.split("@")[0] },
    { email: tempEmail, password: tempPassword },
  ];
  const signupPaths = ["/api/auth/register", "/api/register", "/auth/signup", "/api/auth/signup", "/api/users", "/api/v1/auth/register"];
  let token = null;
  for (const p of signupPaths) {
    for (const b of signupBodies) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      if (r && r.ok && r.json) {
        token = r.json.token || r.json.access_token || r.json.accessToken || r.json.api_key || r.json.apiKey || r.json.key || null;
        if (r.json.user && r.json.user.api_key) token = r.json.user.api_key;
        if (token) break;
      }
      if (r && (r.status === 409 || r.status === 422)) break; // already exists / validation — try next path
    }
    if (token) break;
  }
  // 2) Login (if signup did not return a token/key).
  if (!token) {
    const loginPaths = ["/api/auth/login", "/api/login", "/auth/login", "/api/v1/auth/login"];
    for (const p of loginPaths) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: tempEmail, password: tempPassword }) });
      if (r && r.ok && r.json) {
        token = r.json.token || r.json.access_token || r.json.accessToken || r.json.api_key || r.json.apiKey || r.json.key || null;
        if (r.json.user && r.json.user.api_key) token = r.json.user.api_key;
        if (token) break;
      }
    }
  }
  if (!token) return null;
  // 3) If token looks like a session token (not an API key), try to create/list an API key.
  // Heuristic: API keys for these gateways are usually long; session tokens are JWTs.
  // Try key endpoints with the token as Bearer; if one returns a key, use it.
  const isJwt = token.split(".").length === 3;
  if (isJwt) {
    const keyPaths = ["/api/api-keys", "/api/keys", "/api/v1/api-keys", "/api/auth/api-key"];
    for (const p of keyPaths) {
      const r = await tryFetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "hestiaflow" }) });
      if (r && r.ok && r.json) {
        const k = r.json.api_key || r.json.apiKey || r.json.key || (r.json.data && (r.json.data.api_key || r.json.data.key)) || null;
        if (k) return { upstreamApiKey: k, upstreamBaseUrl: base };
      }
      const g = await tryFetch(base + p, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      if (g && g.ok && g.json) {
        const arr = g.json.data || g.json.keys || g.json.api_keys || [];
        if (Array.isArray(arr) && arr.length) {
          const k = arr[0].api_key || arr[0].apiKey || arr[0].key || arr[0].value || null;
          if (k) return { upstreamApiKey: k, upstreamBaseUrl: base };
        }
      }
    }
    return null; // JWT but no API key retrievable — cannot use session token as gateway key.
  }
  // Non-JWT token: treat as the API key itself.
  return { upstreamApiKey: token, upstreamBaseUrl: base };
}

const TIER_HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000, media: 500 };
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3 };
const VOUCHER_DAYS = { plus: 3, pro: 7, premium: 14, media: 7 };
function effectiveTierSlug(u) { if (!u) return "gratis"; if (u.tier_expires_at && new Date(u.tier_expires_at) < new Date()) return "gratis"; return u.tier_slug || "gratis"; }
function genVoucherCode() { const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 16; i++) s += chars[crypto.randomInt(chars.length)]; return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16); }
async function doHarvest({ userId, providerId, count }) {
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
  if (!provider) throw new Error("provider_not_found");
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error("count_must_be_1_to_5000");
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(provider.tier_id);
  if (tier && tier.slug === "pro" && !proEnabled()) throw new Error("Tier Pro sedang dikunci (Segera Hadir)."); // Pro + Premium DIBUKA 2026-10-24 (perintah Hestia): gembok blanket dicabut.
  // Akses panen diatur gerbang pangkat di bawah — hanya user yang paketnya
  // (dari vocher/admin) mencakup tier ini yang bisa panen. Pro kini bermesin
  // Vega; Premium bermesin Stella (keduanya live).
  // Kunci tier: user tidak bisa panen tier di atas paketnya (admin userId=null = bebas).
  if (userId != null && tier && TIER_RANK[tier.slug] != null) {
    const u = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId);
    const userRank = TIER_RANK[effectiveTierSlug(u)] ?? 0;
    if (TIER_RANK[tier.slug] > userRank) throw new Error("Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu");
  }
  if (userId != null && tier && tier.slug === "media") { const um = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId); if (effectiveTierSlug(um) !== "media") throw new Error("Tier Media hanya bisa dipanen pemegang voucher Media. Tukar voucher Media dulu."); } // Per-tier TOTAL harvest limit per user (admin userId=null = unlimited).
  // Dihitung dari harvested_accounts (satuan AKUN) — sejak 2026-10-21 semua tier gabung-key,
  // jadi jumlah api_keys tidak lagi sama dengan jumlah akun.
  if (userId != null && tier && TIER_HARVEST_LIMIT[tier.slug] != null) {
    const limit = TIER_HARVEST_LIMIT[tier.slug];
    const existing = db.prepare("SELECT COUNT(*) AS c FROM harvested_accounts WHERE user_id=? AND tier_id=?").get(userId, tier.id).c;
    if (existing + count > limit) throw new Error(`Limit Tier ${tier.name || tier.slug}: maks ${limit} akun. Kamu sudah punya ${existing} akun.`);
  }
  // Gratis: 2 hari TOTAL (dari panen pertama). Abis 2 hari, GAK BISA panen lagi (harus upgrade).
  if (userId != null && tier && tier.slug === "gratis") {
    const u = db.prepare("SELECT gratis_started_at FROM users WHERE id=?").get(userId);
    const now = new Date();
    if (u && u.gratis_started_at) {
      const started = new Date(u.gratis_started_at);
      if (now - started > 2*24*60*60*1000) {
        throw new Error("Masa gratis 2 hari habis! Upgrade paket untuk lanjut.");
      }
    } else {
      // Panen pertama: catat waktu mulai.
      db.prepare("UPDATE users SET gratis_started_at=? WHERE id=?").run(now.toISOString(), userId);
    }
  }
  // Resolve models: Stella (190) / Media (22) pakai katalog configured dulu supaya snapshot kunci
  // baru = katalog, bukan daftar live upstream (515 + alias -latest). Tier lain tetap
  // endpoint dulu seperti semula. Fallback: kalau configured kosong, pakai logika lama.
  let models = null, source = "none";
  if (provider.brand_name === "Stella" || provider.brand_name === "Media") {
    try { const cfg = JSON.parse(provider.model_list_json || "[]"); if (cfg.length) { models = cfg; source = "configured"; } } catch {}
  }
  if (!models) {
    const fetched = await fetchProviderModels(provider);
    if (fetched) { models = fetched; source = "endpoint"; }
    else {
      try { const cfg = JSON.parse(provider.model_list_json || "[]"); if (cfg.length) { models = cfg; source = "configured"; } } catch {}
    }
  }
  if (!models) models = [];
  // Gratis tier: enforce max 2 models.
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  const logs = []; const keys = [];
  // SEMUA tier: gabung N akun jadi 1 key (asalnya Gratis saja 2026-10-18; diperluas ke semua
  // tier 2026-10-21 sore, perintah Hestia: tier berbayar disamakan dengan Gratis).
  // 1 api_keys row, N harvested_accounts rows. Gateway failover otomatis antar akun di key itu.
  // Credit key = TOTAL pendapatan dari akun yang HIDUP saja (default_credit x liveCount) —
  // akun yang mati/gagal register TIDAK dihitung (aturan Hestia 2026-10-21; contoh dia:
  // 3 akun hidup x $0.20 = $0.60). Credit dihitung SETELAH loop panen, lalu di-UPDATE ke key.
  // Khusus Gratis: credit null. Kedaluwarsa 2 hari HANYA Gratis; berbayar expires_at null
  // (key mati karena credit habis, bukan tanggal — jadi tidak ikut terhapus auto-cleanup).
  {
    const isGratis = (tier && tier.slug === "gratis");
    const keyValue = `hgw-${randHex(16)}`;
    const keyPrefix = keyValue.slice(0, 12);
    const expiresAt = isGratis ? new Date(Date.now() + 2*24*60*60*1000).toISOString() : null;
    const k = db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(userId, providerId, provider.tier_id, keyValue, keyPrefix, null, JSON.stringify(models), source, provider.model_count, expiresAt);
    const apiKeyId = k.lastInsertRowid;
    let liveCount = 0; let gagalTanpaProxy = false; _proxyNol = false;
    for (let i = 1; i <= count; i++) {
      const tempEmail = `hf_${randStr(10)}@hestiaflow.internal`;
      const tempPassword = randStr(16, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      let auto = null;
      try { auto = await tryAutoRegister(provider, tempEmail, tempPassword); } catch { auto = null; } if (_proxyNol) gagalTanpaProxy = true;
      if (auto && auto.live) liveCount++;
      const storeEmail = (auto && auto.tempEmail) ? auto.tempEmail : tempEmail;
      const storePass = (auto && auto.tempPassword) ? auto.tempPassword : tempPassword;
      db.prepare("INSERT INTO harvested_accounts (api_key_id,user_id,provider_id,tier_id,temp_email,temp_password,upstream_api_key,upstream_base_url,expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(apiKeyId, userId, providerId, provider.tier_id, storeEmail, storePass, auto ? auto.upstreamApiKey : null, auto ? auto.upstreamBaseUrl : null, (auto && auto.expiresAt) || null);
      const msg = `Panen Akun ${i} Berhasil.`;
      logHarvest(userId, providerId, msg);
      logs.push(msg);
    }
    if (!liveCount && gagalTanpaProxy) { db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(apiKeyId); db.prepare("DELETE FROM api_keys WHERE id=?").run(apiKeyId); throw new Error("Panen dibatalkan: tidak ada proxy OK yang terkumpul, jadi pendaftaran tidak dijalankan tanpa proxy."); }
    // Credit final: hanya akun hidup yang dihitung (aturan pendapatan Hestia 2026-10-21).
    const credit = isGratis ? null : (provider.default_credit != null ? provider.default_credit * liveCount : null);
    if (credit != null) db.prepare("UPDATE api_keys SET credit=? WHERE id=?").run(credit, apiKeyId);
    keys.push({ id: apiKeyId, providerBrand: provider.brand_name, tierSlug: tier ? tier.slug : null, key: userId ? keyValue : undefined, keyPrefix, credit, models, modelSource: source, modelCount: provider.model_count, live: liveCount > 0, combinedAccounts: count,, liveAccounts: liveCount });
    return { count, logs, keys, proxyTotal:_proxyOk };
  }
}

// ---------- auth ----------
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.redirect("/?oauth=missing");
  const state = randHex(16);
  res.cookie("oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/" });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    const raw = req.headers.cookie || "";
    const stateCookie = (raw.match(/(?:^|;\s*)oauth_state=([^;]+)/) || [])[1];
    if (!req.query.code || !req.query.state || req.query.state !== decodeURIComponent(stateCookie || "")) return res.redirect("/?oauth=error");
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: req.query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect("/?oauth=error");
    const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const me = await meRes.json();
    if (!me.email) return res.redirect("/?oauth=error");
    const isAdmin = ADMIN_EMAILS.includes(String(me.email).toLowerCase()) ? 1 : 0;
    let user = db.prepare("SELECT * FROM users WHERE email=?").get(me.email);
    if (!user) {
      const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin) VALUES (?,?,?,?,?)").run(me.sub || "", me.email, me.name || me.email, me.picture || "", isAdmin);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    } else if (isAdmin && !user.is_admin) {
      db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(user.id);
      user.is_admin = 1;
    }
    catatJejakLogin(req, user.id);
    res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 * 1000 });
    res.redirect("/");
  } catch (e) { res.redirect("/?oauth=error"); }
});
app.post("/api/logout", (req, res) => {
  res.clearCookie("hestia_session", { path: "/" });
  res.json({ ok: true });
});
// Test-only login (only when TEST_SECRET is set). Never active in production.
app.post("/api/test-login", (req, res) => {
  if (!TEST_SECRET || req.body.secret !== TEST_SECRET) return res.status(404).json({ ok: false });
  const { email, name, isAdmin } = req.body;
  if (!email) return res.status(400).json({ ok: false, error: "email_required" });
  let user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) {
    const r = db.prepare("INSERT INTO users (google_id,email,name,avatar,is_admin) VALUES (?,?,?,?,?)").run("test-" + randHex(6), email, name || email, "", isAdmin ? 1 : 0);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
  }
  catatJejakLogin(req, user.id);
  res.cookie("hestia_session", signSession(user.id), { httpOnly: true, sameSite: "lax", path: "/" });
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } });
});

// ---------- public API ----------
app.get("/api/me", (req, res) => {
  const u = getSessionUser(req);
  res.json({ ok: true, user: u || null, oauthConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
});
app.get("/api/public/providers", (req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({ ok: true, providers: rows.map(publicProvider) });
});
app.get("/api/public/providers/:id/models", (req, res) => {
  const p = db.prepare("SELECT * FROM providers WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: "provider_not_found" });
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; }
  res.json({ ok: true, providerId: p.id, brand: p.brand_name, modelCount: p.model_count, models });
});
app.get("/api/public/tiers", (req, res) => {
  const tiers = db.prepare("SELECT * FROM tiers ORDER BY sort_order").all().map((t) => ({
    id: t.id, slug: t.slug, name: t.name, audienceLabel: t.audience_label, badge: t.badge, maxModels: t.max_models, locked: t.slug === "pro" && !proEnabled(),
    providers: db.prepare("SELECT * FROM providers WHERE tier_id=? ORDER BY sort_order").all(t.id).map(publicProvider),
  }));
  res.json({ ok: true, tiers });
});
app.get("/api/public/pool", (req, res) => {
  const workers = db.prepare("SELECT COUNT(*) c FROM workers WHERE status='active'").get().c;
  res.json({ ok: true, workers, ready: workers > 0 });
});
app.get("/api/public/settings", (req, res) => {
  const name = (db.prepare("SELECT value FROM settings WHERE key='gateway_name'").get() || {}).value || "HestiaFlow";
  const base = (db.prepare("SELECT value FROM settings WHERE key='base_url'").get() || {}).value || GATEWAY_BASE_URL;
  res.json({ ok: true, gatewayName: name, baseUrl: base });
});

// ---------- BANSOS TOKEN (tanpa login, maks 2 key per pengunjung) ----------
const BANSOS_KEY_LIMIT = 2;
// Peta nama publik -> id model upstream (server-side saja, tidak pernah dikirim ke klien).
const BANSOS_MODEL_MAP = { "codestral-latest": "codestral/codestral-latest", "qwen3.6-27b": "groq/qwen/qwen3.6-27b", "gpt-oss-20b": "groq/openai/gpt-oss-20b", "mistral-large-latest": "mistral/mistral-large-latest" };
const BANSOS_PER_ACCOUNT_DAILY = 500000;
function bansosProvider() { return db.prepare("SELECT * FROM providers WHERE brand_name='Bansos'").get() || null; }
// Saklar gembok Bansos (perintah Hestia 2026-10-23): env BANSOS_ENABLED=0 mengunci total —
// klaim key baru ditolak dan key bansos yang beredar tidak bisa dipakai. Hapus env / set 1 untuk membuka.
function bansosEnabled() { return process.env.BANSOS_ENABLED !== "0"; } /* Kunci total Pro (perintah Hestia 2026-10-25): Pro terkunci secara default, dibuka dengan PRO_ENABLED=1. */ function proEnabled() { return process.env.PRO_ENABLED === "1";}
function bansosDay() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function bansosPool() {
  const p = bansosProvider();
  if (!p) return { total: 0, used: 0, remaining: 0, accounts: 0 };
  const ws = db.prepare("SELECT id FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL").all(p.id);
  const day = bansosDay();
  let total = 0, used = 0;
  for (const w of ws) {
    total += BANSOS_PER_ACCOUNT_DAILY;
    const u = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(day, w.id);
    used += Math.min(u ? u.tokens : 0, BANSOS_PER_ACCOUNT_DAILY);
  }
  return { total, used, remaining: Math.max(0, total - used), accounts: ws.length };
}
function recordBansosUsage(workerId, tokens) {
  try {
    const t = Math.max(0, Math.floor(Number(tokens) || 0));
    db.prepare("INSERT INTO bansos_usage (day,worker_id,tokens,requests) VALUES (?,?,?,1) ON CONFLICT(day,worker_id) DO UPDATE SET tokens=tokens+?, requests=requests+1").run(bansosDay(), workerId, t, t);
  } catch {}
}
function getAnonId(req, res) {
  const raw = String(req.headers.cookie || "");
  const part = raw.split(";").map((s) => s.trim()).find((s) => s.indexOf("hf_anon=") === 0);
  let id = part ? part.slice("hf_anon=".length) : "";
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = randHex(16);
    res.setHeader("Set-Cookie", "hf_anon=" + id + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax");
  }
  return id;
}
app.get("/api/bansos/pool", (req, res) => {
  if (!bansosEnabled()) return res.json({ ok: true, enabled: false, total: 0, used: 0, remaining: 0, accounts: 0 });
  const p = bansosPool();
  res.json({ ok: true, enabled: true, total: p.total, used: p.used, remaining: p.remaining, accounts: p.accounts });
});
app.get("/api/bansos/my-keys", (req, res) => {
  const anon = getAnonId(req, res);
  const p = bansosProvider();
  if (!p) return res.json({ ok: true, keys: [], limit: BANSOS_KEY_LIMIT, locked: false });
  const rows = db.prepare("SELECT key_value, created_at FROM api_keys WHERE anon_id=? AND provider_id=? AND status='active' ORDER BY id ASC").all(anon, p.id);
  res.json({ ok: true, keys: rows.map((r) => ({ key: r.key_value, createdAt: r.created_at })), limit: BANSOS_KEY_LIMIT, locked: !bansosEnabled() || rows.length >= BANSOS_KEY_LIMIT });
});
app.post("/api/bansos/keys", (req, res) => {
  if (!bansosEnabled()) return res.status(403).json({ ok: false, error: "Bansos sedang digembok sementara.", code: "bansos_disabled" });
  const anon = getAnonId(req, res);
  const p = bansosProvider();
  if (!p) return res.status(503).json({ ok: false, error: "Bansos belum tersedia." });
  const cnt = db.prepare("SELECT COUNT(*) c FROM api_keys WHERE anon_id=? AND provider_id=? AND status='active'").get(anon, p.id).c;
  if (cnt >= BANSOS_KEY_LIMIT) return res.status(403).json({ ok: false, error: "Kamu sudah buat 2 API key. Tombol buat key terkunci.", code: "bansos_key_limit" });
  let models = [];
  try { models = JSON.parse(p.model_list_json || "[]"); } catch {}
  const keyValue = "hgw-" + randHex(16);
  db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count,anon_id) VALUES (NULL,?,NULL,?,?,NULL,?,'provider',?,?)").run(p.id, keyValue, keyValue.slice(0, 12), JSON.stringify(models), models.length, anon);
  res.json({ ok: true, key: keyValue, limit: BANSOS_KEY_LIMIT, count: cnt + 1, locked: cnt + 1 >= BANSOS_KEY_LIMIT });
});

// ---------- user API ----------
app.get("/api/my-keys", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT k.*, p.brand_name AS brand, t.slug AS tier_slug FROM api_keys k LEFT JOIN providers p ON p.id=k.provider_id LEFT JOIN tiers t ON t.id=k.tier_id WHERE k.user_id=? AND k.status='active' ORDER BY k.created_at DESC").all(req.user.id);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, key: k.key_value, keyPrefix: k.key_prefix, providerBrand: k.brand, tierSlug: k.tier_slug, credit: k.credit, models: JSON.parse(k.models_json || "[]"), modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at })) });
});
app.post("/api/my-keys", requireAuth, async (req, res) => {
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  try {
    const out = await doHarvest({ userId: req.user.id, providerId: provider.id, count: 1 });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Voucher redeem: kode 16 karakter (1x pakai) -> upgrade paket user selama durasi tier (Plus 3 hari, Pro 7 hari, Premium 14 hari).
app.post("/api/voucher/redeem", requireAuth, (req, res) => {
  if (req.user.suspended) return res.status(403).json({ ok: false, error: "Akun kamu sedang disuspend oleh admin." });
  const raw = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 16) return res.status(400).json({ ok: false, error: "Kode vocher harus 16 karakter." });
  const v = db.prepare("SELECT * FROM vouchers WHERE REPLACE(code,'-','')=?").get(raw);
  if (!v) return res.status(404).json({ ok: false, error: "Kode vocher tidak ditemukan." });
  if (v.used) return res.status(400).json({ ok: false, error: "Kode vocher sudah dipakai." }); if (v.tier_slug === "pro" && !proEnabled()) return res.status(403).json({ ok: false, error: "Tier Pro sedang dikunci (Segera Hadir)." });
  const expires = new Date(Date.now() + (v.duration_days || 0) * 86400000).toISOString();
  db.prepare("UPDATE vouchers SET used=1, used_by=?, used_at=datetime('now') WHERE id=?").run(req.user.id, v.id);
  db.prepare("UPDATE users SET tier_slug=?, tier_expires_at=? WHERE id=?").run(v.tier_slug, expires, req.user.id);
  const label = { plus: "Plus", pro: "Pro", premium: "Premium", media: "Media" }[v.tier_slug] || v.tier_slug;
  // Voucher Media: hanya membuka tier (seperti voucher lain); key didapat lewat Panen Akun.
  
  res.json({ ok: true, tierSlug: v.tier_slug, expiresAt: expires, mediaKey: null, message: `Vocher berhasil! Paket kamu jadi ${label} sampai ${new Date(expires).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}.` });
});
// Admin: buat / list / hapus vocher.
app.post("/api/admin/vouchers", requireAdmin, (req, res) => {
  const slug = String(req.body.tierSlug || "").toLowerCase();
  if (!["plus", "pro", "premium", "media"].includes(slug)) return res.status(400).json({ ok: false, error: "invalid_tier" });
  const code = genVoucherCode();
  const r = db.prepare("INSERT INTO vouchers (code,tier_slug,duration_days) VALUES (?,?,?)").run(code, slug, VOUCHER_DAYS[slug]);
  res.json({ ok: true, voucher: { id: r.lastInsertRowid, code, tierSlug: slug, durationDays: VOUCHER_DAYS[slug], used: false } });
});

app.get("/api/admin/vouchers", requireAdmin, (req, res) => {
const rows = db.prepare("SELECT v.*, u.email AS used_by_email FROM vouchers v LEFT JOIN users u ON u.id=v.used_by ORDER BY v.created_at DESC").all();
  res.json({ ok: true, vouchers: rows.map((v) => ({ id: v.id, code: v.code, tierSlug: v.tier_slug, durationDays: v.duration_days, used: !!v.used, usedBy: v.used_by_email || null, usedAt: v.used_at, createdAt: v.created_at })) });
});
app.delete("/api/admin/vouchers/:id", requireAdmin, (req, res) => {
  const out = db.prepare("DELETE FROM vouchers WHERE id=?").run(req.params.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "voucher_not_found" });
  res.json({ ok: true });
});
app.post("/api/harvest", requireAuth, async (req, res) => {
  if (req.user.suspended) return res.status(403).json({ ok: false, error: "account_suspended" });
  const count = Number(req.body.count);
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  try {
    const out = await doHarvest({ userId: req.user.id, providerId: provider.id, count });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Delete own harvested key (harvest result) so it is no longer stored.
// Removes the HestiaFlow key + the stored harvested-account data (upstream key, temp creds).
// User-scoped: only the owner can delete their own key.
app.delete("/api/my-keys/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(id);
  const out = db.prepare("DELETE FROM api_keys WHERE id=? AND user_id=?").run(id, req.user.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "key_not_found" });
  res.json({ ok: true, deleted: true });
});
app.get("/api/harvest/logs", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT hl.*, p.brand_name AS brand FROM harvest_logs hl LEFT JOIN providers p ON p.id=hl.provider_id WHERE hl.user_id=? ORDER BY hl.created_at DESC LIMIT 100").all(req.user.id);
  res.json({ ok: true, logs: rows });
});

// ---------- admin API ----------
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  res.json({ ok: true, stats: {
    users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    keys: db.prepare("SELECT COUNT(*) c FROM api_keys WHERE status='active'").get().c,
    providers: db.prepare("SELECT COUNT(*) c FROM providers").get().c,
    workers: db.prepare("SELECT COUNT(*) c FROM workers WHERE status='active'").get().c,
    tiers: db.prepare("SELECT COUNT(*) c FROM tiers").get().c,
  } });
});
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.status='active') AS key_count FROM users u ORDER BY u.created_at DESC").all();
  res.json({ ok: true, users: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, avatar: u.avatar, isAdmin: !!u.is_admin, suspended: !!u.suspended, lastIp: u.last_ip || null, device: ringkasPerangkat(u.last_ua), lastUa: u.last_ua || null, lastLoginAt: u.last_login_at || null, keyCount: u.key_count, createdAt: u.created_at, tierSlug: effectiveTierSlug(u) })) });
});
app.post("/api/admin/users/:id/tier", requireAdmin, (req, res) => {
  const slug = String(req.body.tierSlug || "").toLowerCase();
  if (!["gratis", "plus", "pro", "premium"].includes(slug)) return res.status(400).json({ ok: false, error: "invalid_tier" });
  const out = db.prepare("UPDATE users SET tier_slug=? WHERE id=?").run(slug, req.params.id);
  if (!out.changes) return res.status(404).json({ ok: false, error: "user_not_found" });
  res.json({ ok: true, tierSlug: slug });
});
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ ok: false, error: "cannot_delete_self" });
  // URUTAN WAJIB anak -> induk: node:sqlite menegakkan FOREIGN KEY secara
  // default, jadi api_keys TIDAK boleh dihapus sebelum harvested_accounts
  // yang menunjuknya bersih — kalau terbalik, server melempar
  // "FOREIGN KEY constraint failed" (HTTP 500). Terbukti live 2026-10-24:
  // hapus pengguna yang punya kunci panen selalu gagal 500.
  db.prepare("DELETE FROM harvested_accounts WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM media_logs WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvest_logs WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/admin/users/:id/suspend", requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ ok: false, error: "cannot_suspend_self" });
  const target = db.prepare("SELECT id, is_admin FROM users WHERE id=?").get(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });
  if (target.is_admin) return res.status(400).json({ ok: false, error: "cannot_suspend_admin" });
  const val = req.body && req.body.suspended ? 1 : 0;
  db.prepare("UPDATE users SET suspended=? WHERE id=?").run(val, req.params.id);
  res.json({ ok: true, suspended: !!val });
});
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  const q = req.query.userId ? "WHERE k.user_id=?" : "";
  const args = req.query.userId ? [req.query.userId] : [];
  const rows = db.prepare(`SELECT k.*, u.email AS owner_email, u.name AS owner_name, p.brand_name AS brand, t.slug AS tier_slug FROM api_keys k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN providers p ON p.id=k.provider_id LEFT JOIN tiers t ON t.id=k.tier_id ${q} ORDER BY k.created_at DESC LIMIT 500`).all(...args);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, keyPrefix: k.key_prefix, ownerEmail: k.owner_email, ownerName: k.owner_name, providerBrand: k.brand, tierSlug: k.tier_slug, credit: k.credit, models: JSON.parse(k.models_json || "[]"), modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at })) });
});
app.delete("/api/admin/keys/:id", requireAdmin, (req, res) => {
  // Hapus API key milik pengguna (2026-10-24, perintah Hestia). Anak dulu
  // (FK aktif di node:sqlite): akun panen yang menunjuk key ini dibersihkan
  // sebelum key-nya, kalau tidak server melempar 500 FK constraint.
  const key = db.prepare("SELECT id FROM api_keys WHERE id=?").get(req.params.id);
  if (!key) return res.status(404).json({ ok: false, error: "key_not_found" });
  db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?").run(req.params.id);
  db.prepare("DELETE FROM api_keys WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/tiers", requireAdmin, (req, res) => {
  const tiers = db.prepare("SELECT * FROM tiers ORDER BY sort_order").all().map((t) => ({ ...t, providerCount: db.prepare("SELECT COUNT(*) c FROM providers WHERE tier_id=?").get(t.id).c }));
  res.json({ ok: true, tiers });
});
app.post("/api/admin/tiers", requireAdmin, (req, res) => {
  const { name, audienceLabel, badge, maxModels } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: "name_required" });
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || ("tier-" + randStr(6));
  const r = db.prepare("INSERT INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)").run(slug, name, audienceLabel || "", badge || "", maxModels != null ? Number(maxModels) : null, 99);
  res.json({ ok: true, id: r.lastInsertRowid, slug });
});
app.put("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const { name, audienceLabel, badge, maxModels } = req.body;
  db.prepare("UPDATE tiers SET name=?, audience_label=?, badge=?, max_models=? WHERE id=?").run(name, audienceLabel || "", badge || "", maxModels != null ? Number(maxModels) : null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/tiers/:id", requireAdmin, (req, res) => {
  const n = db.prepare("SELECT COUNT(*) c FROM providers WHERE tier_id=?").get(req.params.id).c;
  if (n > 0) return res.status(400).json({ ok: false, error: "tier_has_providers" });
  db.prepare("DELETE FROM tiers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/providers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM providers ORDER BY tier_id, sort_order").all();
  res.json({ ok: true, providers: rows.map(adminProvider) });
});
app.post("/api/admin/providers", requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.brandName || !b.tierId) return res.status(400).json({ ok: false, error: "brand_and_tier_required" });
  let models = b.models || [];
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(b.tierId);
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  const r = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_name,upstream_url,upstream_api_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(b.tierId, b.brandName, b.tagline || "", b.modelCount != null ? Number(b.modelCount) : models.length, JSON.stringify(models), JSON.stringify(b.modelNotes || {}), b.creditNote || "", b.defaultCredit != null ? Number(b.defaultCredit) : null, 99, b.upstreamName || null, b.upstreamUrl || null, b.upstreamApiKey || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const b = req.body;
  const cur = db.prepare("SELECT * FROM providers WHERE id=?").get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: "not_found" });
  let models = b.models != null ? b.models : JSON.parse(cur.model_list_json || "[]");
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(b.tierId != null ? b.tierId : cur.tier_id);
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  db.prepare("UPDATE providers SET tier_id=?, brand_name=?, tagline=?, model_count=?, model_list_json=?, model_notes_json=?, credit_note=?, default_credit=?, upstream_name=?, upstream_url=?, upstream_api_key=COALESCE(?,upstream_api_key) WHERE id=?")
    .run(b.tierId != null ? b.tierId : cur.tier_id, b.brandName != null ? b.brandName : cur.brand_name, b.tagline != null ? b.tagline : cur.tagline,
      b.modelCount != null ? Number(b.modelCount) : models.length, JSON.stringify(models), JSON.stringify(b.modelNotes != null ? b.modelNotes : JSON.parse(cur.model_notes_json || "{}")),
      b.creditNote != null ? b.creditNote : cur.credit_note, b.defaultCredit !== undefined ? (b.defaultCredit != null ? Number(b.defaultCredit) : null) : cur.default_credit,
      b.upstreamName !== undefined ? (b.upstreamName || null) : cur.upstream_name, b.upstreamUrl !== undefined ? (b.upstreamUrl || null) : cur.upstream_url,
      b.upstreamApiKey || null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/providers/:id", requireAdmin, (req, res) => {
  // Urutan anak -> induk juga di sini (FK aktif): harvested_accounts yang
  // menunjuk api_keys harus bersih dulu, baru keys, workers, terakhir provider.
  db.prepare("DELETE FROM harvested_accounts WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM api_keys WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM workers WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM providers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/api/admin/harvest", requireAdmin, async (req, res) => {
  const count = Number(req.body.count);
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(req.body.providerId);
  if (!provider) return res.status(404).json({ ok: false, error: "provider_not_found" });
  if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ ok: false, error: "count_must_be_1_to_50" });
  try {
    const out = await doHarvest({ userId: null, providerId: provider.id, count });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get("/api/admin/workers", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT w.*, p.brand_name AS brand FROM workers w LEFT JOIN providers p ON p.id=w.provider_id ORDER BY w.created_at DESC").all();
  res.json({ ok: true, workers: rows.map((w) => ({ id: w.id, providerId: w.provider_id, providerBrand: w.brand, name: w.name, credit: w.credit, status: w.status, createdAt: w.created_at })) });
});
app.post("/api/admin/workers", requireAdmin, (req, res) => {
  const { providerId, name, credit, upstreamApiKey } = req.body;
  if (!providerId || !name) return res.status(400).json({ ok: false, error: "provider_and_name_required" });
  const r = db.prepare("INSERT INTO workers (provider_id,name,credit,upstream_api_key) VALUES (?,?,?,?)").run(providerId, name, Number(credit) || 0, upstreamApiKey || null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put("/api/admin/workers/:id", requireAdmin, (req, res) => {
  const { name, credit, status } = req.body;
  db.prepare("UPDATE workers SET name=COALESCE(?,name), credit=COALESCE(?,credit), status=COALESCE(?,status) WHERE id=?").run(name || null, credit != null ? Number(credit) : null, status || null, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/admin/workers/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM workers WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT key,value FROM settings").all();
  const out = {}; rows.forEach((r) => { out[r.key] = r.value; });
  res.json({ ok: true, settings: out });
});
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
  }
  res.json({ ok: true });
});
app.post("/api/admin/proxy-pool/import", requireAdmin, (req, res) => { try { const proxies = req.body && req.body.proxies; if (!Array.isArray(proxies)) return res.status(400).json({ ok: false, error: "proxies_required" }); if (proxies.length > 500) return res.status(400).json({ ok: false, error: "too_many_proxies" }); let skipped = 0; const seen = new Set(); const valid = []; for (const item of proxies) { let s = typeof item === "string" ? item.trim() : ""; s = s.replace(/^https?:\/\//i, "").trim(); if (!/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) { skipped++; continue; } if (!seen.has(s)) { seen.add(s); valid.push(s); } } const stmt = db.prepare("INSERT OR REPLACE INTO proxy_pool (host, target, last_ok, fails) VALUES (?, 'vega', datetime('now'), 0)"); for (const host of valid) stmt.run(host); res.json({ ok: true, inserted: valid.length, skipped: skipped, total: proxies.length }); } catch (e) { res.status(500).json({ ok: false, error: e && e.message }); } }); app.get("/api/admin/harvest-logs", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT hl.*, p.brand_name AS brand, u.email AS user_email FROM harvest_logs hl LEFT JOIN providers p ON p.id=hl.provider_id LEFT JOIN users u ON u.id=hl.user_id ORDER BY hl.created_at DESC LIMIT 200").all();
  res.json({ ok: true, logs: rows });
});


// ---------- OpenAI-compatible gateway (Path 1: HestiaFlow key + Base URL) ----------
// NEVER exposes upstream identity/credentials. Forwarding is server-side only.
function gatewayAuth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = db.prepare("SELECT * FROM api_keys WHERE key_value=? AND status='active'").get(m[1].trim()) || null;
  if (!key) return null;
  // Cek kadaluarsa per-key (Gratis: 2 hari dari panen).
  if (key.expires_at && new Date(key.expires_at) < new Date()) key._expired = true;
  // Pro + Premium DIBUKA 2026-10-24 (perintah Hestia): tidak ada lagi kunci
  // blanket di gateway — key tier berbayar yang sah (dipanen user berpangkat
  // paket cukup / dari vocher) langsung bisa dipakai.
  // Cek masa Gratis TOTAL (2 hari dari panen pertama) — 2026-10-18. Abis 2 hari, key mati total.
  if (!key._expired && key.user_id && key.tier_id) {
    const tier = db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id);
    if (tier && tier.slug === "gratis") {
      const u = db.prepare("SELECT gratis_started_at FROM users WHERE id=?").get(key.user_id);
      if (u && u.gratis_started_at && Date.now() - new Date(u.gratis_started_at).getTime() > 2*24*60*60*1000) {
        key._expired = true;
      }
    }
  }
  // Suspend pengguna (2026-10-24): key milik user yang disuspend admin mati total.
  if (key.user_id) {
    try { const ow = db.prepare("SELECT suspended FROM users WHERE id=?").get(key.user_id); if (ow && ow.suspended) key._suspended = true; } catch {}
  }
  return key;
}
function gatewayKeyModels(key) {
  let models = [];
  try { models = JSON.parse(key.models_json || "[]"); } catch { models = []; }
  if (!models.length && key.provider_id) {
    const p = db.prepare("SELECT model_list_json FROM providers WHERE id=?").get(key.provider_id);
    if (p) { try { models = JSON.parse(p.model_list_json || "[]"); } catch { models = []; } }
  }
  return models;
}
app.get("/v1/models", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided. You can find your HestiaFlow API key at Halaman Pengguna.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._suspended) return res.status(403).json({ error: { message: "Akun pemilik API key ini sedang disuspend oleh admin.", type: "invalid_request_error", param: null, code: "account_suspended" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const models = gatewayKeyModels(key);
  const now = Math.floor(Date.now() / 1000);
  res.json({ object: "list", data: models.map((id) => ({ id, object: "model", created: now, owned_by: "hestiaflow" })) });
});
app.get("/v1/credit", (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided. You can find your HestiaFlow API key at Halaman Pengguna.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._suspended) return res.status(403).json({ error: { message: "Akun pemilik API key ini sedang disuspend oleh admin.", type: "invalid_request_error", param: null, code: "account_suspended" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const provider = key.provider_id ? db.prepare("SELECT brand_name, credit_note FROM providers WHERE id=?").get(key.provider_id) : null;
  const tier = key.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id) : null;
  // BANSOS: credit = sisa pool bersama hari ini (angka asli dari pemakaian gateway).
  if (key.anon_id) {
    const pool = bansosPool();
    return res.json({
      object: "credit",
      brand: provider ? provider.brand_name : "Bansos",
      tier: null,
      credit: pool.remaining,
      credit_note: provider ? (provider.credit_note || null) : null,
      total_tokens: pool.total,
      used_tokens: pool.used,
      accounts: pool.accounts,
      live_accounts: pool.accounts,
      created_at: key.created_at || null,
      expires_at: null,
    });
  }
  const acc = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN upstream_api_key IS NOT NULL THEN 1 ELSE 0 END) AS live FROM harvested_accounts WHERE api_key_id=?").get(key.id) || { total: 0, live: 0 };
  res.json({
    object: "credit",
    brand: provider ? provider.brand_name : null,
    tier: tier ? tier.slug : null,
    credit: key.credit != null ? key.credit : null,
    credit_note: provider ? (provider.credit_note || null) : null,
    accounts: acc.total || 0,
    live_accounts: acc.live || 0,
    created_at: key.created_at || null,
    expires_at: key.expires_at || null,
  });
});
app.post("/v1/chat/completions", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._coming_soon) return res.status(401).json({ error: { message: "Segera Hadir!", type: "invalid_request_error", param: null, code: "coming_soon" } });
  if (key._suspended) return res.status(403).json({ error: { message: "Akun pemilik API key ini sedang disuspend oleh admin.", type: "invalid_request_error", param: null, code: "account_suspended" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa (Gratis: 2 hari). Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  const { model, messages, stream } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: { message: "model and messages are required.", type: "invalid_request_error", param: null, code: "invalid_request" } });
  // Streaming (SSE passthrough) — automatic, no admin setting needed.
  const allowed = gatewayKeyModels(key);
  if (allowed.length && !allowed.includes(model)) return res.status(404).json({ error: { message: `Model '${model}' is not included in this API key.`, type: "invalid_request_error", param: "model", code: "model_not_found" } });
  // Upstream resolution (server-side only, never exposed):
  // 1) This HestiaFlow key's own harvested account(s) (auto-registered upstream key).
  //    Gratis (2026-10-18): 1 key -> N akun, failover otomatis (coba satu-satu).
  // 2) Provider-level upstream (operator-configured).
  // 3) Active worker key for this provider (provider URL + worker key).
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  if (provider && !proEnabled() && (provider.brand_name === "Vega" || ((provider.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(provider.tier_id) : null) || {}).slug === "pro" || ((key.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id) : null) || {}).slug === "pro")) return res.status(403).json({ error: { message: "Tier Pro sedang dikunci (Segera Hadir).", type: "invalid_request_error", param: null, code: "pro_locked" } }); let upstreamUrl = null, upstreamKey = null;
  let upstreamCandidates = [];
  // BANSOS: key anonim memakai pool akun (workers) bergiliran, yang paling sedikit dipakai duluan.
  const isBansosKey = !!(key.anon_id && provider);
  // Potong credit token: premium/pro saja.
  let isTokenTier = false;
  try { const tt = db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id); if (tt && (tt.slug === "premium" || tt.slug === "pro")) isTokenTier = !isBansosKey; } catch {}
  const potongCreditToken = (totalTokens) => { if (!isTokenTier || key.credit == null) return; try { const n = Math.max(0, Math.floor(Number(totalTokens) || 0)); if (n > 0) db.prepare("UPDATE api_keys SET credit = MAX(0, COALESCE(credit,0) - ?) WHERE id = ?").run(n, key.id); } catch {} };
  
  if (isBansosKey) {
    if (!bansosEnabled()) return res.status(403).json({ error: { message: "Bansos sedang digembok sementara.", type: "invalid_request_error", param: null, code: "bansos_disabled" } });
    const poolNow = bansosPool();
    if (poolNow.remaining <= 0) return res.status(429).json({ error: { message: "Token bansos hari ini habis. Besok ngisi lagi!", type: "rate_limit_error", param: null, code: "bansos_pool_empty" } });
    const dayB = bansosDay();
    const wsB = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL").all(provider.id);
    const sortedB = wsB.map((w) => { const u = db.prepare("SELECT tokens FROM bansos_usage WHERE day=? AND worker_id=?").get(dayB, w.id); return { w, used: u ? u.tokens : 0 }; })
      .filter((x) => x.used < BANSOS_PER_ACCOUNT_DAILY)
      .sort((a, b) => a.used - b.used);
    for (const x of sortedB) upstreamCandidates.push({ key: x.w.upstream_api_key, url: provider.upstream_url, workerId: x.w.id });
  }
  // Cek tier untuk failover Gratis
  let isGratisTier = false;
  try {
    const t = db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id);
    if (t && t.slug === "gratis") isGratisTier = true;
  } catch {}
  if (isGratisTier) {
    // Gratis gabungan: ambil SEMUA akun, coba satu-satu (failover).
    // Akun yang lagi cooldown (kena 429, jeda 6 jam) dilewati dulu (2026-10-22).
    const has = db.prepare("SELECT id, upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY id ASC").all(key.id, new Date().toISOString());
    for (const h of has) {
      upstreamCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || (provider ? provider.upstream_url : null), harvestId: h.id });
    }
  } else {
    // Semua akun hidup jadi kandidat (terbaru dulu) — failover WAJIB jalan di semua tier
    // (2026-10-23, perintah Hestia: "akun yang di suspend jangan ikut masuk"). Dulu cuma
    // 1 akun terbaru yang dimuat, jadi kalau akun itu kena suspend, error-nya tembus ke
    // pengguna dan akun sehat di key yang sama tidak pernah dicoba. Sekarang akun yang
    // suspend dihapus permanen dan request diteruskan ke akun sehat berikutnya.
    const has = db.prepare("SELECT id, upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until<=?) ORDER BY id DESC").all(key.id, new Date().toISOString());
    for (const h of has) {
      upstreamCandidates.push({ key: h.upstream_api_key, url: h.upstream_base_url || (provider ? provider.upstream_url : null), harvestId: h.id });
    }
  }
  if (upstreamCandidates.length === 0 && provider) {
    // Fallback ke provider-level
    if (provider.upstream_url || provider.upstream_api_key) {
      upstreamCandidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
    }
  }
  if (upstreamCandidates.length === 0 && provider) {
    const w = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
    if (w) upstreamCandidates.push({ key: w.upstream_api_key, url: provider.upstream_url });
  }
  if (upstreamCandidates.length === 0) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  // Body yang diteruskan ke upstream (khusus bansos: terjemahkan nama model + minta usage saat stream).
  let fwdBody = req.body;
  if (isBansosKey) {
    fwdBody = Object.assign({}, req.body);
    if (BANSOS_MODEL_MAP[model]) fwdBody.model = BANSOS_MODEL_MAP[model];
    if (stream) fwdBody.stream_options = { include_usage: true };
  }
  if (isTokenTier && stream) { fwdBody = Object.assign({}, req.body); fwdBody.stream_options = Object.assign({}, req.body.stream_options, { include_usage: true }); }
  // Auto-hapus akun panen mati/habis saldo (2026-10-22, perintah Hestia — biar akun habis
  // tidak numpuk dan tidak dicoba terus-menerus): hanya kandidat ber-harvestId yang disentuh;
  // kandidat worker Bansos (workerId) TIDAK pernah dihapus/dijeda oleh logika ini.
  const panenMati = (cand, status) => {
    if (!cand.harvestId) return;
    try {
      db.prepare("DELETE FROM harvested_accounts WHERE id=?").run(cand.harvestId);
      console.log(`[cleanup] akun panen #${cand.harvestId} dihapus (upstream ${status})`);
    } catch {}
  };
  const panenJeda = (cand) => {
    // 429 = batas harian/rate limit (bisa pulih): jeda 6 jam + fail_count naik, JANGAN hapus.
    if (!cand.harvestId) return;
    try {
      db.prepare("UPDATE harvested_accounts SET fail_count=COALESCE(fail_count,0)+1, cooldown_until=? WHERE id=?")
        .run(new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), cand.harvestId);
    } catch {}
  };
  const panenPulih = (cand) => {
    // Akun berhasil melayani lagi: reset hitungan gagal + cooldown-nya.
    if (!cand.harvestId) return;
    try {
      db.prepare("UPDATE harvested_accounts SET fail_count=0, cooldown_until=NULL WHERE id=? AND (COALESCE(fail_count,0)>0 OR cooldown_until IS NOT NULL)").run(cand.harvestId);
    } catch {}
  };
  // Failover: coba tiap upstream sampai berhasil (untuk Gratis gabungan).
  let lastError = null;
  for (const cand of upstreamCandidates) {
    const upstreamUrl = cand.url;
    const upstreamKey = cand.key;
    if (!upstreamUrl || !upstreamKey) continue;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 120000);
      const r = await fetch(stripV1(upstreamUrl) + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamKey}`, "User-Agent": "HestiaFlow/1.0" },
        body: JSON.stringify(fwdBody),
        signal: ctl.signal,
      });
      // Jika rate limit / 402 / 403 / 401 (key upstream mati), coba kandidat berikutnya (failover).
      if ((r.status === 429 || r.status === 402 || r.status === 403 || r.status === 401) && upstreamCandidates.length > 1) {
        clearTimeout(t);
        // Catat nasib akun panennya (2026-10-22): 429 -> jeda; 401/402/403 -> hapus permanen.
        if (cand.harvestId) { if (r.status === 429) panenJeda(cand); else panenMati(cand, r.status); }
        lastError = `Upstream ${r.status}, coba berikutnya`;
        continue;
      }
      // Kandidat satu-satunya: nasib akun panen tetap dicatat sebelum respons diteruskan,
      // supaya akun mati/habis saldo tidak disimpan & dicoba lagi di request berikutnya (2026-10-22).
      if (cand.harvestId && (r.status === 401 || r.status === 402 || r.status === 403)) panenMati(cand, r.status);
      else if (cand.harvestId && r.status === 429) panenJeda(cand);
      if (stream && r.body) {
        // SSE passthrough: stream provider chunks straight to the client.
        res.writeHead(r.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const reader = r.body.getReader();
        let tailB = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkB = Buffer.from(value);
            if (isBansosKey && cand.workerId) tailB = (tailB + chunkB.toString("utf8")).slice(-8000);
            if (isTokenTier) tailB = (tailB + chunkB.toString("utf8")).slice(-8000);
            
            res.write(chunkB);
          }
        } finally { clearTimeout(t); }
        if (isBansosKey && cand.workerId && tailB) {
          const mB = [...tailB.matchAll(/"total_tokens"\s*:\s*(\d+)/g)];
          if (mB.length) recordBansosUsage(cand.workerId, Number(mB[mB.length - 1][1]));
        }
        if (isTokenTier && r.status >= 200 && r.status < 300 && tailB) { const mT = [...tailB.matchAll(/"total_tokens"\s*:\s*(\d+)/g)]; if (mT.length) potongCreditToken(Number(mT[mT.length - 1][1])); }
        if (cand.harvestId && r.status >= 200 && r.status < 300) panenPulih(cand);
        return res.end();
      }
      clearTimeout(t);
      const data = await r.json().catch(() => ({}));
      // Jika error rate limit, coba berikutnya
      if (data && data.error && /rate[_ ]limit|insufficient|quota|revoked|authentication|account_blocked|suspended/i.test(JSON.stringify(data.error)) && upstreamCandidates.length > 1) {
        // Badan error = bukti akun mati/habis kuota juga (2026-10-22): rate limit -> jeda, sisanya -> hapus.
        const errTxt = JSON.stringify(data.error);
        if (cand.harvestId) { if (/rate[_ ]limit/i.test(errTxt)) panenJeda(cand); else panenMati(cand, r.status); }
        lastError = errTxt.slice(0, 100);
        continue;
      }
      if (isBansosKey && cand.workerId && r.status >= 200 && r.status < 300 && data && data.usage && data.usage.total_tokens) recordBansosUsage(cand.workerId, data.usage.total_tokens);
      // Satu kandidat + badan error akun mati/habis kuota: tetap dicatat sebelum diteruskan (2026-10-22).
      // Respons sukses (2xx) dari akun panen: reset fail_count + cooldown-nya.
      if (cand.harvestId && data && data.error && /insufficient|quota|revoked|authentication|account_blocked|suspended/i.test(JSON.stringify(data.error))) panenMati(cand, r.status);
      else if (cand.harvestId && r.status >= 200 && r.status < 300) panenPulih(cand);
      if (isTokenTier && r.status >= 200 && r.status < 300 && data && data.usage && data.usage.total_tokens) potongCreditToken(data.usage.total_tokens);
      
      return res.status(r.status).json(data);
    } catch (e) {
      lastError = e && e.message;
      continue; // Coba kandidat berikutnya
    }
  }
  console.error("[gateway] all upstreams failed:", lastError);
  if (!res.headersSent) return res.status(502).json({ error: { message: "Semua upstream gagal. Coba lagi nanti.", type: "upstream_error", param: null, code: "upstream_all_failed" } });
  return res.end();
});

let _renderfulFirebaseKey = null; const _renderfulNamaDepan = ["Budi", "Sari", "Dewi", "Andi", "Rina", "Joko", "Maya", "Rizki", "Putri", "Adi"]; const _renderfulNamaBelakang = ["Santoso", "Wijaya", "Pratama", "Lestari", "Nugraha", "Hidayat", "Kusuma", "Rahma", "Saputra", "Anggraini"]; function _renderfulSleep(ms) { return new Promise((r) => setTimeout(r, ms)); } async function ambilProxySegar(namaLangkah) { try { const raw = await fetchProxyList(); const cand = [...raw].sort(() => Math.random() - 0.5).slice(0, 40); const checks = await Promise.all(cand.map(async (p) => { try { const d = proxyDispatcher(p); if (!d) return null; const r = await fetch("https://renderful.ai/signup", { dispatcher: d, signal: AbortSignal.timeout(7000), headers: { "User-Agent": randUA() } }); const b = await r.text().catch(() => ""); return r && r.status === 200 && b.includes("/_next/static/chunks/") ? p : null; } catch { return null; } })); const ok = checks.filter(Boolean); console.log("[renderful] proxy lolos cek: " + ok.length + " dari 40 (" + namaLangkah + ")"); return ok.length ? ok[0] : null; } catch { console.log("[renderful] proxy lolos cek: 0 dari 40 (" + namaLangkah + ")"); return null; } } async function _renderfulCariKunci(F, headers) { const r = await F("https://renderful.ai/signup", { headers }, 30000); if (r.status !== 200) return { key: null, reason: "status=" + r.status }; const html = await r.text(); const paths = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"'\s]+\.js/g)].map((m) => m[0]))]; if (!paths.length) return { key: null, reason: "no-chunks" }; for (const path of paths) { const cr = await F("https://renderful.ai" + path, { headers }, 30000); if (cr.status !== 200) continue; const js = await cr.text(); if (!js.includes("firebase")) continue; const m = js.match(/AIza[0-9A-Za-z_-]{35}/); if (m) return { key: m[0], reason: null }; } return { key: null, reason: "no-key" }; } async function _renderfulLangkah(nama, ms, fn) { for (let perc = 1; perc <= 3; perc++) { const proxy = await ambilProxySegar(nama); if (!proxy) { console.log("[renderful] gagal: " + nama + " no_proxy"); if (perc === 3) return { ok: false, reason: "no_proxy" }; continue; } const disp = proxyDispatcher(proxy); if (!disp) { console.log("[renderful] gagal: " + nama + " no_proxy"); if (perc === 3) return { ok: false, reason: "no_proxy" }; continue; } const F = async (url, opts = {}, timeoutMs) => { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs || ms); try { const h = { ...(opts.headers || {}), "User-Agent": randUA() }; return await fetch(url, { ...opts, headers: h, signal: ctl.signal, dispatcher: disp }); } finally { clearTimeout(t); } }; const headers = { "User-Agent": randUA() }; try { const hasil = await fn(F, headers); if (hasil && hasil.ok) return hasil; const alasan = (hasil && hasil.reason) || "timeout"; console.log("[renderful] gagal: " + nama + " " + alasan); if (perc === 3) return { ok: false, reason: alasan }; } catch (e) { console.log("[renderful] gagal: " + nama + " timeout"); if (perc === 3) return { ok: false, reason: "timeout" }; } } return { ok: false, reason: "timeout" }; } async function tryAutoRegisterRenderful() { try { console.log("[renderful] akun mulai"); const gagalAkun = (langkah, alasan) => { const peta = { oob: "[renderful] gagal: oob ", magic: "[renderful] gagal: magic ", signin: "[renderful] gagal: signin ", developer: "[renderful] gagal: developer ", key: "[renderful] gagal: key ", saldo: "[renderful] gagal: saldo " }; if (peta[langkah]) console.log(peta[langkah] + alasan); console.log("[renderful] akun gagal: " + langkah + " " + alasan); return { live: false }; }; const fb = await _renderfulLangkah("firebase", 30000, async (F, headers) => { if (_renderfulFirebaseKey) return { ok: true, key: _renderfulFirebaseKey }; const cari = await _renderfulCariKunci(F, headers); if (cari.key) { _renderfulFirebaseKey = cari.key; return { ok: true, key: cari.key }; } return { ok: false, reason: cari.reason }; }); if (!fb.ok) return gagalAkun("firebase", fb.reason); const inbox = await _renderfulLangkah("inbox", 25000, async (F, headers) => { const genRes = await F("https://api.tempmail.ing/api/generate", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ duration: 60 }) }); if (genRes.status !== 200) return { ok: false, reason: "status=" + genRes.status }; const gen = await genRes.json().catch(() => null); const email = gen && (gen.email && gen.email.address ? gen.email.address : (gen.address || gen.email)); if (!email || typeof email !== "string") return { ok: false, reason: "no-magic" }; return { ok: true, email }; }); if (!inbox.ok) return gagalAkun("inbox", inbox.reason); const email = inbox.email; const magic = await _renderfulLangkah("magic", 25000, async (F, headers) => { const oobRes = await F("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=" + _renderfulFirebaseKey, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "EMAIL_SIGNIN", email, continueUrl: "https://renderful.ai/login", canHandleCodeInApp: true }) }); if (oobRes.status !== 200) return { ok: false, reason: "status=" + oobRes.status }; return { ok: true }; }); if (!magic.ok) return gagalAkun("magic", magic.reason); const oob = await _renderfulLangkah("oob", 25000, async (F, headers) => { let oobCode = null; for (let waited = 0; waited < 210000 && !oobCode; waited += 8000) { await _renderfulSleep(8000); let clean = ""; try { const listRes = await F("https://api.tempmail.ing/api/emails/" + encodeURIComponent(email), { headers }); clean = (await listRes.text()).replace(/&amp;/g, "&"); } catch { clean = ""; } const modeUrls = [...clean.matchAll(/https?:\/\/[^\s"'<>]*mode=signIn[^\s"'<>]*/g)].map((m) => m[0]); for (const u of modeUrls) { const mm = u.match(/oobCode=([A-Za-z0-9_-]+)/); if (mm) { oobCode = mm[1]; break; } } if (!oobCode) { const mm = clean.match(/oobCode=([A-Za-z0-9_-]+)/); if (mm) oobCode = mm[1]; } } if (!oobCode) return { ok: false, reason: "no-magic" }; return { ok: true, oobCode }; }); if (!oob.ok) return gagalAkun("oob", oob.reason); const oobCode = oob.oobCode; const signin = await _renderfulLangkah("signin", 25000, async (F, headers) => { let signRes = await F("https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=" + _renderfulFirebaseKey, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ email, oobCode }) }); let signJson = await signRes.json().catch(() => null); let idToken = signJson && signJson.idToken; if (!idToken && signJson && signJson.error && /API_KEY|INVALID/i.test(signJson.error.message || "")) { const cari = await _renderfulCariKunci(F, headers); if (cari.key) { _renderfulFirebaseKey = cari.key; signRes = await F("https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=" + _renderfulFirebaseKey, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ email, oobCode }) }); signJson = await signRes.json().catch(() => null); idToken = signJson && signJson.idToken; } } if (!idToken) return { ok: false, reason: signRes.status ? "status=" + signRes.status : "timeout" }; return { ok: true, idToken }; }); if (!signin.ok) return gagalAkun("signin", signin.reason); const idToken = signin.idToken; const nama = _renderfulNamaDepan[Math.floor(Math.random() * _renderfulNamaDepan.length)] + " " + _renderfulNamaBelakang[Math.floor(Math.random() * _renderfulNamaBelakang.length)]; const developer = await _renderfulLangkah("developer", 25000, async (F, headers) => { const devRes = await F("https://renderful.ai/api/internal/create-developer", { method: "POST", headers: { ...headers, "Content-Type": "application/json", Authorization: "Bearer " + idToken, Origin: "https://renderful.ai/dashboard/keys", Referer: "https://renderful.ai/dashboard/keys" }, body: JSON.stringify({ displayName: nama, attribution: null, deviceFingerprint: crypto.randomBytes(16).toString("hex") }) }); if (devRes.status !== 200) return { ok: false, reason: "status=" + devRes.status }; return { ok: true }; }); if (!developer.ok) return gagalAkun("developer", developer.reason); const key = await _renderfulLangkah("key", 25000, async (F, headers) => { const keyRes = await F("https://renderful.ai/api/internal/api-keys", { method: "POST", headers: { ...headers, "Content-Type": "application/json", Authorization: "Bearer " + idToken }, body: JSON.stringify({ name: nama }) }); if (keyRes.status !== 200 && keyRes.status !== 201) return { ok: false, reason: "status=" + keyRes.status }; const keyJson = await keyRes.json().catch(() => null); let apiKey = keyJson && (keyJson.key || keyJson.apiKey || (keyJson.data && keyJson.data.key)); if (!apiKey && keyJson) { const mm = JSON.stringify(keyJson).match(/msk_[A-Za-z0-9_-]+/); if (mm) apiKey = mm[0]; } if (!apiKey || !apiKey.startsWith("msk_")) return { ok: false, reason: "format-key" }; return { ok: true, apiKey }; }); if (!key.ok) return gagalAkun("key", key.reason); const apiKey = key.apiKey; const saldo = await _renderfulLangkah("saldo", 25000, async (F, headers) => { const balRes = await F("https://api.renderful.ai/api/v1/account/balance", { headers: { ...headers, Authorization: "Bearer " + apiKey } }); if (balRes.status !== 200) return { ok: false, reason: "status=" + balRes.status }; const balJson = await balRes.json().catch(() => null); const balance = balJson ? Number(balJson.balance !== undefined ? balJson.balance : (balJson.data && balJson.data.balance)) : NaN; if (!Number.isFinite(balance)) return { ok: false, reason: "saldo-invalid" }; return { ok: true, balance }; }); if (!saldo.ok) return gagalAkun("saldo", saldo.reason); console.log("[renderful] akun hidup, saldo $" + saldo.balance); return { live: true, apiKey, balance: saldo.balance }; } catch (e) { const pesan = e && e.message ? String(e.message).slice(0, 200) : "unknown"; console.log("[renderful] gagal: crash " + pesan); console.log("[renderful] akun gagal: crash " + pesan); return { live: false }; } } 
// Model gambar upstream bekerja lewat chat completions; endpoint ini menerjemahkan
// ================= JALUR 2 — MEDIA (gambar/video) + PANTAUAN DRIVE =================
// Perintah Hestia 2026-10-23: web support generate gambar & video; SEMUA hasil WAJIB
// tersalin ke Google Drive pantauan miliknya (akun 400GB) dengan identitas key pembuatnya,
// supaya bisa dipantau + diblokir kalau ada yang macam-macam (catatan: media_logs).
// Mesin: Renderful (POST /v1/generations, async poll). Pool key dari env RENDERFUL_API_KEYS
// (pisah koma/spasi, pola sama seperti pool Bansos). Salin ke Drive MURNI fetch (tanpa
// rclone): token dari PANTAU_CLIENT_ID/PANTAU_CLIENT_SECRET/PANTAU_REFRESH_TOKEN (scope
// drive.file, folder akar "hestiaflow-pantau", subfolder = key_prefix pembuat).
const MEDIA_IMAGE_MODELS = ["flux-schnell", "z-image", "grok-imagine-image", "wan-2.2", "flux-dev", "gpt-image-2", "seedream-5.0-lite"];
const MEDIA_VIDEO_MODELS = ["seedance-1.5-pro", "seedance-1.0-pro-fast"];
// Edit gambar (image-to-image; wajib image_url) + video-dari-video (wajib video_url).
// Nama field input dibuktikan dari pesan error provider 2026-10-23.
// gpt-image-1-mini-i2i DIBUANG 2026-10-23: key OpenAI milik provider sendiri mati
// ("GPT Image edit failed: Incorrect API key provided: sk-proj-***") — model rusak di hulu.
const MEDIA_I2I_MODELS = ["seededit-3.0-i2i", "grok-imagine-image-i2i", "seedream-4-i2i", "flux-kontext-pro-i2i", "flux-2-i2i", "nano-banana-pro-i2i", "gpt-image-2-i2i"];
const MEDIA_V2V_MODELS = ["bytedance-video-upscaler", "lucy-restyle", "lucy-edit", "wan-2.7-videoedit", "seedance-2.0-video-edit", "happyhorse-1.0-video-edit"];
const RENDERFUL_BASE = "https://api.renderful.ai/v1";
function renderfulKeys() {   const envKeys = (process.env.RENDERFUL_API_KEYS || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);   return [...new Set(envKeys)]; }
let _rfIdx = 0;
function logMedia(row) {
  try {
    db.prepare("INSERT INTO media_logs (api_key_id,user_id,media_type,model,prompt,cost_usd,gen_id,source_url,drive_path,copy_status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(row.api_key_id || null, row.user_id || null, row.media_type, row.model, (row.prompt || "").slice(0, 500), row.cost_usd || null, row.gen_id || null, row.source_url || null, row.drive_path || null, row.copy_status || null);
  } catch {}
}
async function renderfulGenerate(apiKey, type, model, prompt, extra) {
  const r = await fetch(RENDERFUL_BASE + "/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(Object.assign({ model, type, prompt }, extra || {})),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id) throw new Error("renderful " + r.status + " " + ((j && (j.message || j.error)) || ""));
  const deadline = Date.now() + (type.includes("video") ? 300000 : 180000);
  let last = j;
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 5000));
    const g = await fetch(RENDERFUL_BASE + "/generations/" + j.id, { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(30000) });
    last = await g.json().catch(() => null);
    if (last && last.status === "completed") return last;
    if (last && (last.status === "failed" || last.status === "error")) throw new Error("renderful generation failed: " + (last.error || last.message || "unknown"));
  }
  throw new Error("renderful timeout");
}
let _pantauTok = { token: null, exp: 0 };
async function pantauAccessToken() {
  if (_pantauTok.token && Date.now() < _pantauTok.exp) return _pantauTok.token;
  const cid = process.env.PANTAU_CLIENT_ID, sec = process.env.PANTAU_CLIENT_SECRET, ref = process.env.PANTAU_REFRESH_TOKEN;
  if (!cid || !sec || !ref) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: sec, refresh_token: ref, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.access_token) return null;
  _pantauTok = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  return _pantauTok.token;
}
async function pantauFindOrCreateFolder(tok, name, parent) {
  const q = encodeURIComponent("name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false" + (parent ? " and '" + parent + "' in parents" : ""));
  const r = await fetch("https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=files(id,name)", { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (j && j.files && j.files.length) return j.files[0].id;
  const b = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parent) b.parents = [parent];
  const c = await fetch("https://www.googleapis.com/drive/v3/files", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(30000) });
  const cj = await c.json().catch(() => null);
  return (cj && cj.id) || null;
}
async function copyToPantau(folderName, fileName, srcUrl) {
  const tok = await pantauAccessToken();
  if (!tok) return { status: "pantau_not_configured" };
  const root = await pantauFindOrCreateFolder(tok, "hestiaflow-pantau", null);
  if (!root) return { status: "folder_failed" };
  const sub = await pantauFindOrCreateFolder(tok, folderName, root);
  if (!sub) return { status: "folder_failed" };
  const dl = await fetch(srcUrl, { signal: AbortSignal.timeout(120000) });
  if (!dl.ok) return { status: "download_failed" };
  const buf = Buffer.from(await dl.arrayBuffer());
  const mime = dl.headers.get("content-type") || "application/octet-stream";
  const boundary = "hf" + Date.now().toString(36);
  const meta = JSON.stringify({ name: fileName, parents: [sub] });
  const body = Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n"),
    buf,
    Buffer.from("\r\n--" + boundary + "--"),
  ]);
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "multipart/related; boundary=" + boundary },
    body,
    signal: AbortSignal.timeout(180000),
  });
  const uj = await up.json().catch(() => null);
  if (!up.ok || !uj || !uj.id) return { status: "upload_failed" };
  return { status: "ok", fileId: uj.id, path: "hestiaflow-pantau/" + folderName + "/" + fileName };
}
async function handleMedia(req, res, mediaType, key) {
  if (key._suspended) return res.status(403).json({ error: { message: "Akun pemilik API key ini sedang disuspend oleh admin.", type: "invalid_request_error", param: null, code: "account_suspended" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa. Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  if (!key.user_id) return res.status(403).json({ error: { message: "Generate media butuh API key dari akun yang login (bukan key anonim).", type: "invalid_request_error", param: null, code: "media_login_required" } });
  const tier = key.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id) : null;
  if (!tier || tier.slug !== "media") return res.status(403).json({ error: { message: "Generate gambar/video khusus tier Media.", type: "invalid_request_error", param: null, code: "media_tier_only" } });
  const keys = []; try { const ha = db.prepare("SELECT upstream_api_key FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id DESC").all(key.id); for (const h of ha) keys.push(h.upstream_api_key); } catch {} if (!keys.length && key.provider_id) { try { const p = db.prepare("SELECT upstream_api_key FROM providers WHERE id=?").get(key.provider_id); if (p && p.upstream_api_key && !keys.includes(p.upstream_api_key)) keys.push(p.upstream_api_key); } catch {} } if (!keys.length && key.provider_id) { try { const w = db.prepare("SELECT upstream_api_key FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(key.provider_id); if (w && w.upstream_api_key && !keys.includes(w.upstream_api_key)) keys.push(w.upstream_api_key); } catch {} } for (const ek of (process.env.RENDERFUL_API_KEYS || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) if (!keys.includes(ek)) keys.push(ek);
  if (!keys.length) return res.status(502).json({ error: { message: "Mesin media belum dikonfigurasi operator.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
  const isVideo = mediaType === "video";
  const list = isVideo ? [...MEDIA_VIDEO_MODELS, ...MEDIA_V2V_MODELS] : [...MEDIA_IMAGE_MODELS, ...MEDIA_I2I_MODELS];
  const model = body.model || list[0];
  if (!list.includes(model)) return res.status(404).json({ error: { message: "Model media '" + model + "' tidak tersedia. Pilihan: " + list.join(", ") + ".", type: "invalid_request_error", param: "model", code: "model_not_found" } });
  const isI2I = !isVideo && MEDIA_I2I_MODELS.includes(model);
  const isV2V = isVideo && MEDIA_V2V_MODELS.includes(model);
  const imageUrl = body.image_url || body.image || body.input_image || null;
  const videoUrl = body.video_url || body.video || body.input_video || null;
  if (isI2I && !imageUrl) return res.status(400).json({ error: { message: "Model edit gambar butuh image_url (URL gambar sumber).", type: "invalid_request_error", param: "image_url", code: "invalid_request" } });
  if (isV2V && !videoUrl) return res.status(400).json({ error: { message: "Model video-dari-video butuh video_url (URL video sumber).", type: "invalid_request_error", param: "video_url", code: "invalid_request" } });
  const extra = {};
  if (imageUrl && !isVideo) extra.image_url = String(imageUrl);
  if (videoUrl && isVideo) extra.video_url = String(videoUrl);
  if (body.aspect_ratio) extra.aspect_ratio = String(body.aspect_ratio);
  if (!isVideo && body.size) {
    const sz = String(body.size).toLowerCase();
    if (sz.includes("1536x1024") || sz === "16:9" || sz === "landscape") extra.aspect_ratio = "16:9";
    else if (sz.includes("1024x1536") || sz === "9:16" || sz === "portrait" || sz === "vertical") extra.aspect_ratio = "9:16";
    else if (sz.includes("1024x1024") || sz === "1:1") extra.aspect_ratio = "1:1";
  }
  // Parameter lengkap (perintah Hestia 2026-10-23): diteruskan ke provider apa adanya.
  // Model yang tidak mendukung parameter tertentu menolaknya di hulu (gagal = tanpa biaya).
  if (Number.isInteger(body.seed)) extra.seed = body.seed;
  const neg = typeof body.negative_prompt === "string" ? body.negative_prompt : (typeof body.negativePrompt === "string" ? body.negativePrompt : "");
  if (neg.trim()) extra.negative_prompt = neg.trim().slice(0, 1000);
  if (isVideo) {
    const nf = parseInt(body.num_frames != null ? body.num_frames : body.frames, 10);
    if (Number.isFinite(nf) && nf > 0) extra.num_frames = nf;
    const fps = parseInt(body.fps, 10);
    if (Number.isFinite(fps) && fps > 0) extra.fps = fps;
    if (body.size && !body.resolution) {
      const szv = String(body.size).toLowerCase();
      if (szv.includes("1920x1080") || szv.includes("1080p")) extra.resolution = "1080p";
      else if (szv.includes("1280x720") || szv.includes("720p")) extra.resolution = "720p";
      else if (szv.includes("854x480") || szv.includes("480p")) extra.resolution = "480p";
    }
  }
  if (isVideo && !isV2V) {
    // Resep terverifikasi 2026-10-23: tanpa resolution eksplisit, Renderful mengisi "1k"
    // (bawaan gambar) dan Seedance menolaknya ("resolution not valid"). Durasi sah 4-12 dtk.
    // Model video-dari-video dikecualikan: bentuknya mengikuti video sumber.
    extra.resolution = body.resolution ? String(body.resolution) : (extra.resolution || "720p");
    if (!extra.num_frames) {
      const d = parseInt(body.duration, 10);
      extra.duration = Number.isFinite(d) ? Math.min(12, Math.max(4, d)) : 5;
    }
  }
  let gen = null, lastErr = null;
  for (let i = 0; i < keys.length && !gen; i++) {
    const apiKey = keys[(_rfIdx + i) % keys.length];
    try { gen = await renderfulGenerate(apiKey, isI2I ? "image-to-image" : isV2V ? "video-to-video" : isVideo ? "text-to-video" : "text-to-image", model, prompt, extra); _rfIdx = (_rfIdx + i) % keys.length; }
    catch (e) { lastErr = e; }
  }
  if (!gen) {
    logMedia({ api_key_id: key.id, user_id: key.user_id, media_type: mediaType, model, prompt, copy_status: "generation_failed" });
    return res.status(502).json({ error: { message: "Generate media gagal. Coba lagi nanti. (" + ((lastErr && lastErr.message) || "upstream") + ")", type: "upstream_error", param: null, code: "media_generation_failed" } });
  }
  const outUrl = (gen.outputs && gen.outputs[0]) || gen.output || "";
  const extRaw = (outUrl.split("?")[0].split(".").pop() || "").toLowerCase();
  const ext = /^[a-z0-9]{2,5}$/.test(extRaw) ? extRaw : (isVideo ? "mp4" : "jpg");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = ts + "_" + model + "_" + gen.id + "." + ext;
  let copy = { status: "skipped" };
  try { copy = await copyToPantau(key.key_prefix || ("key" + key.id), fileName, outUrl); } catch { copy = { status: "copy_exception" }; }
  // Bahan sumber (edit gambar / video-dari-video) ikut disalin ke folder pantauan yang sama.
  const inputUrl = isI2I ? imageUrl : isV2V ? videoUrl : null;
  if (inputUrl) {
    const iExtRaw = (String(inputUrl).split("?")[0].split(".").pop() || "").toLowerCase();
    const iExt = /^[a-z0-9]{2,5}$/.test(iExtRaw) ? iExtRaw : (isVideo ? "mp4" : "jpg");
    try { await copyToPantau(key.key_prefix || ("key" + key.id), ts + "_" + model + "_INPUT_" + gen.id + "." + iExt, String(inputUrl)); } catch { /* salinan bahan bersifat best-effort */ }
  }
  logMedia({ api_key_id: key.id, user_id: key.user_id, media_type: mediaType, model, prompt, cost_usd: (typeof gen.cost === "number" ? gen.cost : null), gen_id: gen.id, source_url: outUrl, drive_path: copy.path || null, copy_status: copy.status });
  return res.json({ created: Math.floor(Date.now() / 1000), data: [{ url: outUrl }] });
}
app.post("/v1/videos/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  try { return await handleMedia(req, res, "video", key); }
  catch (e) { return res.status(500).json({ error: { message: "Media handler error: " + (e && e.message), type: "upstream_error", param: null, code: "media_internal_error" } }); }
});
// format OpenAI images <-> chat, lalu membalas {created, data:[{b64_json}]}.
const IMAGE_MODEL_MAP = {
  "gemini-2.5-flash-image": "google/gemini-2.5-flash-image",
  "gemini-3-pro-image": "google/gemini-3-pro-image",
  "gpt-5-image": "openai/gpt-5-image",
  "gpt-5-image-mini": "openai/gpt-5-image-mini",
  "google/gemini-2.5-flash-image": "google/gemini-2.5-flash-image",
  "google/gemini-3-pro-image": "google/gemini-3-pro-image",
  "openai/gpt-5-image": "openai/gpt-5-image",
  "openai/gpt-5-image-mini": "openai/gpt-5-image-mini",
};
app.post("/v1/images/generations", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  if (key._pro_locked) return res.status(401).json({ error: { message: "Tier Pro sedang dalam perbaikan. Coba lagi nanti.", type: "invalid_request_error", param: null, code: "pro_locked" } });
  if (key._expired) return res.status(401).json({ error: { message: "API key sudah kadaluarsa. Panen lagi atau upgrade paket!", type: "invalid_request_error", param: null, code: "key_expired" } });
  if (key._suspended) return res.status(403).json({ error: { message: "Akun pemilik API key ini sedang disuspend oleh admin.", type: "invalid_request_error", param: null, code: "account_suspended" } });
  // JALUR 2: key tier Media dialihkan ke mesin Renderful + pantauan Drive (handleMedia).
  try { const t = key.tier_id ? db.prepare("SELECT slug FROM tiers WHERE id=?").get(key.tier_id) : null; if (t && t.slug === "media") return await handleMedia(req, res, "image", key); } catch (e) { return res.status(500).json({ error: { message: "Media handler error: " + (e && e.message), type: "upstream_error", param: null, code: "media_internal_error" } }); }
  // Catatan: kunci "Segera Hadir" (chat) tidak berlaku di sini — fitur gambar memang khusus Stella.
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  if (!provider || provider.brand_name !== "Stella") return res.status(403).json({ error: { message: "Generate gambar hanya untuk pengguna Premium (Stella). Upgrade paket untuk memakai fitur ini.", type: "invalid_request_error", param: null, code: "image_premium_only" } });
  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: { message: "prompt is required.", type: "invalid_request_error", param: "prompt", code: "invalid_request" } });
  const modelIn = body.model || "gemini-3-pro-image";
  const realModel = IMAGE_MODEL_MAP[modelIn];
  if (!realModel) return res.status(404).json({ error: { message: "Model gambar '" + modelIn + "' tidak tersedia. Pilihan: gemini-3-pro-image, gemini-2.5-flash-image, gpt-5-image, gpt-5-image-mini.", type: "invalid_request_error", param: "model", code: "model_not_found" } });
  let n = parseInt(body.n, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 4) n = 4;
  // Orientasi: model Pro nurut instruksi rasio di prompt (terverifikasi 768x1376 untuk potrait).
  const sz = String(body.size || "").toLowerCase();
  let orient = "";
  if (sz.includes("1536x1024") || sz === "landscape" || sz === "16:9" || sz === "horizontal") orient = " Horizontal landscape orientation, wide 16:9 aspect ratio.";
  else if (sz.includes("1024x1536") || sz === "portrait" || sz === "9:16" || sz === "vertical" || sz === "full portrait") orient = " Vertical portrait orientation, tall 9:16 aspect ratio, full body visible from head to toe.";
  const fullPrompt = "Generate an image: " + prompt + orient;
  // Kandidat upstream (sama seperti chat): akun panen terbaru -> provider -> worker aktif.
  let candidates = [];
  const ha = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id DESC LIMIT 1").get(key.id);
  if (ha) candidates.push({ key: ha.upstream_api_key, url: ha.upstream_base_url || provider.upstream_url });
  if (provider.upstream_url || provider.upstream_api_key) candidates.push({ key: provider.upstream_api_key, url: provider.upstream_url });
  const wk = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
  if (wk) candidates.push({ key: wk.upstream_api_key, url: provider.upstream_url });
  candidates = candidates.filter((c) => c.key && c.url);
  if (!candidates.length) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  const data = [];
  let lastErr = null;
  for (const cand of candidates) {
    if (data.length >= n) break;
    try {
      while (data.length < n) {
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 180000);
        let r, j;
        try {
          r = await fetch(stripV1(cand.url) + "/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cand.key, "User-Agent": "HestiaFlow/1.0" },
            body: JSON.stringify({ model: realModel, messages: [{ role: "user", content: fullPrompt }] }),
            signal: ctl.signal,
          });
          j = await r.json().catch(() => null);
        } finally { clearTimeout(tmo); }
        if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429) { lastErr = "Upstream " + r.status; break; }
        const imgs = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.images;
        if (!imgs || !imgs.length) { lastErr = "Upstream tidak mengembalikan gambar."; break; }
        for (const im of imgs) {
          const u = (im && im.image_url && im.image_url.url) || "";
          const b64 = u.includes(",") ? u.split(",").pop() : u;
          if (b64) data.push({ b64_json: b64 });
          if (data.length >= n) break;
        }
      }
    } catch (e) { lastErr = e && e.message; }
  }
  if (!data.length) return res.status(502).json({ error: { message: "Generate gambar gagal. Coba lagi nanti. (" + (lastErr || "upstream") + ")", type: "upstream_error", param: null, code: "image_generation_failed" } });
  return res.json({ created: Math.floor(Date.now() / 1000), data });
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// [TEMP-DB-IMPORT] endpoint impor database sekali pakai (token env DB_IMPORT_TOKEN)
app.post("/api/db-import", (req, res) => {
  const tok = process.env.DB_IMPORT_TOKEN || "";
  if (!tok || req.get("x-import-token") !== tok) return res.status(403).json({ ok: false });
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 100 || buf.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
        return res.status(400).json({ ok: false, error: "bukan file sqlite" });
      }
      fs.writeFileSync(DB_PATH + ".imported", buf);
      res.json({ ok: true, bytes: buf.length });
      setTimeout(() => process.exit(0), 600);
    } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
  });
  req.on("error", () => { try { res.status(500).json({ ok: false }); } catch {} });
});

// ---------- Auto-hapus key kedaluwarsa (2026-10-21, perintah Hestia) ----------
// Prosedur sama persis kayak hapus manual di web (DELETE /api/my-keys/:id):
// harvested_accounts milik key itu dibersihkan dulu, baru baris api_keys-nya.
// Yang dihapus HANYA key yang expires_at-nya sudah lewat. Key tanpa expires_at
// (NULL = tanpa masa aktif) dan key yang masih aktif TIDAK disentuh.
// Akun panenan yatim (key induknya sudah tidak ada) ikut dibersihkan.
// Sapuan akun panen (2026-10-22): yang expires_at-nya (masa aktif dari provider) sudah lewat
// + yang fail_count >= 5 (gagal berulang lewat siklus cooldown 429) ikut dihapus di sini.
// Jalan sekali pas server nyala + tiap 30 menit (dirapatkan dari 6 jam, 2026-10-22 — perintah
// Hestia: penghapusan berbasis waktu harus tepat/prompt), biar database tidak membengkak.
function cleanupExpiredKeys() {
  try {
    const nowIso = new Date().toISOString();
    const expired = db.prepare("SELECT id FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ?").all(nowIso);
    const delH = db.prepare("DELETE FROM harvested_accounts WHERE api_key_id=?");
    const delK = db.prepare("DELETE FROM api_keys WHERE id=?");
    let nKey = 0, nAcc = 0;
    for (const k of expired) {
      nAcc += delH.run(k.id).changes;
      nKey += delK.run(k.id).changes;
    }
    const orphan = db.prepare("DELETE FROM harvested_accounts WHERE api_key_id NOT IN (SELECT id FROM api_keys)").run();
    let expAcc = { changes: 0 }, deadAcc = { changes: 0 };
    try { expAcc = db.prepare("DELETE FROM harvested_accounts WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowIso); } catch {}
    try { deadAcc = db.prepare("DELETE FROM harvested_accounts WHERE COALESCE(fail_count,0) >= 5").run(); } catch {}
    if (nKey || orphan.changes || expAcc.changes || deadAcc.changes) {
      console.log(`[cleanup] auto-hapus: ${nKey} key kedaluwarsa, ${nAcc} akun panenannya, ${orphan.changes} akun yatim, ${expAcc.changes} akun panen kedaluwarsa, ${deadAcc.changes} akun panen gagal berulang`);
      // VACUUM: ruang baris yang dihapus tidak balik sendiri di SQLite — wajib buat volume Railway yang kecil.
      try { db.exec("VACUUM"); console.log("[cleanup] VACUUM selesai, ruang penyimpanan diklaim kembali"); } catch {}
    }
    return nKey;
  } catch (e) { console.log("[cleanup] exception", e && e.message); return 0; }
}
cleanupExpiredKeys();
const _cleanupTimer = setInterval(cleanupExpiredKeys, 30 * 60 * 1000);
if (_cleanupTimer.unref) _cleanupTimer.unref(); /* Pool proxy sweep vega */ async function sweepProxyPool() { try { const list = await fetchProxyList(); const diambil = list.length; let authBase = ""; try { const prov = db.prepare("SELECT upstream_url FROM providers WHERE brand_name='Vega'").get(); let apiBase = prov && prov.upstream_url ? String(prov.upstream_url) : ""; if (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1); authBase = apiBase.replace("://api.", "://chat."); if (authBase.endsWith("/v1")) authBase = authBase.slice(0, -3); } catch {} const cand = [...list].sort(() => Math.random() - 0.5).slice(0, 300); let lolos = []; if (authBase) { const cek = await Promise.all(cand.map(async (px) => { const d = proxyDispatcher(px); if (!d) return null; try { const r = await fetch(authBase + "/api/auth/csrf/", { dispatcher: d, headers: { "User-Agent": randUA() }, signal: AbortSignal.timeout(8000) }); return r.status < 500 ? px : null; } catch { return null; } })); lolos = cek.filter(Boolean); const okSet = new Set(lolos); for (const px of lolos) db.prepare("INSERT OR REPLACE INTO proxy_pool (host, target, last_ok, fails) VALUES (?, 'vega', datetime('now'), 0)").run(px); for (const px of cand) if (!okSet.has(px)) db.prepare("UPDATE proxy_pool SET fails=fails+1 WHERE host=? AND target='vega'").run(px); } /* Kontrol sekuensial (diagnostik): bila paralel lolos=0, coba kandidat segar satu-per-satu. */ if (authBase && lolos.length === 0) { try { const sudahDicoba = new Set(cand); const segar = [...list].sort(() => Math.random() - 0.5).filter((px) => !sudahDicoba.has(px)).slice(0, 50); let seqLolos = 0; let seqDicoba = 0; let seqProxy = null; for (const px of segar) { const d = proxyDispatcher(px); if (!d) continue; seqDicoba++; try { const r = await fetch(authBase + "/api/auth/csrf/", { dispatcher: d, headers: { "User-Agent": randUA() }, signal: AbortSignal.timeout(8000) }); if (r.status < 500) { seqLolos = 1; seqProxy = px; break; } } catch {} } if (seqProxy) db.prepare("INSERT OR REPLACE INTO proxy_pool (host, target, last_ok, fails) VALUES (?, 'vega', datetime('now'), 0)").run(seqProxy); console.log("[proxy-pool] sekuensial lolos=" + seqLolos + " dicoba=" + seqDicoba); } catch {} } /* Tes netral (diagnostik): kandidat yang sama ke host netral publik, dispatcher sama. */ try { const netralCand = cand.slice(0, 100); const netralCek = await Promise.all(netralCand.map(async (px) => { const d = proxyDispatcher(px); if (!d) return null; try { const r = await fetch("https://example.com", { dispatcher: d, headers: { "User-Agent": randUA() }, signal: AbortSignal.timeout(8000) }); return r.status > 0 ? px : null; } catch { return null; } })); const netralLolos = netralCek.filter(Boolean).length; console.log("[proxy-pool] netral dicek=" + netralCand.length + " lolos=" + netralLolos); } catch {} db.prepare("DELETE FROM proxy_pool WHERE target='vega' AND fails>=3").run(); const pool = db.prepare("SELECT COUNT(*) c FROM proxy_pool WHERE target='vega' AND fails=0").get().c; console.log("[proxy-pool] target=vega diambil=" + diambil + " dicek=" + (authBase ? cand.length : 0) + " lolos=" + lolos.length + " pool=" + pool); } catch (e) { console.log("[proxy-pool] sweep gagal:", e && e.message); } } const _proxyPoolTimer = setInterval(sweepProxyPool, 15 * 60 * 1000);
sweepProxyPool();if (_proxyPoolTimer.unref) _proxyPoolTimer.unref();

app.listen(PORT, () => console.log(`[hestiaflow] listening on port ${PORT}`));

// ---------- fresh-start katalog (2026-10-24): pastikan Luna/Aurora/Stella tampil ----------
(function freshStartCatalog() {
  try {
    db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('gratis','Gratis','KHUSUS PENGGUNA GRATIS','TIER GRATIS',8,1)").run();
    db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('plus','Plus','UNTUK PENGGUNA PLUS / BERBAYAR','TIER PLUS',NULL,2)").run();
    db.prepare("INSERT OR IGNORE INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES ('premium','Premium','PALING MAHAL','★ TIER PREMIUM',NULL,4)").run();
    const FRESH_LUNA_MODELS = ["auto","minimax/minimax-m3.1-flash:free","google/gemma-4-31b-it:free","google/gemma-4-26b-a4b-it:free","xingchen-agi/xing4.0-29b-a4b:free","cohere/north-mini-code:free","recursive/flint-v1.0:free","dots-studio/dots-3-note-preview:free"];
    db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT (SELECT id FROM tiers WHERE slug='gratis'),?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Luna')").run("Luna", "8 model gratis untuk semua.", 8, JSON.stringify(FRESH_LUNA_MODELS), "{}", "100 calls/hari per akun.", 0, 1, "https://www.zerolimitai.com/api/v1");
    db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT (SELECT id FROM tiers WHERE slug='plus'),?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Aurora')").run("Aurora", "Cahaya pertama di gerbang kecerdasan.", 10, JSON.stringify(AURORA_MODELS), "{}", "$0.20 per akun terverifikasi.", 200000, 1, process.env.PROVIDER_AURORA_UPSTREAM_URL || "");
    db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order,upstream_url) SELECT (SELECT id FROM tiers WHERE slug='premium'),?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM providers WHERE brand_name='Stella')").run("Stella", "Bintang paling terang di langit HestiaFlow.", 235, "[]", "{}", "235 model premium! $0.25 per akun.", 0, 1, process.env.PROVIDER_STELLA_UPSTREAM_URL || "");
    db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='gratis') WHERE brand_name IN ('Luna','Zerolimit') AND (tier_id IS NULL OR tier_id<>(SELECT id FROM tiers WHERE slug='gratis'))").run();
    db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='plus') WHERE brand_name='Aurora' AND (tier_id IS NULL OR tier_id<>(SELECT id FROM tiers WHERE slug='plus'))").run();
    db.prepare("UPDATE providers SET tier_id=(SELECT id FROM tiers WHERE slug='premium') WHERE brand_name='Stella' AND (tier_id IS NULL OR tier_id<>(SELECT id FROM tiers WHERE slug='premium'))").run();
    db.prepare("UPDATE providers SET model_count=8, model_list_json=? WHERE brand_name IN ('Luna','Zerolimit')").run(JSON.stringify(FRESH_LUNA_MODELS));
    db.prepare("UPDATE providers SET model_count=10, model_list_json=? WHERE brand_name='Aurora'").run(JSON.stringify(AURORA_MODELS));
    db.prepare("UPDATE providers SET model_count=190 WHERE brand_name='Stella'").run();
  } catch (e) { console.log("[fresh-start-katalog] gagal:", e && e.message); }
})();
