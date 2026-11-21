# Humanizer-zh pada proposal Bilcode

Panduan gaya di `src/proposal-style.ts` mengadaptasi [Humanizer-zh](https://github.com/op7418/Humanizer-zh) ke proposal pekerjaan berbahasa Indonesia. Sumber ditinjau pada commit [`f4518a8eab97b8bfebc66a89d34320a89bef6930`](https://github.com/op7418/Humanizer-zh/blob/f4518a8eab97b8bfebc66a89d34320a89bef6930/SKILL.md), revisi panduan 2026-09-23. Lisensi MIT upstream disertakan pada `LICENSE` dan disalin ke image runtime.

Ini adaptasi untuk aplikasi, bukan instalasi skill ke Codex atau Claude. Backend mengirim panduan yang dikompilasi bersama kode sebagai bagian dari system prompt Vikey. Tidak ada pengambilan file GitHub ketika request berjalan, perubahan dependensi, atau panggilan AI kedua. Pembaruan upstream harus ditinjau sebelum diadopsi; tidak diterapkan otomatis.

Aturan lintas bahasa dari kelompok A–E digunakan untuk mengurangi pembuka kosong, ritme template, promosi berlebihan, format dekoratif, dan sisa percakapan asisten. Kelompok F yang khusus Mandarin tidak diterjemahkan harfiah; padanannya berupa kata kerja langsung, kalimat yang tidak bertumpuk, penghubung yang tepat, dan pengurangan penutup kosong dalam bahasa Indonesia. Aturan pelestarian fakta dan tingkat kepastian selalu lebih tinggi daripada perubahan gaya. Format fitur dengan tanda pisah dan istilah teknologi tetap dipertahankan.

Generator menyusun isi kemudian menyunting gaya dalam satu respons. Hanya JSON akhir yang dikembalikan, dan validator backend tetap memeriksa struktur, durasi, serta nilai penawaran. Tidak ada pemeriksaan atau jaminan lolos detektor AI. Karena pengujian memakai model tiruan, hasil gaya model sebenarnya tetap perlu dinilai pada pemakaian nyata; tes hanya memastikan panduan dikirim dan kontrak pengajuan terjaga.
