/* HestiaFlow frontend. User-facing: ONLY brand names + HestiaFlow Base URL + HestiaFlow key + Credit. */
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let ME = null, TIERS = [], SETTINGS = { gatewayName: "HestiaFlow", baseUrl: "https://api.hestia-gateway.id/v1" }, POOL = { workers: 0, ready: false };
let adminTab = "user"; // 'user' | 'admin'
let adminSection = "pengguna";
let keyFilterUser = null;
let adminCache = { users: [], keys: [], providers: [], workers: [], tiers: [], stats: {}, settings: {} };
let deletePending = null;

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
  try {
    const me = await api("/api/me"); ME = me.user;
    const pub = await api("/api/public/tiers"); TIERS = pub.tiers || [];
    const st = await api("/api/public/settings"); SETTINGS = st;
    const pool = await api("/api/public/pool"); POOL = pool;
    $("#footBase").textContent = SETTINGS.baseUrl || "https://api.hestia-gateway.id/v1";
  } catch (e) { /* offline-ish */ }
  renderAuth();
  render();
}
function renderAuth() {
  const a = $("#authArea");
  if (!ME) {
    a.innerHTML = `<button class="btn btn-plum" onclick="location.href='/auth/google'">Masuk dengan Google</button>`;
  } else {
    a.innerHTML = `<span class="muted" style="margin-right:8px">${esc(ME.name || ME.email)}</span>
      ${ME.is_admin ? `<button class="btn btn-ghost btn-sm" onclick="switchTab('admin')">Panel Admin</button> <button class="btn btn-ghost btn-sm" onclick="switchTab('user')">Halaman Pengguna</button>` : ""}
      <button class="btn btn-ghost btn-sm" onclick="logout()">Keluar</button>`;
  }
}
async function logout() { await api("/api/logout", { method: "POST" }); location.reload(); }
function switchTab(t) { adminTab = t; if (t === "admin") loadAdmin(); render(); }
function switchSection(s) { adminSection = s; renderAdminSections(); }

function tierShowcase() {
  return `<div class="section"><h2>Pilihan Tier</h2><p class="sub">Tiap tier punya provider sendiri-sendiri — tidak digabung.</p>
  <div class="grid tiers">${TIERS.map((t) => `
    <div class="card tier ${t.slug === "premium" ? "premium" : ""}">
      <span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : "premium"}">${esc(t.badge)}</span>
      <h3 style="color:var(--plum);margin:10px 0 4px">Tier ${esc(t.name)}</h3>
      <p class="kv">${esc(t.audienceLabel)}${t.maxModels != null ? ` · Maks ${t.maxModels} model` : ""}</p>
      ${(t.providers || []).map((p) => `
        <div class="brand"><div class="medal ${t.slug === "premium" ? "gold" : ""}">${esc(p.brand.slice(0, 1))}</div>
        <div><h3>${esc(p.brand)}</h3><p>${esc(p.tagline || "")}</p></div></div>
        <div><span class="chip">${p.modelCount} model</span><span class="chip">${esc(p.creditNote || "")}</span></div>
        <p class="kv">${esc(p.modelNotes && Object.values(p.modelNotes)[0] || "")}</p>
      `).join("") || `<p class="muted">Belum ada provider di tier ini.</p>`}
    </div>`).join("")}</div></div>`;
}

function render() {
  const app = $("#app");
  const poolNotice = POOL.ready
    ? `<div class="notice"><strong>Pool worker siap.</strong> Pendaftaran dan Panen Akun dibuka.</div>`
    : `<div class="notice"><strong>Pool worker sedang disiapkan operator:</strong> pendaftaran dibuka begitu ada worker aktif dengan sisa credit.</div>`;
  let hero = `<div class="hero"><div class="goldline"></div><h1>Satu akun Google, semua API terbuka.</h1>
    <p>Daftar dengan Google, dapatkan API key HestiaFlow + Base URL HestiaFlow + Credit. Tanpa kartu, tanpa sandi.</p>
    ${!ME ? `<button class="btn btn-gold" onclick="location.href='/auth/google'">Masuk dengan Google</button>` : `<span class="badge premium">Masuk sebagai ${esc(ME.name || ME.email)}</span>`}
    </div>${poolNotice}`;
  if (!ME) {
    const urlParams = new URLSearchParams(location.search);
    const oauthNote = urlParams.get("oauth") === "missing"
      ? `<div class="notice"><strong>Login Google belum dikonfigurasi.</strong> Operator perlu mengatur GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET untuk domain ini.</div>` : "";
    app.innerHTML = hero + oauthNote + tierShowcase();
    return;
  }
  if (ME.is_admin && adminTab === "admin") {
    app.innerHTML = hero + `<div id="adminRoot"><p class="muted">Memuat Panel Admin…</p></div>`;
    loadAdmin();
    return;
  }
  app.innerHTML = hero + `<div id="userRoot"><p class="muted">Memuat Halaman Pengguna…</p></div>` + tierShowcase();
  loadUser();
}

async function loadUser() {
  try {
    const provOpts = TIERS.flatMap((t) => (t.providers || []).map((p) => `<option value="${p.id}">${esc(t.name)} · ${esc(p.brand)} (${p.modelCount} model)</option>`)).join("");
    $("#userRoot").innerHTML = `
    <div class="section"><h2>Panen Akun</h2><p class="sub">Panen akun provider — tiap panen membuat 1 akun baru dengan email sementara yang berbeda-beda. Email & sandi tidak pernah ditampilkan. Pilih bebas 1–50 (maks 50).</p>
      <div class="card"><div class="row">
        <div><label>Provider</label><select id="harvestProvider">${provOpts}</select></div>
        <div><label>Jumlah akun (1–50)</label><div class="stepper">
          <button type="button" onclick="stepCount(-1)">−</button>
          <input id="harvestCount" type="number" min="1" max="50" value="1" oninput="clampCount(this)" />
          <button type="button" onclick="stepCount(1)">+</button></div></div>
      </div>
      <div style="margin-top:14px"><button class="btn btn-plum" id="harvestBtn" onclick="doUserHarvest()">Panen Akun</button></div>
      <div class="progress" style="margin-top:14px"><div id="harvestProg"></div></div>
      <p class="kv" id="harvestProgText"></p>
      <div class="termbox" id="harvestProc" style="display:none"></div>
      <p class="kv" id="harvestSummary"></p>
</div></div>`;
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
  const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>0</b> &nbsp;·&nbsp; Mati : <b>0</b></span>`;
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
function stepCount(d) { const el = $("#harvestCount"); if (!el) return; el.value = Math.max(1, Math.min(50, (parseInt(el.value, 10) || 1) + d)); }
async function doUserHarvest() {
  const btn = $("#harvestBtn"); btn.disabled = true;
  const providerId = Number($("#harvestProvider").value), count = Math.max(1, Math.min(50, parseInt($("#harvestCount").value, 10) || 1));
  const proc = $("#harvestProc"); proc.style.display = "block";
  proc.innerHTML = `<div class="term-line"><span class="cute-spin"></span> Lagi Proses...</div><div class="term-line">Scrap Proxy...</div>`;
  $("#harvestProg").style.width = "0%"; $("#harvestProgText").textContent = "";
  try {
    const out = await api("/api/harvest", { method: "POST", body: JSON.stringify({ providerId, count }) });
    $("#harvestProg").style.width = "100%"; $("#harvestProgText").textContent = `${out.count} dari ${count} akun berhasil dipanen`;
    let html = `<div class="term-line">Total Proxy OK: ${out.proxyTotal != null ? out.proxyTotal : 0}</div>`;
    (out.keys || []).forEach((k, i) => {
      const st = k.live ? `<span class="term-live">Live</span>` : `<span class="term-dead">Mati</span>`;
      if (k.live) html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Api key : ${esc(k.key || "")}</div><div>Token/Credit : ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</div></div>`;
      else html += `<div class="term-line term-key"><div>${i + 1} -${st}-</div><div>Tidak dapat Di pakai</div></div>`;
    });
    proc.innerHTML = html;
    const liveN = (out.keys || []).filter((k) => k.live).length;
    const deadN = (out.keys || []).length - liveN;
    lastHarvestKeys = out.keys || [];
    const sumEl = $("#harvestSummary"); if (sumEl) sumEl.innerHTML = `<span>Live : <b>${liveN}</b> &nbsp;·&nbsp; Mati : <b>${deadN}</b></span> <span style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="copyAllHarvestKeys(this)">Salin</button> <button class="btn btn-danger btn-sm" onclick="deleteAllHarvestKeys(this)">Hapus</button></span>`;
    btn.disabled = false;
  } catch (e) {
    proc.innerHTML = `<div class="term-line term-err">Gagal: ${esc(e.message)}</div>`;
    btn.disabled = false;
  }
}

// ---------- admin ----------
async function loadAdmin() {
  try {
    const [stats, users, keys, providers, workers, tiers, settings, logs] = await Promise.all([
      api("/api/admin/stats"), api("/api/admin/users"), api("/api/admin/keys"),
      api("/api/admin/providers"), api("/api/admin/workers"), api("/api/admin/tiers"),
      api("/api/admin/settings"), api("/api/admin/harvest-logs"),
    ]);
    adminCache = { stats: stats.stats, users: users.users, keys: keys.keys, providers: providers.providers, workers: workers.workers, tiers: tiers.tiers, settings: settings.settings, logs: logs.logs };
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
    </nav>
    <div id="adminSections"></div></div>`;
  renderAdminSections();
}
function renderAdminSections() {
  const el = $("#adminSections"); if (!el) return;
  $$(".admin-nav button").forEach((b, i) => { const names = ["pengguna", "kunci", "provider", "worker", "pengaturan"]; b.classList.toggle("active", adminSection === names[i]); });
  let html = "";
  if (adminSection === "pengguna") {
    html = `<div id="sec-pengguna"><h3>01 · Pengguna</h3><p class="muted">Ketuk kartu pengguna untuk melihat kunci miliknya.</p>
      <div class="grid">${adminCache.users.length ? adminCache.users.map((u) => `
      <div class="card usercard" role="button" tabindex="0" onclick="viewUserKeys(${u.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();viewUserKeys(${u.id})}">
        <div style="display:flex;gap:10px;align-items:center">${u.avatar ? `<img src="${esc(u.avatar)}" style="width:40px;height:40px;border-radius:50%" />` : `<div style="width:40px;height:40px;border-radius:50%;background:var(--plum);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${esc((u.name || u.email || "?").slice(0, 1).toUpperCase())}</div>`}
        <div><b>${esc(u.name || "(tanpa nama)")}</b><br /><span class="muted">${esc(u.email)}</span><br /><span class="chip">${u.keyCount} kunci</span>${u.isAdmin ? `<span class="chip">Admin</span>` : ""}</div></div>
        <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewUserKeys(${u.id})">Lihat Kunci</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();askDeleteUser(${u.id},'${esc(u.email)}')">Hapus Akun</button></div>
        <div class="hint">Ketuk kartu untuk melihat kunci</div></div>`).join("") : `<p class="muted">Belum ada pengguna terdaftar.</p>`}</div></div>`;
  }
  if (adminSection === "kunci") {
    const keys = keyFilterUser ? adminCache.keys.filter((k) => String(k.ownerEmail) === String(keyFilterUser)) : adminCache.keys;
    html = `<div id="admin-keys"><h3>Semua API key</h3>
      ${keyFilterUser ? `<div class="banner-filter">Filter: kunci milik <b>${esc(keyFilterUser)}</b> <button class="btn btn-ghost btn-sm" onclick="clearKeyFilter()">Tampilkan semua</button></div>` : ""}
      <div class="grid">${keys.map((k) => `<div class="card"><span class="chip">${esc(k.providerBrand || "")}</span><span class="chip">${esc(k.tierSlug || "")}</span>
        <p class="kv">Pemilik: <b>${esc(k.ownerEmail || "(pool)")}</b> · Prefix: ${esc(k.keyPrefix)} · Credit: ${k.credit != null ? esc(k.credit) : "Tidak dinyatakan"}</p>
        <div>${(k.models || []).slice(0, 8).map((m) => `<span class="chip model">${esc(m)}</span>`).join("")}${(k.models || []).length > 8 ? `<span class="chip">+${k.models.length - 8} lagi</span>` : ""}</div></div>`).join("") || `<p class="muted">Belum ada kunci.</p>`}</div></div>`;
  }
  if (adminSection === "provider") {
    html = `<div id="sec-provider"><h3>Provider & Tier</h3>
      <div class="card"><h4>Kelola Tier</h4><div class="grid">${adminCache.tiers.map((t) => `
        <div class="card"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : "premium"}">${esc(t.badge || t.name)}</span>
        <p class="kv">Slug: ${esc(t.slug)} · ${t.providerCount} provider${t.max_models != null ? ` · Maks ${t.max_models} model` : ""}</p></div>`).join("")}</div>
        <div class="row"><div><label>Nama tier baru</label><input id="newTierName" placeholder="mis. Ultra" /></div>
        <div><label>Label audiens</label><input id="newTierAud" placeholder="UNTUK PENGGUNA ULTRA" /></div>
        <div><label>Maks model (kosong = tanpa batas)</label><input id="newTierMax" type="number" min="1" placeholder="" /></div></div>
        <button class="btn btn-plum btn-sm" style="margin-top:10px" onclick="addTier()">Tambah Tier</button></div>
      ${(adminCache.tiers || []).map((t) => {
        const provs = adminCache.providers.filter((p) => p.tierId === t.id);
        return `<div class="card" style="margin-top:14px"><span class="badge ${t.slug === "gratis" ? "gratis" : t.slug === "plus" ? "plus" : "premium"}">${esc(t.badge || t.name)}</span>
        <h4>Tier ${esc(t.name)}</h4>
        ${provs.map((p) => `<div style="border-top:1px solid var(--line);padding:10px 0">
          <b>${esc(p.brand)}</b> · ${p.modelCount} model · ${esc(p.creditNote || "")}
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
  el.innerHTML = html;
}
function viewUserKeys(id) {
  const u = adminCache.users.find((x) => x.id === id); if (!u) return;
  keyFilterUser = u.email; adminSection = "kunci"; renderAdminSections(); scrollToId("admin-keys");
}
function clearKeyFilter() { keyFilterUser = null; renderAdminSections(); }
function askDeleteUser(id, email) {
  if (deletePending === id) {
    deletePending = null;
    api(`/api/admin/users/${id}`, { method: "DELETE" }).then(() => loadAdmin()).catch((e) => alert("Gagal: " + e.message));
  } else {
    deletePending = id;
    if (!confirm(`Hapus akun ${email}? Klik Hapus Akun sekali lagi untuk konfirmasi.`)) deletePending = null;
  }
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
async function saveSettings() {
  await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ gateway_name: $("#setName").value, base_url: $("#setBase").value }) });
  alert("Pengaturan disimpan.");
  load();
}
load();
