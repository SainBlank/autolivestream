# Changelog

Semua perubahan penting pada AutoLivestream akan didokumentasikan di file ini.

---

## v2.2 - Facebook Live & Multi-Platform

### ✨ Added
- **Facebook Live otomatis** via Graph API: hubungkan Facebook Page dari menu Settings → Integration, lalu buat stream tanpa copy-paste stream key
- **Mode Facebook API**: pilih Page tujuan, judul, deskripsi, dan privacy langsung dari modal pembuatan stream
- **Mode Simulcast (Both)**: satu video di-encode sekali lalu dikirim ke YouTube dan Facebook sekaligus menggunakan FFmpeg `tee` muxer
- **Pemilihan platform tunggal**: bebas live hanya di YouTube, hanya di Facebook, atau keduanya
- Multi-target per stream lewat tabel baru `stream_targets`, sehingga satu stream bisa punya banyak tujuan RTMP
- Manajemen Facebook Page: tambah Page, set Page default, disconnect satu Page, disconnect semua Page
- Kolom `platforms` pada riwayat stream agar terlihat platform mana saja yang dipakai
- Endpoint baru: `POST /api/streams/facebook`, `POST /api/streams/multi`, `GET|POST /api/settings/facebook-*`, `GET /auth/facebook`, `GET /auth/facebook/callback`

### 🚀 Improved
- Pembatas bitrate otomatis maksimal 4000 kbps saat Facebook menjadi salah satu tujuan, supaya stream tidak ditolak/patah
- Registry platform terpusat (`src/utils/platformRegistry.js`) untuk URL ingest, ikon, dan batas encoding tiap platform
- Token OAuth Facebook (user token & page token) disimpan terenkripsi
- Live video Facebook otomatis diakhiri saat stream dihentikan
- Migrasi database bersifat aditif dan idempoten, aman dijalankan berulang pada database lama

### 🔧 Notes
- Tambahkan `BASE_URL` dan (opsional) `FB_GRAPH_VERSION` pada file `.env`
- Redirect URI Facebook App harus sama dengan `BASE_URL` + `/auth/facebook/callback`
- Panduan lengkap: lihat `docs/FACEBOOK_SETUP.md`

---

## v2.1 - October 2, 2025

### ✨ Added
- Fitur playlist untuk streaming banyak video sekaligus
- Fitur multiple account untuk menggunakan banyak akun

### 🐛 Fixed
- Data tidak tampil saat pertama kali dijalankan

### 🚀 Improved
- Optimasi pengaturan FFmpeg
- Import Google Drive tanpa API
- Bulk upload video
- Penanganan upload video ukuran besar

---

## v2.0 - May 30, 2025

### ✨ Added
- User interface baru dan responsive
- Metode streaming baru yang lebih ringan
- Semua fitur diperbarui

### 🐛 Fixed
- Streaming berhenti sendiri
- Penjadwalan streaming sudah berfungsi

### 🚀 Improved
- Security login

---

## v1.1 - February 24, 2025

### ✨ Added
- Halaman galeri video
- Halaman pengaturan akun
- Fitur penjadwalan streaming
- Fitur reset password
- Opsi streaming portrait / landscape

### 🐛 Fixed
- Streaming berhenti sendiri

### 🚀 Improved
- Security login
- Rate limit login

---

## v1.0 - February 6, 2025

### ✨ Added
- Halaman setup akun
- Halaman login
- Halaman history
- Pengaturan akun

### 🐛 Fixed
- Streaming hilang jika dibuka di browser berbeda
- Streaming berhenti sendiri

### 🚀 Improved
- Pembaruan tampilan aplikasi
