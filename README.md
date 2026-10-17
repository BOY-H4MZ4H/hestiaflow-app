# HestiaFlow — web

Gerbang API yang mengalir. Google login only. Panen Akun. Tier Gratis / Plus / Premium.
Arsitektur 2 jalur: pengguna hanya melihat Base URL HestiaFlow + API key HestiaFlow + Credit.
Identitas provider asli (nama, Base URL, API key, email, sandi) tidak pernah tampil ke pengguna
dan tidak pernah bocor di response API, log, error, atau kode client.

## Jalankan lokal
```sh
npm install
cp .env.example .env   # isi GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_EMAILS
npm start
```

## Deploy Railway
Repo ini di-deploy dari GitHub ke Railway (Nixpacks, `node server.js`).
Env yang wajib di Railway: `BASE_URL` (URL Railway), `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (= `<BASE_URL>/auth/google/callback`),
`SESSION_SECRET`, `ADMIN_EMAILS`, `DATABASE_PATH` (`/data/hestiaflow.db` + volume `/data`).

## Tier
- Gratis — Luna, maks 2 model (qwen3-coder:30b + llama3.2:3b).
- Plus — Aurora, 30 model.
- Premium — Stella, 514 model, 30.000 token/hari per akun terverifikasi.
