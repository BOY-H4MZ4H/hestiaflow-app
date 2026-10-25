/* HestiaFlow frontend. User-facing: ONLY brand names + HestiaFlow Base URL + HestiaFlow key + Credit. */
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let ME = null, TIERS = [], SETTINGS = { gatewayName: "HestiaFlow", baseUrl: "https://hestiaflow.xioo.me/v1" }, POOL = { workers: 0, ready: false };
let adminTab = "user"; // 'user' | 'admin'
let adminSection = "pengguna";
let keyFilterUser = null;
let adminCache = { users: [], keys: [], providers: [], workers: [], tiers: [], stats: {}, settings: {}, vouchers: [] };

async function api(p, opts) {
  const r = await fetch(p, { headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function copyText(t, btn) {
  navigator.clipboard.writeText(t).then(() => { if (btn) { const o = btn.textContent; btn.textContent = "Tersalin!"; setTimeout(() => btn.textContent = o, 1200); } });
}
function scrollToId(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

async function load() {
  try { const me = await api("/api/me"); ME = me.user; } catch {}
  try { const pub = await api("/api/public/tiers"); TIERS = pub.tiers || []; } catch {}
  try { const st = await api("/api/public/settings"); SETTINGS = st; } catch {}
  try { const pool = await api("/api/public/pool"); POOL = pool; } catch {}
  const fb = $("#footBase"); if (fb) fb.textContent = SETTINGS.baseUrl || "https://hestiaflow.xioo.me/v1";
  renderAuth();
  render();
  loadBansos();
  document.body.classList.add("loaded");
}
function renderAuth() {
  const a = $("#authArea");
  if (!ME) {
    a.innerHTML = `<button class="btn btn-plum" onclick="location.href='/auth/google'">Masuk</button>`;
  } else {
    a.innerHTML = `${ME.is_admin ? `<button class="btn btn-ghost btn-sm" onclick="switchTab('admin')">Panel Admin</button> <button class="btn btn-ghost btn-sm" onclick="switchTab('user')">Halaman Pengguna</button>` : ""}
      <button class="btn btn-ghost btn-sm" onclick="logout()">Keluar</button>`;
  }
}
async function logout() { await api("/api/logout", { method: "POST" }); location.reload(); }
function switchTab(t) { adminTab = t; if (t === "admin") loadAdmin(); render(); }
function switchSection(s) { adminSection = s; renderAdminSections(); }

const TIER_PRICE = { plus: { amount: "Rp 5.000", dur: "3 Hari" }, pro: { amount: "Rp 8.000", dur: "1 Minggu" }, premium: { amount: "Rp 15.000", dur: "2 Minggu" } };
function tierShowcase() {
  return `<div class="section"><h2>Pilihan Paket Tier</h2>
  <div class="grid tiers">${TIERS.map((t) => {
    const isLockedCard = t.locked === true; // Kunci total Pro (perintah Hestia 2026-10-25): kartu terkunci dari flag locked /api/public/tiers. 
    const cardClick = "";
    return `
    <div class="card tier ${t.slug === "premium" ? "premium" : ""}${isLockedCard ? " locked-card" : ""}" ${isLockedCard ? `onclick="${cardClick}" style="cursor:pointer;position:relative;"` : ""}>
      ${isLockedCard ? `<div class="card-lock-overlay" style="width:auto;height:auto;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:800;white-space:nowrap">🔒 Segera Hadir</div>` : ""}
      <div class="tier-head"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge)}</span>${TIER_PRICE[t.slug] ? `<div class="tier-price"><div class="price">${TIER_PRICE[t.slug].amount}</div><div class="price-dur">${TIER_PRICE[t.slug].dur}</div></div>` : ""}</div>
      ${(t.providers || []).map((p) => `
        <div class="brand"><div class="medal ${t.slug === "premium" ? "gold" : ""}">${esc(p.brand.slice(0, 1))}</div>
        <div><h3>${esc(p.brand)}</h3><p>${esc(p.tagline || "")}</p></div></div>
        <div><span class="chip">${p.modelCount} model</span><span class="chip">${esc(p.creditNote || "")}</span></div>
        <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();showTierModels(${p.id})">🔍 Lihat Model</button></div>
      `).join("") || `<p class="muted">Belum ada provider di tier ini.</p>`}
    </div>`; }).join("")}</div></div>`;
}

function render() {
  const app = $("#app");
  let hero = `<div class="hero"><div class="goldline"></div><h1>Satu akun Google, semua API terbuka.</h1>
    <p>Daftar dengan Google, dapatkan API key HestiaFlow + Base URL HestiaFlow + Credit. Tanpa kartu, tanpa sandi.</p>
    ${!ME ? `<button class="btn btn-gold" onclick="location.href='/auth/google'">Ayo coba Sekarang</button>` : `<span class="badge premium">Masuk sebagai ${esc(ME.name || ME.email)}</span>`}
    </div>`;
  if (!ME) {
    const urlParams = new URLSearchParams(location.search);
    const oauthNote = urlParams.get("oauth") === "missing"
      ? `<div class="notice"><strong>Login Google belum dikonfigurasi.</strong> Operator perlu mengatur GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET untuk domain ini.</div>` : "";
    app.innerHTML = hero + oauthNote + tierShowcase() + bansosSection();
    return;
  }
  if (ME.is_admin && adminTab === "admin") {
    app.innerHTML = hero + `<div id="adminRoot"><p class="muted">Memuat Panel Admin…</p></div>`;
    loadAdmin();
    return;
  }
  app.innerHTML = hero + (ME.suspended ? `<div class="notice" style="margin-bottom:12px"><strong>Akun kamu sedang disuspend oleh admin.</strong> Semua API key kamu dinonaktifkan sementara dan kamu tidak bisa panen kunci baru. Hubungi admin untuk mengaktifkan lagi.</div>` : "") + `<div id="userRoot"><p class="muted">Memuat Halaman Pengguna…</p></div>` + tierShowcase() + bansosSection() + voucherSection();
  loadUser();
}

let BANSOS = { keys: [], limit: 2, locked: false, pool: null };
let bansosTimer = null;
function fmtID(n) { return Number(n || 0).toLocaleString("id-ID"); }
function bansosSection() {
  const bp = TIERS.flatMap((t) => t.providers || []).find((p) => /bansos/i.test(p.brand || ""));
  return `<div class="section" id="bansosSection"><div class="card tier bansos-card">
    <div class="tier-head"><span class="badge bansos">\uD83C\uDF81 BANSOS</span><div class="tier-price"><div class="price">GRATIS</div><div class="price-dur">Untuk Semua Pengguna</div></div></div>
    <div class="brand"><img class="bansos-logo" src="/logos/bansos.jpg" alt="Bansos" />
    <div><h3>Bansos Token 4.5 Juta</h3><p>Token AI gratis untuk semua pengguna, tanpa login. Buat API key kamu sendiri (maksimal 2 key) dan pakai di Base URL HestiaFlow. Kuota 4.5 juta token per hari dipakai bersama \u2014 habis hari ini, besok ngisi lagi.</p></div></div>
    <div><span class="chip">4 model pilihan</span><span class="chip">Tanpa login</span><span class="chip">Maks 2 API key</span></div>
    ${bp ? `<div style="margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="showTierModels(${bp.id})">🔍 Lihat Model</button></div>` : ""}
    <div id="bansosSoon" style="display:none;text-align:center;font-weight:800;font-size:22px;letter-spacing:2px;color:#d4af37;border:2px dashed #d4af37;border-radius:12px;padding:10px;margin:10px 0">SEGERA HADIR</div>
    <div class="bansos-pool">
      <div class="bansos-pool-top"><span>Sisa token bansos hari ini</span><span class="bansos-pool-num" id="bansosRemain">Memuat\u2026</span></div>
      <div class="bansos-bar"><div class="bansos-bar-fill" id="bansosBarFill"></div></div>
      <div class="bansos-pool-sub" id="bansosPoolSub">dari total 5.000.000 token per hari</div>
    </div>
    <div class="bansos-baseurl"><b>${esc(SETTINGS.baseUrl || "")}</b></div>
    <div id="bansosKeys"></div>
    <div class="bansos-actions"><button class="btn btn-gold" id="bansosCreateBtn" onclick="createBansosKey()">Buat API Key</button></div>
    <p class="muted" id="bansosMsg"></p>
  </div></div>`;
}
function renderBansos() {
  const rem = $("#bansosRemain"), fill = $("#bansosBarFill"), sub = $("#bansosPoolSub");
  if (BANSOS.pool && rem && fill && sub) {
    const total = BANSOS.pool.total || 5000000, sisa = BANSOS.pool.remaining || 0;
    const baru = fmtID(sisa);
    if (rem.textContent !== baru) { rem.textContent = baru; rem.classList.remove("tick"); void rem.offsetWidth; rem.classList.add("tick"); }
    fill.style.width = (total > 0 ? Math.max(0, Math.min(100, (sisa / total) * 100)) : 0) + "%";
    sub.textContent = "Terpakai " + fmtID(BANSOS.pool.used || 0) + " dari " + fmtID(total) + " token hari ini";
  }
  const box = $("#bansosKeys");
  if (box) {
    if (BANSOS.keys.length) {
      box.innerHTML = `<div class="keybox bansos-keys"><div class="lbl">API key kamu (${BANSOS.keys.length}/${BANSOS.limit})</div>` +
        BANSOS.keys.map((k) => `<span class="key-row"><span class="key-row-val">${esc(k.key)}</span> <button class="btn btn-ghost btn-sm" style="color:#d4af37;border-color:#d4af37" onclick="copyText('${esc(k.key)}', this)">Copy</button></span>`).join("") + "</div>";
    } else box.innerHTML = "";
  }
  const btn = $("#bansosCreateBtn");
  if (btn) {
    if (BANSOS.locked) { btn.disabled = true; btn.textContent = "\uD83D\uDD12 Sudah 2 API Key"; }
    else { btn.disabled = false; btn.textContent = "Buat API Key"; }
  }
  // Gembok Bansos (env BANSOS_ENABLED=0): tampilkan papan SEGERA HADIR, sembunyikan key & tombol.
  const soon = $("#bansosSoon");
  if (BANSOS.pool && BANSOS.pool.enabled === false) {
    if (soon) soon.style.display = "block";
    if (rem) rem.textContent = "Segera Hadir";
    if (fill) fill.style.width = "0%";
    if (sub) sub.textContent = "Bansos sedang digembok \u2014 segera hadir kembali.";
    if (box) box.innerHTML = "";
    if (btn) { btn.disabled = true; btn.textContent = "\uD83D\uDD12 Segera Hadir"; }
  } else if (soon) soon.style.display = "none";
}
async function loadBansos() {
  if (!$("#bansosSection")) return;
  try { const p = await api("/api/bansos/pool"); BANSOS.pool = p; } catch {}
  try { const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.limit = m.limit || 2; BANSOS.locked = !!m.locked; } catch {}
  renderBansos();
  if (!bansosTimer) bansosTimer = setInterval(refreshBansosPool, 30000);
}
async function refreshBansosPool() {
  if (!$("#bansosSection")) return;
  try { const p = await api("/api/bansos/pool"); BANSOS.pool = p; renderBansos(); } catch {}
}
async function createBansosKey() {
  const msg = $("#bansosMsg"), btn = $("#bansosCreateBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/bansos/keys", { method: "POST", body: "{}" });
    if (msg) msg.textContent = "API key berhasil dibuat. Salin dan pakai ya.";
    const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.limit = m.limit || 2; BANSOS.locked = !!m.locked;
    renderBansos();
  } catch (e) {
    if (msg) msg.textContent = e.message;
    try { const m = await api("/api/bansos/my-keys"); BANSOS.keys = m.keys || []; BANSOS.locked = !!m.locked; } catch {}
    renderBansos();
  }
}

function voucherSection() {
  return `<div class="section" style="text-align:center"><h2>Voucher</h2><p class="sub">Masukan Code Vocher Yang Di Beri Admin</p>
  <div style="display:flex;flex-direction:column;align-items:center;gap:10px"><input id="voucherCode" placeholder="Kode Vocher" style="text-align:center;max-width:320px;width:100%" /><button class="btn btn-plum" onclick="redeemVoucher()">Tukar</button></div>
  <p id="voucherMsg" class="muted"></p></div>`;
}
async function redeemVoucher() {
  const inp = $("#voucherCode"); const msg = $("#voucherMsg");
  const code = inp ? inp.value.trim() : "";
  if (!code) { if (msg) msg.textContent = "Masukan dulu kode vocher-nya."; return; }
  try { const r = await api("/api/voucher/redeem", { method: "POST", body: JSON.stringify({ code }) }); if (msg) msg.textContent = r.message || "Vocher berhasil ditukar."; setTimeout(() => location.reload(), 1500); }
  catch (e) { if (msg) msg.textContent = e.message; }
}
async function loadUser() {
  try {
    $("#userRoot").innerHTML = `
    <div class="section"><h2>Panen Akun</h2><p class="sub">Panen akun provider — tiap panen membuat 1 akun baru dengan email sementara yang berbeda-beda. Email & sandi tidak pernah ditampilkan. Limit: Gratis 100, Plus 500, Pro 1500, Prem 5000 akun.</p>
      <div class="card">
        <div style="text-align:center"><label>Provider</label><div class="tier-picker"><button class="btn btn-plum tier-picker-btn" id="tierPickerBtn" onclick="toggleTierPicker()">Tier: <span id="tierPickerLabel">Gratis • 2 Model</span> ▾</button><div id="harvestProviderSidebar" class="tier-sidebar tier-picker-pop" style="display:none"></div></div></div>
        <div style="margin-top:14px;text-align:center"><label id="harvestCountLabel">Jumlah akun (1–100)</label><div class="stepper">
          <button type="button" onclick="stepCount(-1)">−</button>
          <input id="harvestCount" type="number" min="1" max="100" value="1" oninput="clampUserCount(this)" />
          <button type="button" onclick="stepCount(1)">+</button></div></div>
      </div>
      <div style="margin-top:14px;text-align:center"><button class="btn btn-plum" id="harvestBtn" onclick="doUserHarvest()">Panen Akun</button></div>
      <div class="progress" style="margin-top:14px"><div id="harvestProg"></div></div>
      <p class="kv" id="harvestProgText"></p>
      <div class="termbox" id="harvestProc" style="display:none"></div>
      <p class="kv" id="harvestSummary" style="display:flex;justify-content:space-between;align-items:center;gap:8px"></p>
</div></div>
    <div class="section"><h2>Model</h2>
      <div class="termbox" id="modelBox" style="max-height:160px;overflow-y:auto"><div class="term-line">Memuat model…</div></div>
    </div>
`;
  renderHarvestSidebar();
  updateModelBox();
  } catch (e) { $("#userRoot").innerHTML = `<p class="muted">Gagal memuat: ${esc(e.message)}</p>`; }
}
function keyBoxAll(keys) {
  return `<div class="keybox" style="margin-bottom:12px"><div class="lbl">API key HestiaFlow</div><div class="key-list-scroll">${keys.map((k) => `<div class="key-row"><span class="key-row-tag">${esc(k.tierSlug || "")} · ${esc(k.providerBrand || "")} · Credit: ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</span><span class="key-row-val">${esc(k.key)}</span><div style="display:flex;gap:6px;margin-top:4px"><button class="btn btn-ghost btn-sm" onclick="copyText('${esc(k.key)}',this)">Salin Key</button><button class="btn btn-ghost btn-sm" style="color:#b91c1c" onclick="deleteMyKey(${k.id},this)">Hapus</button></div></div>`).join("")}</div></div>`;
}

let lastHarvestKeys = [];
function copyAllHarvestKeys(btn) {
  const liveKeys = (lastHarvestKeys || []).filter((k) => k.live).map((k) => k.key).filter(Boolean);
  if (!liveKeys.length) { const t = btn.textContent; btn.textContent = "Tidak ada"; setTimeout(() => { btn.textContent = t; }, 2000); return; }
  copyText(liveKeys.join("\n"), btn);
}
async function deleteAllHarvestKeys(btn) {
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Hapus"; }, 3000);
    return;
  }
  btn.disabled = true; btn.textContent = "Menghapus…";
  for (const k of (lastHarvestKeys || [])) { try { if (k.id) await api("/api/my-keys/" + k.id, { method: "DELETE" }); } catch {} }
  lastHarvestKeys = [];
  const proc = $("#harvestProc"); if (proc) proc.innerHTML = `<div class="term-line">Semua API key dari panen ini sudah dihapus.</div>`;
  const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>0</b>·Mati : <b>0</b></span>`;
  btn.disabled = false; btn.textContent = "Hapus"; btn.dataset.armed = "";
}
async function deleteMyKey(id, btn) {
  // 2-step in-page confirm (no native dialog, so it works everywhere).
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
    setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = "Hapus"; } }, 3000);
    return;
  }
  btn.disabled = true; btn.textContent = "Menghapus...";
  try { await api(`/api/my-keys/${id}`, { method: "DELETE" }); loadUser(); }
  catch (e) { alert("Gagal hapus: " + e.message); btn.disabled = false; btn.textContent = "Hapus"; btn.dataset.armed = ""; }
}
function clampCount(el) { let v = parseInt(el.value, 10); if (isNaN(v)) v = 1; el.value = Math.max(1, Math.min(50, v)); }
const TIER_HARVEST_LIMIT = { gratis: 100, plus: 500, pro: 1500, premium: 5000 };
function userHarvestLimit() { const pid = Number(selectedHarvestProviderId); const item = TIERS.flatMap((t) => (t.providers || []).map((p) => ({ tier: t, p }))).find((x) => x.p.id === pid); return item ? (TIER_HARVEST_LIMIT[item.tier.slug] || 50) : 50; }
function updateHarvestLimitUI() { const lim = userHarvestLimit(); const lbl = $("#harvestCountLabel"); if (lbl) lbl.textContent = `Jumlah akun (1–${lim})`; const el = $("#harvestCount"); if (el) { el.max = lim; el.value = Math.max(1, Math.min(lim, parseInt(el.value, 10) || 1)); } }
function clampUserCount(el) { let v = parseInt(el.value, 10); if (isNaN(v)) v = 1; el.value = Math.max(1, Math.min(userHarvestLimit(), v)); }
function stepCount(d) { const el = $("#harvestCount"); if (!el) return; el.value = Math.max(1, Math.min(userHarvestLimit(), (parseInt(el.value, 10) || 1) + d)); }
let selectedHarvestProviderId = null;
const TIER_RANK = { gratis: 0, plus: 1, pro: 2, premium: 3 };
function showTierLocked() {
  let m = $("#tierLockModal");
  if (!m) {
    m = document.createElement("div"); m.id = "tierLockModal"; m.className = "tier-lock-modal";
    m.innerHTML = `<div class="tier-lock-box"><p>Kamu tidak Bisa Memilih Menu ini Segera Upgrade Paket kamu</p><button class="btn btn-plum" onclick="closeTierLocked()">OK</button></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeTierLocked(); });
    document.body.appendChild(m);
  }
  m.style.display = "flex";
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
}
function showComingSoon() {
  let m = $("#tierLockModal");
  if (!m) {
    m = document.createElement("div"); m.id = "tierLockModal"; m.className = "tier-lock-modal";
    m.innerHTML = `<div class="tier-lock-box"><p>Segera Hadir!</p><button class="btn btn-plum" onclick="closeTierLocked()">OK</button></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeTierLocked(); });
    document.body.appendChild(m);
  } else {
    m.querySelector("p").textContent = "Segera Hadir!";
  }
  m.style.display = "flex";
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
}

function closeTierLocked() { const m = $("#tierLockModal"); if (m) m.style.display = "none"; }
async function showTierModels(pid) {
  let m = $("#modelListModal");
  if (!m) {
    m = document.createElement("div"); m.id = "modelListModal"; m.className = "tier-lock-modal";
    m.innerHTML = `<div class="model-list-box"><div class="model-list-head"><h3 id="mlTitle">Model</h3><button class="btn btn-ghost btn-sm" onclick="closeTierModels()">✕ Tutup</button></div><p class="muted" id="mlSub"></p><div class="model-list-body" id="mlBody"><p class="muted">Memuat…</p></div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) closeTierModels(); });
    document.body.appendChild(m);
  }
  const item = TIERS.flatMap((t) => (t.providers || []).map((p) => ({ tier: t, p }))).find((x) => x.p.id === pid);
  const notes = (item && item.p.modelNotes) || {};
  $("#mlTitle").textContent = item ? `${item.p.brand} · Tier ${item.tier.name}` : "Daftar Model";
  $("#mlSub").textContent = "Memuat daftar model…";
  $("#mlBody").innerHTML = `<p class="muted">Memuat…</p>`;
  m.style.display = "flex";
  try {
    const r = await api("/api/public/providers/" + pid + "/models");
    const models = r.models || [];
    $("#mlSub").textContent = `${r.modelCount != null ? r.modelCount : models.length} model tersedia di tier ini`;
    const FAMLABEL = { "openai": "OpenAI · GPT", "anthropic": "Anthropic · Claude", "google": "Google · Gemini & Gemma", "deepseek": "DeepSeek", "x-ai": "xAI · Grok", "z-ai": "Zhipu · GLM", "qwen": "Qwen", "moonshotai": "Moonshot · Kimi", "meta-llama": "Meta · Llama", "mistralai": "Mistral", "minimax": "MiniMax" };
    const FAMORDER = Object.keys(FAMLABEL);
    const famNama = (id) => {
      const s0 = id.startsWith("cf.") ? id.slice(3) : id;
      if (s0.startsWith("gpt-") || s0.startsWith("gpt-oss")) return "openai";
      if (s0.startsWith("claude-")) return "anthropic";
      if (s0.startsWith("gemini-") || s0.startsWith("gemma-")) return "google";
      if (s0.startsWith("deepseek-")) return "deepseek";
      if (s0.startsWith("grok-")) return "x-ai";
      if (s0.startsWith("glm-")) return "z-ai";
      if (s0.startsWith("qwen") || s0.startsWith("qwq")) return "qwen";
      if (s0.startsWith("kimi-")) return "moonshotai";
      if (s0.startsWith("llama-")) return "meta-llama";
      if (s0.startsWith("mistral-")) return "mistralai";
      if (s0.startsWith("minimax-")) return "minimax";
      return "lainnya";
    };
    const grup = new Map();
    for (const mm of models) {
      const v = mm.includes("/") ? mm.split("/")[0] : famNama(mm);
      if (!grup.has(v)) grup.set(v, []);
      grup.get(v).push(mm);
    }
    const urut = [...grup.keys()].sort((a, b) => {
      const ia = FAMORDER.indexOf(a), ib = FAMORDER.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
    const perluGrup = urut.length > 1;
    $("#mlBody").innerHTML = models.length ? urut.map((v) => {
      const label = FAMLABEL[v] || (v === "lainnya" ? "Lainnya" : v);
      const head = perluGrup ? `<div class="model-group-head">${esc(label)} · ${grup.get(v).length}</div>` : "";
      const rows = [...grup.get(v)].sort().map((mm) => `<div class="model-row"><div class="model-name">${esc(mm)}</div>${notes[mm] ? `<div class="model-note">${esc(notes[mm])}</div>` : ""}</div>`).join("");
      return head + rows;
    }).join("") : `<p class="muted">Model belum terdeteksi otomatis.</p>`;
  } catch { $("#mlSub").textContent = ""; $("#mlBody").innerHTML = `<p class="muted">Gagal memuat model.</p>`; }
}
function closeTierModels() { const m = $("#modelListModal"); if (m) m.style.display = "none"; }
function renderHarvestSidebar() {
  const el = $("#harvestProviderSidebar"); if (!el) return;
  const short = { gratis: "Gratis", plus: "Plus", pro: "Pro", premium: "Prem" };
  const items = [];
  TIERS.forEach((t) => (t.providers || []).forEach((p) => items.push({ tier: t, p })));
  if (!items.length) { el.innerHTML = `<p class="muted">Belum ada provider.</p>`; return; }
  const myRank = TIER_RANK[(ME && ME.tier_slug) || "gratis"] ?? 0;
  const selItem = items.find((x) => x.p.id === selectedHarvestProviderId);
  if (!selectedHarvestProviderId || !selItem || selItem.tier.locked === true || (TIER_RANK[selItem.tier.slug] ?? 0) > myRank) selectedHarvestProviderId = (items.find((x) => x.tier.locked !== true && (TIER_RANK[x.tier.slug] ?? 0) <= myRank) || items[0]).p.id; // Kunci total Pro (perintah Hestia 2026-10-25): tier locked tidak boleh terpilih otomatis untuk panen.
  el.innerHTML = items.map((x) => { const locked = x.tier.locked === true || (TIER_RANK[x.tier.slug] ?? 0) > myRank; /* Kunci total Pro (perintah Hestia 2026-10-25): tier locked dari /api/public/tiers ikut terkunci di picker panen. */ const isLocked = locked; const clickFn = isLocked ? `` : `selectHarvestProvider(${x.p.id})`; /* Opsi terkunci tidak bisa diklik (kunci total Pro). */ return `<div class="tier-side-opt${x.p.id === selectedHarvestProviderId ? " sel" : ""}${isLocked ? " locked" : ""}" data-pid="${x.p.id}" onclick="${clickFn}">${isLocked ? "🔒 " : ""}${esc(short[x.tier.slug] || x.tier.name)} • ${x.p.modelCount} Model</div>`; }).join("");
  const cur = items.find((x) => x.p.id === selectedHarvestProviderId);
  const lbl = $("#tierPickerLabel"); if (lbl && cur) lbl.textContent = `${short[cur.tier.slug] || cur.tier.name} • ${cur.p.modelCount} Model`;
  updateHarvestLimitUI();
}
function toggleTierPicker() {
  const pop = $("#harvestProviderSidebar"); if (!pop) return;
  pop.style.display = pop.style.display === "none" ? "block" : "none";
}
function selectHarvestProvider(pid) {
  selectedHarvestProviderId = pid;
  document.querySelectorAll(".tier-side-opt").forEach((d) => d.classList.toggle("sel", Number(d.dataset.pid) === pid));
  const pop = $("#harvestProviderSidebar"); if (pop) pop.style.display = "none";
  const short = { gratis: "Gratis", plus: "Plus", pro: "Pro", premium: "Prem" };
  const cur = (TIERS.flatMap((t) => (t.providers || []).map((p) => ({ tier: t, p })))).find((x) => x.p.id === pid);
  const lbl = $("#tierPickerLabel"); if (lbl && cur) lbl.textContent = `${short[cur.tier.slug] || cur.tier.name} • ${cur.p.modelCount} Model`;
  updateHarvestLimitUI();
  updateModelBox();
}
document.addEventListener("click", (e) => {
  const pop = $("#harvestProviderSidebar"); if (!pop || pop.style.display === "none") return;
  if (!e.target.closest(".tier-picker")) pop.style.display = "none";
});
async function updateModelBox() {
  const box = $("#modelBox"); if (!box) return;
  const pid = selectedHarvestProviderId;
  if (!pid) return;
  try {
    const r = await api("/api/public/providers/" + pid + "/models");
    const models = r.models || [];
    box.innerHTML = `<div class="term-line">Jumlah model: ${r.modelCount != null ? r.modelCount : models.length}</div><div style="height:2px;background:linear-gradient(90deg,#c9a227,#d4af37);margin:6px 0;border-radius:2px;"></div>` + (models.length ? models.map((m) => `<div class="term-line">${esc(m)}</div>`).join("") : `<div class="term-line">Model belum terdeteksi otomatis.</div>`);
  } catch { box.innerHTML = `<div class="term-line">Gagal memuat model.</div>`; }
}
async function doUserHarvest() {
  const btn = $("#harvestBtn"); btn.disabled = true;
  const providerId = Number(selectedHarvestProviderId), count = Math.max(1, Math.min(userHarvestLimit(), parseInt($("#harvestCount").value, 10) || 1));
  const proc = $("#harvestProc"); proc.style.display = "block";
  proc.innerHTML = `<div class="term-line"><span class="cute-spin"></span> Lagi Proses...</div><div class="term-line">Scrap Proxy...</div>`;
  $("#harvestProg").style.width = "0%"; $("#harvestProgText").textContent = "";
  try {
    const out = await api("/api/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    $("#harvestProg").style.width = "100%"; const liveAccts = (out.keys || []).reduce((s, k) => s + (k.liveAccounts || 0), 0); $("#harvestProgText").textContent = `${liveAccts} dari ${count} akun hidup`;
    let html = `<div class="term-line">Total Proxy OK: ${out.proxyTotal != null ? out.proxyTotal : 0}</div>`;
    (out.keys || []).forEach((k, i) => {
      const st = k.live ? `<span class="term-live">Live</span>` : `<span class="term-dead">Mati</span>`;
      // Gratis: credit dalam cents, tampilkan sebagai $X.XX (perintah Hestia 2026-10-19).
      const creditTxt = k.credit != null ? (k.tierSlug === "gratis" ? "$" + (k.credit/100).toFixed(2) : esc(k.credit)) : "Tidak dinyatakan";
      if (k.live) html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Api key : <span class="term-keyval">${esc(k.key || "")}</span></div><div>Token/Credit : ${creditTxt}</div></div>`;
      else html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Tidak dapat Di pakai</div></div>`;
    });
    proc.innerHTML = html;
    const liveN = (out.keys || []).filter((k) => k.live).length;
    const deadN = (out.keys || []).length - liveN;
    lastHarvestKeys = out.keys || [];
    const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>${liveN}</b>·Mati : <b>${deadN}</b></span> <span style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="copyAllHarvestKeys(this)">Salin</button> <button class="btn btn-danger btn-sm" onclick="deleteAllHarvestKeys(this)">Hapus</button></span>`;
    btn.disabled = false;
  } catch (e) {
    proc.innerHTML = `<div class="term-line term-err">Gagal: ${esc(e.message)}</div>`;
    btn.disabled = false;
  }
}

// ---------- admin ----------
async function loadAdmin() {
  try {
    const [stats, users, keys, providers, workers, tiers, settings, logs, vouchers] = await Promise.all([
      api("/api/admin/stats"), api("/api/admin/users"), api("/api/admin/keys"),
      api("/api/admin/providers"), api("/api/admin/workers"), api("/api/admin/tiers"),
      api("/api/admin/settings"), api("/api/admin/harvest-logs"), api("/api/admin/vouchers"),
    ]);
    adminCache = { stats: stats.stats, users: users.users, keys: keys.keys, providers: providers.providers, workers: workers.workers, tiers: tiers.tiers, settings: settings.settings, logs: logs.logs, vouchers: vouchers.vouchers };
    renderAdmin();
  } catch (e) { const r = $("#adminRoot"); if (r) r.innerHTML = `<p class="muted">Gagal memuat admin: ${esc(e.message)}</p>`; }
}
function renderAdmin() {
  const root = $("#adminRoot"); if (!root) return;
  const s = adminCache.stats || {};
  root.innerHTML = `
  <div class="section"><h2>Panel Admin</h2>
    <p class="sub">Statistik: ${s.users || 0} pengguna · ${s.keys || 0} kunci · ${s.providers || 0} provider · ${s.workers || 0} worker aktif · ${s.tiers || 0} tier</p>
    <nav class="admin-nav">
      <button class="${adminSection === "pengguna" ? "active" : ""}" onclick="switchSection('pengguna')">Pengguna</button>
      <button class="${adminSection === "kunci" ? "active" : ""}" onclick="switchSection('kunci')">Kunci</button>
      <button class="${adminSection === "provider" ? "active" : ""}" onclick="switchSection('provider')">Provider</button>
      <button class="${adminSection === "worker" ? "active" : ""}" onclick="switchSection('worker')">Pool Worker</button>
      <button class="${adminSection === "pengaturan" ? "active" : ""}" onclick="switchSection('pengaturan')">Pengaturan</button>
      <button class="${adminSection === "voucher" ? "active" : ""}" onclick="switchSection('voucher')">Voucher</button>
    </nav>
    <div id="adminSections"></div></div>`;
  renderAdminSections();
}
function renderAdminSections() {
  const el = $("#adminSections"); if (!el) return;
  $$(".admin-nav button").forEach((b, i) => { const names = ["pengguna", "kunci", "provider", "worker", "pengaturan", "voucher"]; b.classList.toggle("active", adminSection === names[i]); });
  let html = "";
  if (adminSection === "pengguna") {
    html = `<div id="sec-pengguna"><h3>01 · Pengguna</h3><p class="muted">Ketuk kartu pengguna untuk melihat kunci miliknya.</p>
      <div class="grid">${adminCache.users.length ? adminCache.users.map((u) => `
      <div class="card usercard" role="button" tabindex="0" onclick="viewUserKeys(${u.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();viewUserKeys(${u.id})}">
        <div style="display:flex;gap:10px;align-items:center">${u.avatar ? `<img src="${esc(u.avatar)}" style="width:40px;height:40px;border-radius:50%" />` : `<div style="width:40px;height:40px;border-radius:50%;background:var(--plum);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${esc((u.name || u.email || "?").slice(0, 1).toUpperCase())}</div>`}
        <div><b>${esc(u.name || "(tanpa nama)")}</b><br /><span class="muted">${esc(u.email)}</span><br /><span class="chip">${u.keyCount} kunci</span>${u.isAdmin ? `<span class="chip">Admin</span>` : ""}${u.suspended ? `<span class="chip" style="background:#7f1d1d;color:#fff">DISUSPEND</span>` : ""}<br /><span class="muted" style="font-size:12px">${u.lastIp ? `IP: ${esc(u.lastIp)}${u.device ? " · " + esc(u.device) : ""}${u.lastLoginAt ? " · login terakhir " + esc(String(u.lastLoginAt).slice(0, 16)) + " UTC" : ""}` : "IP/perangkat belum tercatat — ketahuan pas dia login lagi"}</span></div></div>
        <div style="margin-top:8px" onclick="event.stopPropagation()"><label style="font-size:12px">Paket: </label><select onchange="setUserTier(${u.id}, this.value)" onclick="event.stopPropagation()"><option value="gratis" ${u.tierSlug === "gratis" ? "selected" : ""}>Gratis</option><option value="plus" ${u.tierSlug === "plus" ? "selected" : ""}>Plus</option><option value="pro" ${u.tierSlug === "pro" ? "selected" : ""}>Pro</option><option value="premium" ${u.tierSlug === "premium" ? "selected" : ""}>Premium</option></select></div>
        <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewUserKeys(${u.id})">Lihat Kunci</button>
        ${u.isAdmin ? "" : `<button class="btn btn-ghost btn-sm" style="color:#b45309;border-color:#b45309" onclick="event.stopPropagation();askSuspendUser(${u.id},this,${u.suspended ? 1 : 0})">${u.suspended ? "Aktifkan" : "Suspend"}</button>`}
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();askDeleteUser(${u.id},this)">Hapus Akun</button></div>
        <div class="hint">Ketuk kartu untuk melihat kunci</div></div>`).join("") : `<p class="muted">Belum ada pengguna terdaftar.</p>`}</div></div>`;
  }
  if (adminSection === "kunci") {
    const keys = keyFilterUser ? adminCache.keys.filter((k) => String(k.ownerEmail) === String(keyFilterUser)) : adminCache.keys;
    html = `<div id="admin-keys"><h3>Semua API key</h3>
      ${keyFilterUser ? `<div class="banner-filter">Filter: kunci milik <b>${esc(keyFilterUser)}</b> <button class="btn btn-ghost btn-sm" onclick="clearKeyFilter()">Tampilkan semua</button></div>` : ""}
      <div class="grid">${keys.map((k) => `<div class="card"><span class="chip">${esc(k.providerBrand || "")}</span><span class="chip">${esc(k.tierSlug || "")}</span>
        <p class="kv">Pemilik: <b>${esc(k.ownerEmail || "(pool)")}</b> · Prefix: ${esc(k.keyPrefix)} · Credit: ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</p>
        <div>${(k.models || []).slice(0, 8).map((m) => `<span class="chip model">${esc(m)}</span>`).join("")}${(k.models || []).length > 8 ? `<span class="chip">+${k.models.length - 8} lagi</span>` : ""}</div>
        <div style="margin-top:8px"><button class="btn btn-danger btn-sm" onclick="askDeleteKeyAdmin(${k.id},this)">Hapus Key</button></div></div>`).join("") || `<p class="muted">Belum ada kunci.</p>`}</div></div>`;
  }
  if (adminSection === "provider") {
    html = `<div id="sec-provider"><h3>Provider & Tier</h3>
      <div class="card"><h4>Kelola Tier</h4><div class="grid">${adminCache.tiers.map((t) => `
        <div class="card"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge || t.name)}</span>
        <p class="kv">Slug: ${esc(t.slug)} · ${t.providerCount} provider${t.max_models != null ? ` · Maks ${t.max_models} model` : ""}</p></div>`).join("")}</div>
        <div class="row"><div><label>Nama tier baru</label><input id="newTierName" placeholder="mis. Ultra" /></div>
        <div><label>Label audiens</label><input id="newTierAud" placeholder="UNTUK PENGGUNA ULTRA" /></div>
        <div><label>Maks model (kosong = tanpa batas)</label><input id="newTierMax" type="number" min="1" placeholder="" /></div></div>
        <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="addTier()">Tambah Tier</button></div>
      ${(adminCache.tiers || []).map((t) => {
        const provs = adminCache.providers.filter((p) => p.tierId === t.id);
        return `<div class="card" style="margin-top:14px"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : t.slug === "pro" ? "pro" : "premium"}">${esc(t.badge || t.name)}</span>
        <h4>Tier ${esc(t.name)}</h4>
        ${provs.map((p) => `<div style="border-top:1px solid var(--line);padding:10px 0">
          <b>${esc(p.brand)}</b> · ${p.modelCount} model · ${esc(p.creditNote || "")}
          <button class="btn btn-ghost btn-sm" onclick="setProviderKey(${p.id})" style="margin-left:8px">Set API Key</button>
          <div>${(p.models || []).slice(0, 6).map((m) => `<span class="chip model">${esc(m)}</span>`).join("")}${(p.models || []).length > 6 ? `<span class="chip">+${p.models.length - 6} lagi</span>` : ""}</div>
          <div class="card" style="margin-top:10px"><b>PANEN AKUN — ${esc(p.brand)}</b>
          <p class="kv">Panen akun: tiap panen membuat 1 akun baru dengan email sementara yang berbeda-beda. Email & sandi tidak pernah ditampilkan.</p>
          <div class="row"><div><label>Jumlah akun (1–50)</label><div class="stepper">
            <button type="button" onclick="stepAdminCount(${p.id},-1)">−</button>
            <input id="acount-${p.id}" type="number" min="1" max="50" value="1" oninput="clampCount(this)" />
            <button type="button" onclick="stepAdminCount(${p.id},1)">+</button></div></div></div>
          <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="doAdminHarvest(${p.id})">Panen Akun</button>
          <div class="logbox" id="alog-${p.id}" style="margin-top:10px">Belum ada log panen.</div></div></div>`).join("") || `<p class="muted">Belum ada provider di tier ini.</p>`}
        </div>`; }).join("")}
      </div>`;
  }
  if (adminSection === "worker") {
    html = `<div id="sec-worker"><h3>Pool Worker</h3><p class="muted">Worker ditambahkan operator. Pool dimulai kosong.</p>
      <div class="grid">${adminCache.workers.map((w) => `<div class="card"><b>${esc(w.name)}</b> · ${esc(w.providerBrand || "")} · Credit: ${esc(w.credit)} · ${esc(w.status)}</div>`).join("") || `<p class="muted">Belum ada worker. Pool kosong — operator tambah worker lewat form di bawah.</p>`}</div>
      <div class="card" style="margin-top:14px"><h4>Tambah Worker</h4><div class="row">
        <div><label>Provider</label><select id="wProv">${adminCache.providers.map((p) => `<option value="${p.id}">${esc(p.brand)}</option>`).join("")}</select></div>
        <div><label>Nama worker</label><input id="wName" placeholder="worker-1" /></div>
        <div><label>Credit</label><input id="wCredit" type="number" value="0" /></div></div>
        <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="addWorker()">Tambah Worker</button></div></div>`;
  }
  if (adminSection === "pengaturan") {
    const s = adminCache.settings || {};
    html = `<div id="sec-settings"><h3>Pengaturan Gateway</h3><div class="card"><div class="row">
      <div><label>Nama gateway</label><input id="setName" value="${esc(s.gateway_name || "HestiaFlow")}" /></div>
      <div><label>Base URL (dibagikan ke pengguna)</label><input id="setBase" value="${esc(s.base_url || SETTINGS.baseUrl)}" /></div></div>
      <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="saveSettings()">Simpan Pengaturan</button></div></div>`;
  }
  if (adminSection === "voucher") {
    const vs = adminCache.vouchers || [];
    html = `<div id="sec-voucher"><h3>06 · Voucher</h3><p class="muted">Buat kode vocher (16 karakter, 1x pakai) untuk upgrade paket user. Plus = 3 hari, Pro = 7 hari, Premium = 14 hari, Media = 7 hari (saat ditukar, user menerima API key Media untuk generate gambar & video).</p>
      <div class="row" style="gap:8px"><select id="newVoucherTier"><option value="plus">Plus (3 hari)</option><option value="pro">Pro (7 hari)</option><option value="premium">Premium (14 hari)</option><option value="media">Media (7 hari)</option></select><button class="btn btn-plum" onclick="createVoucher()">Buat Vocher</button></div>
      <p id="newVoucherMsg" class="muted"></p>
      <div class="grid" style="margin-top:12px">${vs.length ? vs.map((v) => `<div class="card"><b>${esc(v.code)}</b><br /><span class="chip">${esc(v.tierSlug)}</span> <span class="chip">${v.durationDays} hari</span> ${v.used ? `<span class="chip">Dipakai oleh ${esc(v.usedBy || "?")}</span>` : `<span class="chip">Belum dipakai</span>`}<br /><button class="btn btn-ghost btn-sm" onclick="copyVoucher('${esc(v.code)}')">Salin Kode</button> <button class="btn btn-danger btn-sm" onclick="deleteVoucher(${v.id})">Hapus</button></div>`).join("") : `<p class="muted">Belum ada vocher.</p>`}</div></div>`;
  }
  el.innerHTML = html;
}
async function createVoucher() {
  const tier = $("#newVoucherTier").value; const msg = $("#newVoucherMsg");
  try { const r = await api("/api/admin/vouchers", { method: "POST", body: JSON.stringify({ tierSlug: tier }) }); if (msg) msg.textContent = `Vocher dibuat: ${r.voucher.code} (${r.voucher.tierSlug}, ${r.voucher.durationDays} hari). Salin & beri ke user.`; loadAdmin(); }
  catch (e) { if (msg) msg.textContent = "Gagal buat vocher: " + e.message; }
}
async function deleteVoucher(id) { if (!confirm("Hapus vocher ini?")) return; try { await api(`/api/admin/vouchers/${id}`, { method: "DELETE" }); loadAdmin(); } catch (e) { alert("Gagal hapus: " + e.message); } }
function copyVoucher(code) { navigator.clipboard.writeText(code).then(() => alert("Kode tersalin: " + code)); }
function viewUserKeys(id) {
  const u = adminCache.users.find((x) => x.id === id); if (!u) return;
  keyFilterUser = u.email; adminSection = "kunci"; renderAdminSections(); scrollToId("admin-keys");
}
function clearKeyFilter() { keyFilterUser = null; renderAdminSections(); }
async function setUserTier(id, slug) { try { await api(`/api/admin/users/${id}/tier`, { method: "POST", body: JSON.stringify({ tierSlug: slug }) }); } catch (e) { alert("Gagal set paket: " + e.message); } }
// Hapus pengguna: pola dua-ketuk yang sama kayak tombol hapus lain di app ini
// (ketuk 1 = tombol bersenjata "Yakin Hapus?" selama 3 detik, ketuk 2 = eksekusi).
// Pola lama (dialog confirm() + klik tombol sekali lagi) mati di browser HP /
// WebView — dialog-nya gampang ke-suppress dan penghapusan tidak pernah jalan.
function askDeleteUser(id, btn) {
  if (!btn) return;
  if (btn.dataset.armed === "1") {
    btn.disabled = true; btn.textContent = "Menghapus…";
    api(`/api/admin/users/${id}`, { method: "DELETE" }).then(() => loadAdmin()).catch((e) => { alert("Gagal hapus: " + e.message); btn.disabled = false; btn.textContent = "Hapus Akun"; btn.dataset.armed = ""; });
    return;
  }
  btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
  setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = "Hapus Akun"; } }, 3000);
}
function askSuspendUser(id, btn, currently) {
  if (!btn) return;
  const label = currently ? "Aktifkan" : "Suspend";
  if (btn.dataset.armed === "1") {
    btn.disabled = true; btn.textContent = "Memproses…";
    api(`/api/admin/users/${id}/suspend`, { method: "POST", body: JSON.stringify({ suspended: currently ? false : true }) }).then(() => loadAdmin()).catch((e) => { alert("Gagal: " + e.message); btn.disabled = false; btn.textContent = label; btn.dataset.armed = ""; });
    return;
  }
  btn.dataset.armed = "1"; btn.textContent = currently ? "Yakin Aktifkan?" : "Yakin Suspend?";
  setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = label; } }, 3000);
}
function askDeleteKeyAdmin(id, btn) {
  if (!btn) return;
  if (btn.dataset.armed === "1") {
    btn.disabled = true; btn.textContent = "Menghapus…";
    api(`/api/admin/keys/${id}`, { method: "DELETE" }).then(() => loadAdmin()).catch((e) => { alert("Gagal hapus key: " + e.message); btn.disabled = false; btn.textContent = "Hapus Key"; btn.dataset.armed = ""; });
    return;
  }
  btn.dataset.armed = "1"; btn.textContent = "Yakin Hapus?";
  setTimeout(() => { if (btn.dataset) { btn.dataset.armed = ""; btn.textContent = "Hapus Key"; } }, 3000);
}
async function addTier() {
  const name = $("#newTierName").value.trim(); if (!name) return alert("Nama tier wajib diisi");
  await api("/api/admin/tiers", { method: "POST", body: JSON.stringify({ name, audienceLabel: $("#newTierAud").value, badge: "", maxModels: $("#newTierMax").value ? Number($("#newTierMax").value) : null }) });
  loadAdmin();
}
function stepAdminCount(id, d) { const el = $("#acount-" + id); if (el) el.value = Math.max(1, Math.min(50, (parseInt(el.value, 10) || 1) + d)); }
async function doAdminHarvest(providerId) {
  const el = $("#acount-" + providerId); const count = Math.max(1, Math.min(50, parseInt(el.value, 10) || 1));
  const box = $("#alog-" + providerId);
  try {
    const out = await api("/api/admin/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    out.logs.forEach((m) => { const d = document.createElement("div"); d.className = "ok"; d.textContent = m; box.prepend(d); });
    loadAdmin();
  } catch (e) { alert("Panen gagal: " + e.message); }
}
async function addWorker() {
  const providerId = Number($("#wProv").value), name = $("#wName").value.trim(), credit = Number($("#wCredit").value) || 0;
  if (!name) return alert("Nama worker wajib diisi");
  await api("/api/admin/workers", { method: "POST", body: JSON.stringify({ providerId, name, credit }) });
  loadAdmin();
}
async function setProviderKey(providerId) {
  const key = prompt("Masukkan upstream API key untuk provider ini (dapur, tidak ditampilkan ke pengguna):");
  if (!key || !key.trim()) return;
  try {
    const out = await api(`/api/admin/providers/${providerId}`, { method: "PUT", body: JSON.stringify({ upstreamApiKey: key.trim() }) });
    if (out && out.ok) { alert("API key tersimpan."); loadAdmin(); } else { alert("Gagal menyimpan."); }
  } catch (e) { alert("Gagal menyimpan: " + e.message); }
}
async function saveSettings() {
  await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ gateway_name: $("#setName").value, base_url: $("#setBase").value }) });
  alert("Pengaturan disimpan.");
  load();
}
// ---- Bubble info API (perintah Hestia 2026-10-23): tombol bulat di tepi layar ->
// panel contoh cURL + hasil JSON. Nempel di body agar tidak ikut ter-render ulang. ----
function apiSampleTexts() {
  const B = location.origin + "/v1";
  return {
    chat: "curl " + B + "/chat/completions \\\n  -H \"Authorization: Bearer hgw-KEY-KAMU\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Halo!\"}]}'",
    gambar: "curl " + B + "/images/generations \\\n  -H \"Authorization: Bearer hgw-KEY-MEDIA-KAMU\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\":\"flux-schnell\",\"prompt\":\"kucing oranye di taman bunga\"}'",
    video: "curl " + B + "/videos/generations \\\n  -H \"Authorization: Bearer hgw-KEY-MEDIA-KAMU\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\":\"seedance-1.5-pro\",\"prompt\":\"layangan di atas sawah hijau\",\"duration\":5}'",
    paramGambar: "curl " + B + "/images/generations \\\n  -H \"Authorization: Bearer hgw-KEY-MEDIA-KAMU\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\":\"flux-schnell\",\"prompt\":\"kucing oranye di taman bunga\",\"size\":\"1024x1536\",\"seed\":42,\"negative_prompt\":\"buram, teks, watermark\"}'",
    paramVideo: "curl " + B + "/videos/generations \\\n  -H \"Authorization: Bearer hgw-KEY-MEDIA-KAMU\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\":\"seedance-1.5-pro\",\"prompt\":\"layangan di atas sawah hijau\",\"duration\":5,\"num_frames\":120,\"fps\":24,\"seed\":7,\"negative_prompt\":\"goyang, buram\"}'",
    jsonChat: "{\n  \"id\": \"chatcmpl-...\",\n  \"object\": \"chat.completion\",\n  \"model\": \"auto\",\n  \"choices\": [{\n    \"message\": { \"role\": \"assistant\", \"content\": \"Halo! Ada yang bisa saya bantu?\" },\n    \"finish_reason\": \"stop\"\n  }],\n  \"usage\": { \"prompt_tokens\": 12, \"completion_tokens\": 9, \"total_tokens\": 21 }\n}",
    jsonMedia: "{\n  \"created\": 1792696805,\n  \"data\": [{ \"url\": \"https://.../hasil-generate.jpg\" }]\n}"
  };
}
function mountApiBubble() {
  if (document.getElementById("apiBubbleBtn")) return;
  if (!document.body) return;
  const S = apiSampleTexts();
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:10px";
  const block = (label, key) => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><b style="font-size:13px;color:#d4af37">${label}</b><button class="btn btn-ghost btn-sm" data-copy="${key}">Salin</button></div><pre style="margin:0;background:#0d0b08;border:1px solid #3a3226;border-radius:10px;padding:10px;font-size:11px;line-height:1.5;overflow-x:auto;white-space:pre;color:#f3ead2">${esc(S[key])}</pre></div>`;
  wrap.innerHTML = `
  <div id="apiPanel" style="display:none;width:min(92vw,400px);max-height:72vh;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;background:#17140f;border:1px solid #d4af37;border-radius:16px;padding:14px;color:#f3ead2;box-shadow:0 18px 50px rgba(0,0,0,.55)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b style="font-size:15px">Contoh Pakai API</b><button id="apiPanelClose" class="btn btn-ghost btn-sm" style="color:#f3ead2">✕</button></div>
    ${block("cURL — Chat", "chat")}
    ${block("cURL — Buat Gambar (tier Media)", "gambar")}
    ${block("cURL — Buat Video (tier Media)", "video")}
    ${block("cURL — Parameter Lengkap (Gambar)", "paramGambar")}
    ${block("cURL — Parameter Lengkap (Video)", "paramVideo")}
    ${block("Hasil JSON — Chat", "jsonChat")}
    ${block("Hasil JSON — Gambar/Video", "jsonMedia")}
    <p class="muted" style="margin:0;font-size:12px">Ganti hgw-KEY-KAMU dengan API key milikmu. Chat mendukung streaming (tambah "stream": true).<br /><br /><b>Parameter media:</b> "size" = ukuran/rasio hasil (mis. 1024x1024, 1024x1536, 720p) • "seed" = angka kunci agar hasil bisa diulang persis • "num_frames"/"frames" = jumlah frame video • "fps" = frame per detik • "negative_prompt" = yang harus dihindari model (mis. buram, teks, watermark). Dukungan tiap parameter tergantung modelnya.</p>
  </div>
  <div id="creditPanel" style="display:none;width:min(92vw,340px);max-height:72vh;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;background:#17140f;border:1px solid #d4af37;border-radius:16px;padding:14px;color:#f3ead2;box-shadow:0 18px 50px rgba(0,0,0,.55)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b style="font-size:15px">Credit / Token Saya</b><button id="creditPanelClose" class="btn btn-ghost btn-sm" style="color:#f3ead2">✕</button></div>
    <div id="creditBody"><p class="muted" style="margin:0;font-size:13px">Memuat credit kamu…</p></div>
  </div>
  <button id="creditBubbleBtn" title="Credit / Token Saya" style="width:56px;height:56px;border-radius:50%;border:2px solid #f3ead2;background:linear-gradient(135deg,#d4af37,#b8860b);color:#17140f;font-size:23px;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5)">🪙</button>
  <button id="apiBubbleBtn" title="Contoh cURL & JSON" style="width:56px;height:56px;border-radius:50%;border:2px solid #f3ead2;background:linear-gradient(135deg,#d4af37,#b8860b);color:#17140f;font-size:19px;font-weight:800;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.5)">&lt;/&gt;</button>`;
  document.body.appendChild(wrap);
  const panel = wrap.querySelector("#apiPanel");
  const creditPanel = wrap.querySelector("#creditPanel");
  // Lapisan penutup full-layar: menangkep semua sentuhan di luar panel agar layar
  // di baliknya tidak ikut ketekan/kegeser (laporan Hestia 2026-10-23); tap di sini menutup panel.
  const backdrop = document.createElement("div");
  backdrop.id = "apiBackdrop";
  backdrop.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;touch-action:none;overscroll-behavior:none";
  document.body.appendChild(backdrop);
  const applyChrome = () => {
    const open = panel.style.display !== "none" || creditPanel.style.display !== "none";
    backdrop.style.display = open ? "block" : "none";
    // Kunci scroll di html + body: sebagian browser HP mengabaikan kunci di body saja.
    document.body.style.overflow = open ? "hidden" : "";
    document.documentElement.style.overflow = open ? "hidden" : "";
  };
  const setApiPanel = (open) => {
    panel.style.display = open ? "block" : "none";
    if (open) creditPanel.style.display = "none";
    applyChrome();
  };
  // ---- Panel Credit / Token (perintah Hestia 2026-10-23 malam): tombol bubble bulat
  // di atas tombol cURL -> panel jumlah credit pengguna per tier (dari /api/my-keys). ----
  const fmtCredit = (n) => Number(n || 0).toLocaleString("id-ID");
  const loadCreditPanel = async () => {
    const body = wrap.querySelector("#creditBody");
    body.innerHTML = `<p class="muted" style="margin:0;font-size:13px">Memuat credit kamu…</p>`;
    let keys = null;
    try { const j = await api("/api/my-keys"); keys = j.keys || []; } catch {}
    if (!keys) { body.innerHTML = `<p style="margin:0;font-size:13px">Masuk dulu pakai akun Google buat lihat credit kamu.</p>`; return; }
    // Satuan asli tiap tier (dari catatan provider kita sendiri; perintah Hestia
    // 2026-10-23: "yang pake credit buat Credit, yang pake token buat Token"):
    // Plus/Aurora = credit dolar (tersimpan sbg mikro-dolar: 200.000 = $0.20/akun);
    // Pro/Nova = token (283.000/akun); Premium/Stella = token (30.000/hari per akun);
    // Gratis = key aktif + panggilan/hari; Media = tanpa kuota.
    const UNITS = { gratis: "keys", plus: "usd", pro: "token", premium: "token", media: "noquota" };
    const tiers = [["gratis", "Gratis"], ["plus", "Plus"], ["pro", "Pro"], ["premium", "Premium"], ["media", "Media"]];
    let totalToken = 0, totalUsd = 0, rows = "";
    for (const [slug, label] of tiers) {
      const ks = keys.filter((k) => k.tierSlug === slug);
      const unit = UNITS[slug];
      let val;
      if (!ks.length) val = `<span class="muted">Belum ada</span>`;
      else if (unit === "noquota") val = `Tanpa kuota <span class="muted">(${ks.length} key)</span>`;
      else if (unit === "keys") val = `${ks.length} key aktif <span class="muted">(100 panggilan/hari)</span>`;
      else if (unit === "token") { const sum = ks.reduce((a, k) => a + (k.credit || 0), 0); totalToken += sum; val = `${fmtCredit(sum)} token <span class="muted">(${ks.length} key)</span>`; }
      else { const sum = ks.reduce((a, k) => a + (k.credit || 0), 0); totalUsd += sum / 1000000; val = `$${(sum / 1000000).toFixed(2)} <span class="muted">(${ks.length} key)</span>`; }
      rows += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(212,175,55,.18)"><b style="font-size:13px;color:#d4af37">Tier ${label}</b><span style="font-size:13px;font-weight:700">${val}</span></div>`;
    }
    const summary = `<div style="background:#0d0b08;border:1px solid #3a3226;border-radius:10px;padding:10px 12px;margin-bottom:6px;font-size:14px;line-height:1.9"><div style="display:flex;justify-content:space-between"><span class="muted">Token</span><b>${fmtCredit(totalToken)}</b></div><div style="display:flex;justify-content:space-between"><span class="muted">Credit</span><b style="color:#d4af37">$${totalUsd.toFixed(2)}</b></div></div>`;
    body.innerHTML = summary + rows + `<p class="muted" style="margin:10px 0 0;font-size:12px">Token & credit dihitung dari akun yang masih hidup di tiap key. Angka dimuat ulang tiap panel dibuka.</p>`;
  };
  const setCreditPanel = (open) => {
    creditPanel.style.display = open ? "block" : "none";
    if (open) { panel.style.display = "none"; loadCreditPanel(); }
    applyChrome();
  };
  backdrop.addEventListener("click", () => { setApiPanel(false); setCreditPanel(false); });
  wrap.querySelector("#apiBubbleBtn").addEventListener("click", () => setApiPanel(panel.style.display === "none"));
  wrap.querySelector("#apiPanelClose").addEventListener("click", () => setApiPanel(false));
  wrap.querySelector("#creditBubbleBtn").addEventListener("click", () => setCreditPanel(creditPanel.style.display === "none"));
  wrap.querySelector("#creditPanelClose").addEventListener("click", () => setCreditPanel(false));
  wrap.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copyText(S[b.getAttribute("data-copy")], b)));
}
const _renderApiBubble = render;
render = function () { _renderApiBubble(); mountApiBubble(); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountApiBubble); else mountApiBubble();
load();
