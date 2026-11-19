# Bilcode Monitoring Backend

Repository mandiri **NestJS 11 + Prisma 7 + PostgreSQL 18**. Seluruh source, migrasi, pengujian, dependency, dan konfigurasi backend berada di folder ini. Backend tidak mengimpor atau membaca file frontend/parent.

## Setup lokal

Prasyarat: Node.js 24+, npm, serta Docker Compose atau Podman dengan provider Compose untuk database lokal.

```bash
npm ci
npm run setup
npm run dev
```

`setup` membuat `.env` privat dari `.env.example` jika belum tersedia, menyalakan PostgreSQL dari `compose.yaml`, menghasilkan Prisma Client, dan menerapkan migrasi. Credential yang sudah ada tidak ditimpa. PostgreSQL menggunakan username `postgres`, password `postgres`, database `bilcode_monitoring`, dan port host `55432`.

Compose project tetap bernama `bilcode-monitoring-local` agar volume PostgreSQL lama digunakan kembali. Jangan menjalankan `down -v` jika ingin mempertahankan data.

API lokal: http://127.0.0.1:4100/api. Dokumentasi development: http://127.0.0.1:4100/api/docs.

Login operator dikonfigurasi melalui `ADMIN_USERNAME` dan `ADMIN_PASSWORD` di `.env`; ini berbeda dari login Bilcode maupun credential GOWA.

## Build dan service terpisah

```bash
npm ci
npm run build
npm run db:migrate
npm start
```

Semua perintah dijalankan dari root repo backend ini. Source/frontend tidak diperlukan. Setelah build dan migrasi selesai, dependency development dapat dipangkas dengan `npm prune --omit=dev` untuk runtime. Jalankan migrasi pada tahap rilis sebelum pemangkasan karena Prisma CLI berada pada devDependencies.

Konfigurasi deployment utama:

- `DATABASE_URL`: PostgreSQL service produksi.
- `API_HOST`: default `127.0.0.1`; gunakan `0.0.0.0` bila runtime container perlu menerima koneksi dari jaringan service.
- `API_PORT`: default `4100`.
- `APP_ORIGIN`: origin frontend yang diizinkan melakukan mutasi, dipisahkan koma bila lebih dari satu.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: akun panel operator.
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
- Sesi admin server-side delapan jam, cookie HttpOnly/SameSite Strict, validasi DTO, origin guard, serta pembatasan request.

Instalasi baru dimulai dalam keadaan berhenti. Restart mempertahankan status monitoring yang tersimpan. Keluar dari panel tidak menghentikan worker. Mengubah atau menghapus sesi maupun konfigurasi memerlukan monitoring berhenti.

Jika Bilcode mencabut sesi, cookie login baru tetap diperlukan. Refresh otomatis tidak memulihkan sesi yang dicabut. GOWA `SUCCESS` bukan bukti pesan dibaca; timeout setelah pengiriman dapat menyebabkan duplikasi pada retry karena gateway belum memakai kontrak idempotensi dalam aplikasi ini.

## Pengujian dan kualitas

```bash
npm test
npm audit
npm run format
```

`npm test` membangun backend kemudian menjalankan 13 skenario integrasi. Database khusus `bilcode_monitoring_integration_test` dibuat ulang; database aplikasi tidak dihapus. API Bilcode/GOWA memakai server tiruan, sehingga pengujian tidak membutuhkan frontend, cookie nyata, atau pengiriman WhatsApp sungguhan.

Dependency dan lockfile sekarang berada pada repo ini. Instalasi serta pengujian backend dapat dilakukan walaupun folder frontend tidak tersedia.
