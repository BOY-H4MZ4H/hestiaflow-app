import fs from "node:fs";

const path = "server.js";
let s = fs.readFileSync(path, "utf8");

const blockA = `// [TEMP-DB-IMPORT] tukar database dengan hasil impor sebelum dibuka
try {
  const _imp = DB_PATH + ".imported";
  if (fs.existsSync(_imp)) {
    fs.renameSync(_imp, DB_PATH);
    for (const _e of ["-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + _e); } catch {} }
    console.log("[db-import] database hasil impor terpasang");
  }
} catch (e) { console.log("[db-import] swap gagal:", e && e.message); }
const db = new DatabaseSync(DB_PATH);`;

const oldA = "const db = new DatabaseSync(DB_PATH);";
if (!s.includes("[TEMP-DB-IMPORT] tukar database")) {
  const n = s.split(oldA).length - 1;
  if (n !== 1) throw new Error("target A ditemukan " + n + " kali");
  s = s.replace(oldA, blockA);
}

const blockB = `// [TEMP-DB-IMPORT] endpoint impor database sekali pakai (token env DB_IMPORT_TOKEN)
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
});`;

const marker = "// ---------- Auto-hapus key kedaluwarsa";
if (!s.includes("[TEMP-DB-IMPORT] endpoint impor")) {
  const i = s.indexOf(marker);
  if (i < 0) throw new Error("target B tidak ditemukan");
  if (i > 0 && s[i - 1] !== "\n") throw new Error("target B tidak di awal baris");
  s = s.slice(0, i) + blockB + "\n\n" + s.slice(i);
}

fs.writeFileSync(path, s);
console.log("patch selesai");
