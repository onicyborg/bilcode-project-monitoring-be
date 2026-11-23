# Pemeriksaan pengajuan proyek 624

Waktu berikut dalam WIB, 23 November 2026. Pemeriksaan dilakukan pada container `bilcode-monitoring-backend-api-1` dan tabel audit/status aplikasi.

- 14:19:42: operator mengonfirmasi proyek 624. Proposal AI kemudian tersimpan lokal.
- 14:20:08: audit mencatat hasil pengajuan belum pasti dan memerlukan rekonsiliasi.
- 14:20:09: rekonsiliasi gagal; endpoint panel mengembalikan HTTP 400 setelah sekitar 28 detik. Ini status endpoint panel, bukan status HTTP asli dari Bilcode.
- Riwayat lokal hasil sinkronisasi `my-bids` memuat bid lama proyek 611. Proyek 624 tidak memiliki upstream ID atau status Bilcode dan tetap UNKNOWN. Penyimpanan proposal tidak membuktikan pengajuan berhasil.
- Dalam rentang pengajuan, request panel lainnya berhasil HTTP 200 dan refresh JWT panel berhasil 201. Operator mengonfirmasi bahwa sesi yang meminta OTP ulang adalah Bilcode, bukan login panel.

Log versi lama tidak menyimpan status HTTP asli atau alasan penolakan Bilcode. Maka penyebab spesifik POST historis tidak dapat dipastikan dari log tersebut. Jangan menyimpulkan deadline, harga, payload, ataupun Cloudflare sebagai penyebab tanpa respons pendukung.

Ada dua masalah yang terverifikasi secara terpisah:

1. Kode memperlakukan semua respons 403 sebagai kegagalan autentikasi, melakukan refresh, dan berpotensi menandai sesi Bilcode INVALID. Penolakan izin/bisnis tidak membuktikan token kedaluwarsa. Pengujian regresi mengonfirmasi bahwa 403 sekarang tidak merotasi token atau membatalkan sesi, sedangkan 401 tetap ditangani sebagai kegagalan autentikasi.
2. DNS container mewarisi satu upstream host, 8.8.8.8. Query langsung dari container ke resolver itu timeout untuk Bilcode dan Neon; 1.1.1.1 dan 9.9.9.9 berhasil. `dns.lookup` dan koneksi PostgreSQL mengalami EAI_AGAIN selama pemeriksaan, bersamaan dengan error jaringan/database pada log. Resolver container aktif diganti tanpa restart backend, dan Compose diperbarui untuk deployment berikutnya. Setelah perubahan, empat siklus monitoring berturut-turut pada 14:32–14:35 berhasil dan sesi Bilcode VALID.

Perbaikan kode mencatat tahap POST_BID/RECONCILE, HTTP status, kode mesin yang terbatas, field validasi yang dikenal, dan kode jaringan yang aman. Tidak ada cookie, token, proposal, ataupun body error mentah pada log diagnostik. Header Accept POST diselaraskan dengan dashboard Bilcode agar meminta JSON. Respons penolakan eksplisit ditandai FAILED, sedangkan hasil ambigu tetap UNKNOWN. Hanya `my-bids` dapat mengonfirmasi penerimaan.

Tidak ada bid nyata dikirim ulang selama investigasi. Proposal/status historis proyek 624 tidak dihapus atau diubah untuk memberi kesan berhasil. Perbaikan kode perlu masuk deployment sebelum dapat diamati pada konfirmasi proyek berikutnya. Pengujian API tiruan memverifikasi kontrak dan kegagalan; tidak membuktikan Bilcode akan menerima bid nyata berikutnya.
