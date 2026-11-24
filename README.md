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

`pnpm test` membangun backend kemudian menjalankan skenario integrasi dan tes konkurensi scheduler. Database khusus `bilcode_monitoring_integration_test` dibuat ulang; database aplikasi tidak dihapus. API Bilcode/GOWA/Vikey memakai server tiruan, sehingga pengujian tidak membutuhkan frontend, cookie nyata, biaya AI, atau pengiriman WhatsApp sungguhan. Tes konkurensi menggunakan promise barrier untuk memastikan urutan start/stop dan penyelesaian scheduler; urutan pemanggilan dua fetch tidak dianggap menjamin urutan kedatangan HTTP. Penulisan jadwal berikutnya mengikuti antrean operasi monitoring dan hanya dilakukan oleh timer yang masih berlaku.

Dependency dan lockfile sekarang berada pada repo ini. Instalasi serta pengujian backend dapat dilakukan walaupun folder frontend tidak tersedia.

## Autentikasi panel JWT

`POST /api/auth/login` menerima `{ "username": "...", "password": "..." }`, lalu mengembalikan `access_token`, `token_type: "Bearer"`, `expires_in: 900`, dan `username`. Endpoint panel yang dilindungi menerima `Authorization: Bearer <access_token>`.

Refresh JWT disimpan pada cookie `monitor_refresh` dengan `HttpOnly`, `SameSite=Strict`, path `/api/auth`, dan `Secure` pada produksi. `POST /api/auth/refresh` menggunakan cookie ini untuk menghasilkan access JWT dan refresh JWT baru. Hanya hash refresh token terakhir yang disimpan di PostgreSQL; token lama ditolak, termasuk pada request bersamaan. Masa sesi maksimal 30 hari sejak login, tidak diperpanjang oleh rotasi. Semua POST tetap membutuhkan header `Origin` frontend yang terdaftar pada `APP_ORIGIN`.

Frontend menyimpan access token hanya di memori dan melakukan refresh otomatis saat dibutuhkan, termasuk setelah reload. `POST /api/auth/logout` mencabut sesi panel saat ini, termasuk akses JWT yang belum kedaluwarsa. Logout tetap dapat dilakukan dengan cookie refresh ketika access JWT sudah kedaluwarsa. Login browser lain membuat sesi panel terpisah.

Migrasi JWT mengakhiri sesi panel lama sehingga operator perlu login sekali lagi. Konfigurasi, data monitoring, serta sesi Bilcode tetap tersimpan. JWT panel ini tidak menggantikan cookie autentikasi upstream Bilcode.

## GitHub Actions dan VPS

Koneksi pool database dibatasi 10 detik saat menghubungkan/mengambil koneksi dan 15 detik saat menunggu query, dengan TCP keepalive. Koneksi lock worker memakai keepalive dan jalur direct. Jika lock terputus, worker membatalkan operasi aktif dan meminta shutdown; batas paksa 10 detik memastikan proses keluar meskipun shutdown hook tertahan database, sehingga restart policy Docker dapat memulihkannya. Health mengembalikan 503 saat lock tidak sehat atau probe database melewati 3 detik. Restart tidak mengirim ulang bid yang ambigu; pemulihan status tetap mengikuti `my-bids`.

Panduan branch, GitHub Environment secrets, Neon development, serta deployment Docker tersedia di [deploy/README.md](deploy/README.md).

## Pengajuan bid dengan satu konfirmasi

Generator menyertakan [panduan Humanizer-zh yang diadaptasi ke bahasa Indonesia](docs/humanizer-zh/README.md) untuk menyunting gaya sebelum JSON akhir dikembalikan. Panduan mengurangi pengulangan dan ungkapan template sambil mempertahankan lingkup, syarat, dan fakta. Tetap satu panggilan model; tidak ada jaminan lolos detektor AI. Tidak perlu environment tambahan.

Penolakan eksplisit POST dengan HTTP 400/401/403/404/405/410/422 dicatat FAILED, lengkap dengan tahap, status HTTP, kode mesin, dan nama field validasi yang dikenal. Respons mentah upstream tidak dicatat. Hanya HTTP 401 memicu refresh/invalidation autentikasi; 403 tidak membuktikan token kedaluwarsa. Error koneksi, 5xx, konflik 409, atau rekonsiliasi yang gagal tetap UNKNOWN setelah pengiriman dimulai. File proposal lokal bukan bukti bid diterima; hanya pencocokan `my-bids` menetapkan CONFIRMED.

Pesan penolakan Bilcode yang dikenali untuk ketidakcocokan bidang keahlian dipetakan ke kode `BID_SKILL_MISMATCH`. Panel menampilkan penjelasan untuk memeriksa bidang pada profil Bilcode. Ini penolakan izin bisnis, bukan kesalahan AI atau sesi login. Sistem tidak mengubah bidang keahlian akun secara otomatis. Proyek yang muncul pada daftar available belum tentu memenuhi seluruh syarat pengajuan akun.

### Riwayat respons dan tindakan

Migrasi `20261123090000_bid_attempt_history` menambahkan tabel `BidAttempt`. Hasil pemrosesan pengajuan disimpan terpisah dari status aplikasi: outcome saat percobaan, waktu, tahap, status HTTP, kode, pesan respons yang dibersihkan, dan saran tindakan. Penolakan tidak ditimpa oleh percobaan berikutnya. HTTP 200 hanya menunjukkan respons POST; CONFIRMED tetap memerlukan pencocokan `my-bids`. Rekonsiliasi di kemudian hari dapat mengubah status aplikasi, sedangkan catatan hasil percobaan tetap merekam kondisi pada saatnya.

`GET /api/bids` menyertakan hasil terakhir dan jumlah riwayat setiap aplikasi. `GET /api/bids/projects/:id/attempts?page=1&limit=5` membaca semua riwayat melalui pagination, dilindungi JWT panel. Membaca riwayat tidak melakukan request Bilcode, panggilan AI, atau pengiriman bid. Kegagalan upstream pada pemeriksaan awal proyek yang sudah tersimpan juga dicatat tanpa mengirim proposal. Penolakan input/konfirmasi tidak valid tetap mengikuti validasi endpoint biasa.

Respons tersimpan hanya berisi `message` dan pesan validasi field proposal yang dikenal, bukan keseluruhan body upstream. Nilai credential request, secret environment, JWT, bentuk token umum, serta string panjang yang berpotensi menjadi token disamarkan; pesan dan jumlah field dibatasi. Ini upaya pembatasan data, bukan jaminan mengenali setiap jenis secret dalam teks bebas. HTML response dan properti lain seperti data, stack, cookie, serta header tidak disimpan. Audit umum tetap hanya mencatat metadata. Riwayat lama sebelum migrasi tidak dibuat-buat: pesan `lastError` sebelumnya tetap ditampilkan, tanpa mengarang respons historis.

Jalankan backend beserta migrasi sebelum memperbarui frontend. Tidak ada environment baru. Pengujian memakai API tiruan dan database lokal terpisah; jangan menjalankan integration test pada Neon.

Tambahkan `VIKEY_API_KEY` pada environment backend. Untuk deployment, tambahkan ke dalam nilai multiline secret **VPS_ENV**, bukan environment frontend. Model tetap `deepseek/deepseek-v4.1-flash-1017` melalui `https://api.vikey.ai/v1/chat/completions`. Migrasi `20261121090000_bid_automation` menambahkan cache proyek, pengajuan, status sinkronisasi, dan antrean notifikasi; jalankan `pnpm db:migrate` sebelum menjalankan kode baru. Workflow deployment menerapkannya otomatis.

- `GET /api/bids?page=1&limit=10` membaca cache dan riwayat lokal, tanpa menghubungi AI atau mengajukan bid.
- `POST /api/bids/refresh` menyinkronkan proyek dan seluruh halaman `my-bids`, serta mencoba notifikasi tertunda. Sesi Bilcode harus valid.
- `POST /api/bids/projects/:id/submit` menerima `{ "confirmed": true, "version": "HASH_DARI_GET_BIDS" }`. Konfirmasi mengizinkan AI menyusun dan langsung mengirim, tanpa tinjau draft. Semuanya memerlukan JWT panel; POST juga memerlukan Origin yang terdaftar.

Sistem memeriksa riwayat bid dan proyek terbaru sebelum analisis, lalu memeriksa ulang proyek sebelum POST. Perubahan lingkup meminta konfirmasi ulang. Proposal AI divalidasi: struktur wajib lengkap, estimasi hari konsisten dan tidak melewati deadline. `proposed_amount` dipaksa **0** mengikuti payload Bilcode yang sudah diuji; fitur ini belum menentukan harga pekerjaan. Judul, deskripsi, deadline, dan teknologi proyek dikirim ke Vikey; cookie, token Bilcode, dan credential GOWA tidak dikirim ke AI.

Status lokal `GENERATING`, `SUBMITTING`, `UNKNOWN`, `CONFIRMED`, dan `FAILED` dibedakan dari status Bilcode seperti `applied`. Kegagalan sebelum pengiriman menjadi FAILED dan memerlukan konfirmasi baru. Setelah POST dimulai, respons hilang atau gagal menjadi UNKNOWN, lalu dicocokkan melalui `my-bids`; POST tidak diulang otomatis. UNIQUE project ID dan lock worker mencegah dua pengajuan oleh service ini. Jangan mengulang manual melalui dashboard Bilcode saat hasil masih UNKNOWN. Backend yang restart memulihkan pengajuan yang terputus secara konservatif.

Saat monitoring aktif, setiap siklus juga membaca semua halaman `my-bids`, termasuk ketika daftar proyek baru kosong. Interval mengikuti konfigurasi monitoring. Bid lama dari pengajuan manual menjadi baseline tanpa notifikasi awal. Perubahan nilai `status` apa pun menghasilkan WhatsApp JSON berisi status lama/baru. Data yang hilang dari daftar tidak dianggap ditolak. Kesalahan autentikasi atau struktur respons tidak mengubah status terakhir. Antrean WhatsApp tersimpan dan dicoba kembali pada siklus/sinkronisasi berikutnya; respons gateway hilang tetap dapat menyebabkan notifikasi duplikat saat retry. Menghentikan monitoring juga menghentikan pengecekan berkala bid dan membatalkan operasi aktif; sinkronisasi/pengajuan manual tetap memerlukan tindakan operator.

## Login sesi Bilcode melalui email OTP

Operator yang telah login panel dapat menggunakan `POST /api/session/otp/request` dengan `{ "email": "akun@example.com" }`, lalu `POST /api/session/otp/verify` dengan `{ "email": "akun@example.com", "code": "123456" }`. Keduanya dilindungi JWT panel, origin guard, dan rate limit. Monitoring harus dihentikan sebelum meminta atau memverifikasi OTP.

Backend mengikuti endpoint dashboard Bilcode `POST /api/auth/send-otp-email` dan `POST /api/auth/verify-otp-email`. Cookie refresh dari respons verifikasi disimpan terenkripsi dan tidak diteruskan ke browser. Email, OTP, cookie, serta payload respons upstream tidak dicatat ke log. Kegagalan verifikasi tidak menimpa sesi tersimpan.

Permintaan baru dibatasi sekali per 60 detik untuk backend ini; maksimal lima percobaan verifikasi dan umur permintaan lokal sepuluh menit. Bilcode tetap menentukan masa berlaku kode sebenarnya. Permintaan pending disimpan sementara di memori: setelah backend restart minta OTP baru. Setelah login berhasil, lakukan `POST /api/session/validate` sebelum Mulai; login tidak menjalankan worker atau mengirim notifikasi proyek.

Tidak ada variabel environment atau migrasi database baru. Import cookie tetap tersedia sebagai alternatif. Peraturan satu sesi dari Bilcode tetap berlaku: login ini dapat mencabut sesi browser lain. Pengujian integrasi memakai upstream tiruan; uji login akun nyata memerlukan email dan OTP operator.
