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
const AURORA_MODELS = ["claude-fable-5","claude-haiku-4-5-20251001","claude-opus-4-6","claude-opus-4.6","claude-opus-5","claude-sonnet-4-6","claude-sonnet-4.6","DeepSeek-V4-Flash","DeepSeek-V4-pro","doubao-seed-2-0-lite-260215","doubao-seedance-2-0-260128","gemini-2.5-flash","gemini-2.5-flash-image","gemini-2.5-flash-lite","gemini-3-flash-preview","gemini-3-pro-image","gemini-3-pro-image-preview","gemini-3.1-pro-preview","gemini-3.8-flash","GLM-5","gpt-5.4","gpt-5.6-luna","gpt-image-2","imagen-4.0-generate-001","Kimi-K2.5","kimi-k3","MiniMax-H3","MiniMax-M2.7","qwen3.5-plus","qwen3.6-plus"];
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
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER GRATIS", "gratis");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("TIER PLUS", "plus");
  db.prepare("UPDATE tiers SET badge=? WHERE slug=?").run("★ TIER PREMIUM", "premium");
  const tierCount = db.prepare("SELECT COUNT(*) c FROM tiers").get().c;
  if (tierCount > 0) return;
  const insTier = db.prepare("INSERT INTO tiers (slug,name,audience_label,badge,max_models,sort_order) VALUES (?,?,?,?,?,?)");
  const g = insTier.run("gratis", "Gratis", "KHUSUS PENGGUNA GRATIS", "TIER GRATIS", 2, 1).lastInsertRowid;
  const p = insTier.run("plus", "Plus", "UNTUK PENGGUNA PLUS / BERBAYAR", "TIER PLUS", null, 2).lastInsertRowid;
  const pr = insTier.run("premium", "Premium", "PALING MAHAL", "★ TIER PREMIUM", null, 3).lastInsertRowid;
  const insProv = db.prepare("INSERT INTO providers (tier_id,brand_name,tagline,model_count,model_list_json,model_notes_json,credit_note,default_credit,sort_order) VALUES (?,?,?,?,?,?,?,?,?)");
  insProv.run(g, "Luna", "Cahaya lembut untuk langkah pertama.", 2,
    JSON.stringify(["qwen3-coder:30b", "llama3.2:3b"]),
    JSON.stringify({ "qwen3-coder:30b": "Muncul di website provider. Chat terverifikasi jalan.", "llama3.2:3b": "Terdaftar di /v1/models. Tes chat gagal (service_unavailable)." }),
    "Always-free BETA", null, 1);
  insProv.run(p, "Aurora", "Cahaya pertama di gerbang kecerdasan.", 30,
    JSON.stringify(AURORA_MODELS), JSON.stringify({}),
    "200.000 token per akun terverifikasi.", 200000, 1);
  insProv.run(pr, "Stella", "Bintang paling terang di langit HestiaFlow.", 514,
    JSON.stringify([]), JSON.stringify({}),
    "30.000 token/hari per akun terverifikasi.", 30000, 1);
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('gateway_name','HestiaFlow')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('base_url',?)").run(GATEWAY_BASE_URL);
}
seed();
// Sync provider upstream URLs from env vars (PROVIDER_<BRAND>_UPSTREAM_URL).
// Operator config only — values live in Railway env, never in public code.
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("PROVIDER_") || !k.endsWith("_UPSTREAM_URL")) continue;
  const raw = k.slice("PROVIDER_".length, -"_UPSTREAM_URL".length);
  if (!raw) continue;
  const brand = raw.charAt(0) + raw.slice(1).toLowerCase();
  const url = String(v || "").trim();
  if (!url) continue;
  try { db.prepare("UPDATE providers SET upstream_url=? WHERE brand_name=?").run(url, brand); } catch {}
}

// ---------- helpers ----------
const app = express();
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
  const u = db.prepare("SELECT id,email,name,avatar,is_admin,created_at,COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(uid);
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
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      const list = txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
      if (list.length) { _proxyCache = { list, at: Date.now() }; return list; }
    } catch {}
  }
  return _proxyCache.list;
}
function proxyDispatcher(proxyHostPort) {
  try {
    const { ProxyAgent } = require("undici");
    return new ProxyAgent(`http://${proxyHostPort}`);
  } catch { return undefined; }
}

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

// Auto-register a real provider account (server-side, no admin config).
// Tries generic signup/login/key endpoints against the provider's upstream_url
// (operator-configured in DB). Returns { upstreamApiKey, upstreamBaseUrl } or null.
// NEVER logs or returns upstream credentials. Falls back to null on any failure
// (CAPTCHA, email verification, unknown flow) — caller keeps NULL upstream key.
async function tryAutoRegister(provider, tempEmail, tempPassword) {
  const base = (provider.upstream_url || "").replace(/\/$/, "");
  if (!base) return null;
  // Brand-specific flows (proven by operator's own scripts). Luna first (no verification).
  if ((provider.brand_name || "").toLowerCase() === "luna") {
    const luna = await tryAutoRegisterLuna(provider);
    if (luna) return luna;
    return null;
  }
  if ((provider.brand_name || "").toLowerCase() === "nova") {
    const nova = await tryAutoRegisterNova(provider);
    if (nova) return nova;
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

const TIER_HARVEST_LIMIT = { gratis: 2, plus: 10, pro: 20, premium: 50 };
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3 };
const VOUCHER_DAYS = { plus: 3, pro: 7, premium: 14 };
function effectiveTierSlug(u) { if (!u) return "gratis"; if (u.tier_expires_at && new Date(u.tier_expires_at) < new Date()) return "gratis"; return u.tier_slug || "gratis"; }
function genVoucherCode() { const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 16; i++) s += chars[crypto.randomInt(chars.length)]; return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16); }
async function doHarvest({ userId, providerId, count }) {
  const provider = db.prepare("SELECT * FROM providers WHERE id=?").get(providerId);
  if (!provider) throw new Error("provider_not_found");
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("count_must_be_1_to_50");
  const tier = db.prepare("SELECT * FROM tiers WHERE id=?").get(provider.tier_id);
  // Kunci tier: user tidak bisa panen tier di atas paketnya (admin userId=null = bebas).
  if (userId != null && tier && TIER_RANK[tier.slug] != null) {
    const u = db.prepare("SELECT COALESCE(tier_slug,'gratis') AS tier_slug,tier_expires_at FROM users WHERE id=?").get(userId);
    const userRank = TIER_RANK[effectiveTierSlug(u)] ?? 0;
    if (TIER_RANK[tier.slug] > userRank) throw new Error("Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu");
  }
  // Per-tier TOTAL harvest limit per user (admin userId=null = unlimited).
  if (userId != null && tier && TIER_HARVEST_LIMIT[tier.slug] != null) {
    const limit = TIER_HARVEST_LIMIT[tier.slug];
    const existing = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id=? AND tier_id=?").get(userId, tier.id).c;
    if (existing + count > limit) throw new Error(`Limit Tier ${tier.name || tier.slug}: maks ${limit} akun. Kamu sudah punya ${existing} akun.`);
  }
  // Resolve models: endpoint (if operator key) -> configured list -> honest empty.
  let models = null, source = "none";
  const fetched = await fetchProviderModels(provider);
  if (fetched) { models = fetched; source = "endpoint"; }
  else {
    try { const cfg = JSON.parse(provider.model_list_json || "[]"); if (cfg.length) { models = cfg; source = "configured"; } } catch {}
  }
  if (!models) models = [];
  // Gratis tier: enforce max 2 models.
  if (tier && tier.max_models != null && models.length > tier.max_models) models = models.slice(0, tier.max_models);
  const logs = []; const keys = [];
  for (let i = 1; i <= count; i++) {
    const tempEmail = `hf_${randStr(10)}@hestiaflow.internal`;
    const tempPassword = randStr(16, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    const keyValue = `hgw-${randHex(16)}`;
    const keyPrefix = keyValue.slice(0, 12);
    const credit = provider.default_credit != null ? provider.default_credit : null;
    const k = db.prepare("INSERT INTO api_keys (user_id,provider_id,tier_id,key_value,key_prefix,credit,models_json,model_source,model_count) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(userId, providerId, provider.tier_id, keyValue, keyPrefix, credit, JSON.stringify(models), source, provider.model_count);
    let auto = null;
    try { auto = await tryAutoRegister(provider, tempEmail, tempPassword); } catch { auto = null; }
    if (auto) console.log(`[harvest] auto-register OK provider=${provider.id} key_id=${k.lastInsertRowid}`);
    else console.log(`[harvest] auto-register unavailable provider=${provider.id} key_id=${k.lastInsertRowid} (fallback: no upstream key)`);
    const storeEmail = (auto && auto.tempEmail) ? auto.tempEmail : tempEmail;
    const storePass = (auto && auto.tempPassword) ? auto.tempPassword : tempPassword;
    db.prepare("INSERT INTO harvested_accounts (api_key_id,user_id,provider_id,tier_id,temp_email,temp_password,upstream_api_key,upstream_base_url) VALUES (?,?,?,?,?,?,?,?)")
      .run(k.lastInsertRowid, userId, providerId, provider.tier_id, storeEmail, storePass, auto ? auto.upstreamApiKey : null, auto ? auto.upstreamBaseUrl : null);
    const msg = `Panen Akun ${i} Berhasil.`;
    logHarvest(userId, providerId, msg);
    logs.push(msg);
    keys.push({ id: k.lastInsertRowid, providerBrand: provider.brand_name, tierSlug: tier ? tier.slug : null, key: userId ? keyValue : undefined, keyPrefix, credit, models, modelSource: source, modelCount: provider.model_count, live: auto ? !!auto.live : false });
  }
  return { count, logs, keys, proxyTotal: _proxyCache.list.length };
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
    id: t.id, slug: t.slug, name: t.name, audienceLabel: t.audience_label, badge: t.badge, maxModels: t.max_models,
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
  const raw = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 16) return res.status(400).json({ ok: false, error: "Kode vocher harus 16 karakter." });
  const v = db.prepare("SELECT * FROM vouchers WHERE REPLACE(code,'-','')=?").get(raw);
  if (!v) return res.status(404).json({ ok: false, error: "Kode vocher tidak ditemukan." });
  if (v.used) return res.status(400).json({ ok: false, error: "Kode vocher sudah dipakai." });
  const expires = new Date(Date.now() + (v.duration_days || 0) * 86400000).toISOString();
  db.prepare("UPDATE vouchers SET used=1, used_by=?, used_at=datetime('now') WHERE id=?").run(req.user.id, v.id);
  db.prepare("UPDATE users SET tier_slug=?, tier_expires_at=? WHERE id=?").run(v.tier_slug, expires, req.user.id);
  res.json({ ok: true, tierSlug: v.tier_slug, expiresAt: expires, message: `Vocher berhasil! Paket kamu jadi ${v.tier_slug === "premium" ? "Premium" : v.tier_slug === "pro" ? "Pro" : "Plus"} sampai ${new Date(expires).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}.` });
});
// Admin: buat / list / hapus vocher.
app.post("/api/admin/vouchers", requireAdmin, (req, res) => {
  const slug = String(req.body.tierSlug || "").toLowerCase();
  if (!["plus", "pro", "premium"].includes(slug)) return res.status(400).json({ ok: false, error: "invalid_tier" });
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
  res.json({ ok: true, users: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, avatar: u.avatar, isAdmin: !!u.is_admin, keyCount: u.key_count, createdAt: u.created_at, tierSlug: effectiveTierSlug(u) })) });
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
  db.prepare("DELETE FROM api_keys WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvested_accounts WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvest_logs WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/keys", requireAdmin, (req, res) => {
  const q = req.query.userId ? "WHERE k.user_id=?" : "";
  const args = req.query.userId ? [req.query.userId] : [];
  const rows = db.prepare(`SELECT k.*, u.email AS owner_email, u.name AS owner_name, p.brand_name AS brand, t.slug AS tier_slug FROM api_keys k LEFT JOIN users u ON u.id=k.user_id LEFT JOIN providers p ON p.id=k.provider_id LEFT JOIN tiers t ON t.id=k.tier_id ${q} ORDER BY k.created_at DESC LIMIT 500`).all(...args);
  res.json({ ok: true, keys: rows.map((k) => ({ id: k.id, keyPrefix: k.key_prefix, ownerEmail: k.owner_email, ownerName: k.owner_name, providerBrand: k.brand, tierSlug: k.tier_slug, credit: k.credit, models: JSON.parse(k.models_json || "[]"), modelSource: k.model_source, modelCount: k.model_count, createdAt: k.created_at })) });
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
  db.prepare("DELETE FROM api_keys WHERE provider_id=?").run(req.params.id);
  db.prepare("DELETE FROM harvested_accounts WHERE provider_id=?").run(req.params.id);
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
app.get("/api/admin/harvest-logs", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT hl.*, p.brand_name AS brand, u.email AS user_email FROM harvest_logs hl LEFT JOIN providers p ON p.id=hl.provider_id LEFT JOIN users u ON u.id=hl.user_id ORDER BY hl.created_at DESC LIMIT 200").all();
  res.json({ ok: true, logs: rows });
});


// ---------- OpenAI-compatible gateway (Path 1: HestiaFlow key + Base URL) ----------
// NEVER exposes upstream identity/credentials. Forwarding is server-side only.
function gatewayAuth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return db.prepare("SELECT * FROM api_keys WHERE key_value=? AND status='active'").get(m[1].trim()) || null;
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
  const models = gatewayKeyModels(key);
  const now = Math.floor(Date.now() / 1000);
  res.json({ object: "list", data: models.map((id) => ({ id, object: "model", created: now, owned_by: "hestiaflow" })) });
});
app.post("/v1/chat/completions", async (req, res) => {
  const key = gatewayAuth(req);
  if (!key) return res.status(401).json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
  const { model, messages, stream } = req.body || {};
  if (!model || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: { message: "model and messages are required.", type: "invalid_request_error", param: null, code: "invalid_request" } });
  // Streaming (SSE passthrough) — automatic, no admin setting needed.
  const allowed = gatewayKeyModels(key);
  if (allowed.length && !allowed.includes(model)) return res.status(404).json({ error: { message: `Model '${model}' is not included in this API key.`, type: "invalid_request_error", param: "model", code: "model_not_found" } });
  // Upstream resolution (server-side only, never exposed):
  // 1) This HestiaFlow key's own harvested account (auto-registered upstream key).
  // 2) Provider-level upstream (operator-configured).
  // 3) Active worker key for this provider (provider URL + worker key).
  const provider = key.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(key.provider_id) : null;
  let upstreamUrl = null, upstreamKey = null;
  const ha = db.prepare("SELECT upstream_api_key, upstream_base_url FROM harvested_accounts WHERE api_key_id=? AND upstream_api_key IS NOT NULL ORDER BY id DESC LIMIT 1").get(key.id);
  if (ha) { upstreamKey = ha.upstream_api_key; upstreamUrl = ha.upstream_base_url || (provider ? provider.upstream_url : null); }
  if ((!upstreamUrl || !upstreamKey) && provider) { upstreamUrl = upstreamUrl || provider.upstream_url; upstreamKey = upstreamKey || provider.upstream_api_key; }
  if (upstreamUrl && !upstreamKey && provider) {
    const w = db.prepare("SELECT * FROM workers WHERE provider_id=? AND status='active' AND upstream_api_key IS NOT NULL ORDER BY id LIMIT 1").get(provider.id);
    if (w) upstreamKey = w.upstream_api_key;
  }
  if (!upstreamUrl || !upstreamKey) return res.status(502).json({ error: { message: "Upstream provider not configured. Operator must configure the provider upstream (Base URL + API key) in Panel Admin.", type: "upstream_error", param: null, code: "upstream_not_configured" } });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 120000);
    const r = await fetch(stripV1(upstreamUrl) + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamKey}`, "User-Agent": "HestiaFlow/1.0" },
      body: JSON.stringify(req.body),
      signal: ctl.signal,
    });
    if (stream && r.body) {
      // SSE passthrough: stream provider chunks straight to the client.
      res.writeHead(r.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally { clearTimeout(t); }
      return res.end();
    }
    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("[gateway] chat forward failed:", e && e.message);
    if (!res.headersSent) return res.status(502).json({ error: { message: "Upstream request failed.", type: "upstream_error", param: null, code: "upstream_request_failed" } });
    return res.end();
  }
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`[hestiaflow] listening on port ${PORT}`));
