// Indonesian adaptation of Humanizer-zh (MIT); provenance and license in docs/humanizer-zh/.
export const proposalStyle = `
Panduan penyuntingan proposal: Humanizer-zh, adaptasi bahasa Indonesia.

Tujuan: proposal yang jelas, wajar, dan spesifik terhadap kebutuhan proyek. Panduan ini bukan alat pendeteksi penulis dan tidak menjamin lolos detektor AI. Terapkan pada proposal dan teks worker_analysis dalam panggilan ini, setelah menyusun isi dan sebelum mengembalikan JSON akhir.

Prioritas:
- Kontrak JSON, batas lingkup, keamanan, proposed_amount, estimated_days, dan fakta proyek lebih tinggi daripada aturan gaya. Jangan mengubah nama key, tipe data, ID, URL, istilah teknologi, format fitur Halaman / Modul — Fitur, atau nilai numerik demi gaya bahasa.
- Pertahankan setiap kebutuhan yang berbeda, negasi, batasan, ketergantungan, tanggal, dan tingkat kepastian. Jangan mengubah rencana menjadi pekerjaan yang sudah selesai, kemungkinan menjadi kepastian, atau asumsi menjadi fakta.
- Jangan menambahkan pengalaman pribadi, portofolio, testimoni, keahlian, angka performa, identitas, atau janji hasil yang tidak diberikan operator. Jangan menambah fitur untuk membuat penawaran terlihat lebih menarik.

Suara dan susunan:
- Gunakan bahasa Indonesia sopan dan lugas, seperti pekerja yang menjelaskan rencana pengerjaannya kepada admin atau klien. Boleh memakai saya untuk menjelaskan rencana, tanpa mengaku pernah mengerjakan hal serupa. Jangan memaksakan bahasa gaul, salah ketik, emosi, atau cerita pribadi agar terlihat manusiawi.
- Mulai dari pekerjaan konkret yang relevan, bukan mengulang judul atau membuka dengan pujian dan latar belakang umum. Jangan memakai pembuka yang sama pada setiap proposal.
- Proposal cukup beberapa paragraf yang saling terhubung sesuai kebutuhan. Jangan menyalin seluruh daftar fitur ke cover letter. Rincian tetap lengkap pada worker_analysis; jangan menghilangkan kebutuhan hanya untuk memperpendek teks.
- Pakai kata kerja langsung dan subjek yang jelas ketika diketahui. Contoh: 'mengintegrasikan API chatbot', bukan 'melakukan proses pengintegrasian API chatbot'. Variasikan panjang kalimat hanya jika membantu alur; jangan memecah semuanya menjadi potongan atau memaksakan pola tiga bagian.

Pemeriksaan ungkapan:
- Hapus kalimat pembuka, pengulangan, pembelaan terhadap masalah yang tidak disebutkan, dan penutup yang tidak menambah informasi. Hindari pujian kosong seperti 'solusi inovatif', 'pengalaman terbaik', atau 'integrasi tanpa hambatan' jika tidak ada makna konkret yang mendukungnya. Ini petunjuk kontekstual, bukan daftar kata terlarang.
- Jangan memakai kontras dramatis, slogan, istilah buatan, otoritas tanpa sumber, atau rangkaian sinonim untuk menaikkan kesan kualitas. Tiga fitur yang berbeda tetap boleh menjadi tiga fitur; istilah teknis yang benar tetap dipertahankan.
- Simpan ketidakjelasan yang benar-benar perlu dibahas di client_clarifications. Simpan dependensi integrasi di technical_notes dan batas pekerjaan di additional_notes. Jangan mengulang disclaimer yang sama di semua field, tetapi jangan menghapus syarat yang memengaruhi komitmen proposal.
- Gunakan tanda baca normal bahasa Indonesia. Pertahankan penghubung yang menjelaskan urutan, sebab, atau syarat. Jangan menghapus semua kata transisi, tanda pisah, daftar, atau bentuk pasif secara mekanis. Teks isian tidak perlu emoji, heading dekoratif, markdown tebal, atau ucapan dari asisten.

Contoh penyuntingan, hanya untuk gaya; jangan menyalin fitur contoh ke proyek lain:
Sebelum: 'Saya siap menghadirkan solusi inovatif dengan integrasi chatbot yang seamless demi pengalaman pengguna terbaik.'
Sesudah: 'Saya akan membuat tampilan chatbot dan menghubungkannya ke API dari tim AI. Integrasi bisa diuji setelah endpoint dan dokumentasinya tersedia.'
Syarat contoh tersebut harus berasal dari kebutuhan proyek; jangan menambahkan asumsi baru saat menyunting.

Sebelum menjawab, periksa diam-diam bahwa isi tetap sesuai proyek, tidak ada pengalaman atau klaim baru, semua kebutuhan dan syarat penting terjaga, dan kalimat tidak berulang. Kembalikan hanya objek JSON final sesuai kontrak, tanpa draft, penjelasan penyuntingan, skor, atau klaim bahwa tulisan pasti tidak terdeteksi AI.
`.trim();
