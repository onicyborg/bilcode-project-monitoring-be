# Bilcode Monitoring Backend

Repository mandiri **NestJS 11 + Prisma 7 + PostgreSQL 18**. Seluruh source, migrasi, pengujian, dependency, dan konfigurasi backend berada di folder ini. Backend tidak mengimpor atau membaca file frontend/parent.

## Setup lokal

Prasyarat: Node.js 24+, pnpm 10.33.1, serta Docker Compose atau Podman dengan provider Compose untuk database lokal.

```bash
pnpm install --frozen-lockfile
pnpm run setup
pnpm run dev
```

`setup` membuat `.env` privat dari `.env.example` jika belum tersedia, menyalakan PostgreSQL dari `compose.yaml`, menghasilkan Prisma Client, dan menerapkan migrasi. Credential yang sudah ada tidak ditimpa. PostgreSQL menggunakan username `postgres`, password `postgres`, database `bilcode_monitoring`, dan port host `55432`.

Compose project tetap bernama `bilcode-monitoring-local` agar volume PostgreSQL lama digunakan kembali. Jangan menjalankan `down -v` jika ingin mempertahankan data.

API lokal: http://127.0.0.1:4100/api. Dokumentasi development: http://127.0.0.1:4100/api/docs.

Login operator dikonfigurasi melalui `ADMIN_USERNAME` dan `ADMIN_PASSWORD` di `.env`; ini berbeda dari login Bilcode maupun credential GOWA.

## Build dan service terpisah

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run db:migrate
pnpm start
```

Semua perintah dijalankan dari root repo backend ini. Source/frontend tidak diperlukan. Setelah build dan migrasi selesai, dependency development dapat dipangkas dengan `pnpm prune --prod` untuk runtime. Jalankan migrasi pada tahap rilis sebelum pemangkasan karena Prisma CLI berada pada devDependencies.

Konfigurasi deployment utama:

- `DATABASE_URL`: PostgreSQL service produksi.
- `API_HOST`: default `127.0.0.1`; gunakan `0.0.0.0` bila runtime container perlu menerima koneksi dari jaringan service.
- `API_PORT`: default `4100`.
- `APP_ORIGIN`: origin frontend yang diizinkan melakukan mutasi, dipisahkan koma bila lebih dari satu.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: akun panel operator.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`: dua kunci berbeda, masing-masing 64 karakter hex. `pnpm run setup` menghasilkannya jika belum tersedia. Pertahankan keduanya saat restart agar sesi panel tetap valid.
- `ENCRYPTION_KEY`: 64 karakter hex untuk AES-256-GCM. Pertahankan kunci yang sama ketika memindahkan database.
- `BILCODE_API_URL`, `GOWA_ALLOWED_HOSTS`: target upstream backend.
- `NODE_ENV=production`: mengaktifkan secure cookie; frontend publik harus memakai HTTPS.

Frontend memanggil API lewat proxy Next.js sehingga cookie panel tetap berada pada origin frontend. Backend tidak perlu melonggarkan CORS untuk semua domain. Jangan menaruh cookie Bilcode atau credential GOWA pada environment frontend.

## Fitur dan operasional

- Import/validasi cookie, refresh token dengan penyimpanan rotasi terenkripsi, serta start/stop monitoring yang persisten.
- Stop membatalkan request Bilcode yang berjalan dan menunggu sampai siklus berhenti.
- Advisory lock PostgreSQL dan mutex mencegah worker ganda serta perubahan sesi saat monitoring aktif.
- Pagination proyek, deduplikasi, antrean/progres pengiriman, dan notifikasi JSON melalui GOWA.
- Peringatan autentikasi sekali per gangguan dan notifikasi pemulihan.
- Log pengecekan, aktivitas, notifikasi, dan request tanpa secret atau body request.
- Access JWT 15 menit dengan refresh JWT 30 hari yang dirotasi, cookie refresh HttpOnly/SameSite Strict, validasi DTO, origin guard, serta pembatasan request.

Instalasi baru dimulai dalam keadaan berhenti. Restart mempertahankan status monitoring yang tersimpan. Keluar dari panel tidak menghentikan worker. Mengubah atau menghapus sesi maupun konfigurasi memerlukan monitoring berhenti.

Jika Bilcode mencabut sesi, cookie login baru tetap diperlukan. Refresh otomatis tidak memulihkan sesi yang dicabut. GOWA `SUCCESS` bukan bukti pesan dibaca; timeout setelah pengiriman dapat menyebabkan duplikasi pada retry karena gateway belum memakai kontrak idempotensi dalam aplikasi ini.

## Pengujian dan kualitas

```bash
pnpm test
pnpm audit
pnpm run format
```

`pnpm test` membangun backend kemudian menjalankan 17 skenario integrasi. Database khusus `bilcode_monitoring_integration_test` dibuat ulang; database aplikasi tidak dihapus. API Bilcode/GOWA memakai server tiruan, sehingga pengujian tidak membutuhkan frontend, cookie nyata, atau pengiriman WhatsApp sungguhan.

Dependency dan lockfile sekarang berada pada repo ini. Instalasi serta pengujian backend dapat dilakukan walaupun folder frontend tidak tersedia.

## Autentikasi panel JWT

`POST /api/auth/login` menerima `{ "username": "...", "password": "..." }`, lalu mengembalikan `access_token`, `token_type: "Bearer"`, `expires_in: 900`, dan `username`. Endpoint panel yang dilindungi menerima `Authorization: Bearer <access_token>`.

Refresh JWT disimpan pada cookie `monitor_refresh` dengan `HttpOnly`, `SameSite=Strict`, path `/api/auth`, dan `Secure` pada produksi. `POST /api/auth/refresh` menggunakan cookie ini untuk menghasilkan access JWT dan refresh JWT baru. Hanya hash refresh token terakhir yang disimpan di PostgreSQL; token lama ditolak, termasuk pada request bersamaan. Masa sesi maksimal 30 hari sejak login, tidak diperpanjang oleh rotasi. Semua POST tetap membutuhkan header `Origin` frontend yang terdaftar pada `APP_ORIGIN`.

Frontend menyimpan access token hanya di memori dan melakukan refresh otomatis saat dibutuhkan, termasuk setelah reload. `POST /api/auth/logout` mencabut sesi panel saat ini, termasuk akses JWT yang belum kedaluwarsa. Logout tetap dapat dilakukan dengan cookie refresh ketika access JWT sudah kedaluwarsa. Login browser lain membuat sesi panel terpisah.

Migrasi JWT mengakhiri sesi panel lama sehingga operator perlu login sekali lagi. Konfigurasi, data monitoring, serta sesi Bilcode tetap tersimpan. JWT panel ini tidak menggantikan cookie autentikasi upstream Bilcode.

## GitHub Actions dan VPS

Panduan branch, GitHub Environment secrets, Neon development, serta deployment Docker tersedia di [deploy/README.md](deploy/README.md).
