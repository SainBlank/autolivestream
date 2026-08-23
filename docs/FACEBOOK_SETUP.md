# Panduan Setup Facebook Live (AutoLivestream v2.2)

Dokumen ini menjelaskan cara mengaktifkan fitur **auto livestream Facebook** dan **simulcast YouTube + Facebook**. Ikuti berurutan supaya tidak ada error saat instalasi.

---

## 1. Ringkasan Fitur

Setelah update ini, modal **New Stream** punya sampai 4 mode:

| Mode | Kapan muncul | Fungsi |
|------|--------------|--------|
| **Manual (RTMP)** | Selalu | Isi RTMP URL + stream key sendiri (semua platform) |
| **YouTube API** | Jika channel YouTube terhubung | Broadcast YouTube dibuat otomatis |
| **Facebook API** | Jika Facebook Page terhubung | Live video Facebook dibuat otomatis |
| **Both (Simulcast)** | Jika YouTube **dan** Facebook terhubung | Satu encode, dikirim ke dua platform sekaligus |

Jadi kamu bisa **live di salah satu platform saja**, atau **live di kedua platform sekaligus**.

---

## 2. Persiapan `.env`

Tambahkan/perbarui di file `.env`:

```env
# WAJIB: alamat publik aplikasi (tanpa slash di akhir)
BASE_URL=https://live.domainku.com

# Opsional
FB_GRAPH_VERSION=v21.0
TZ=Asia/Jakarta
```

> `BASE_URL` harus persis sama dengan alamat yang kamu pakai di browser. Kalau memakai IP + port, tulis `http://IP_VPS:7575`.

Lalu restart aplikasi:

```bash
pm2 restart autolivestream
```

---

## 3. Membuat Facebook App

1. Buka [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**.
2. Pilih use case **Other** → tipe **Business**.
3. Di dashboard app, tambahkan produk **Facebook Login** → **Settings**.
4. Pada **Valid OAuth Redirect URIs**, masukkan:

   ```
   https://live.domainku.com/auth/facebook/callback
   ```

   Nilai persisnya sudah ditampilkan otomatis di halaman **Settings → Integration** aplikasi (tinggal klik tombol copy).
5. Buka **App Settings → Basic**, salin **App ID** dan **App Secret**.
6. Pastikan permission berikut tersedia (Permissions and Features):
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `publish_video`

> **Mode Development:** selama app masih Development, hanya akun admin/developer app yang bisa dipakai. Untuk publik, ajukan **App Review** untuk permission di atas.

---

## 4. Menghubungkan Facebook Page

1. Login ke AutoLivestream → **Settings** → tab **Integration**.
2. Scroll ke kartu **Facebook Integration**.
3. Tempel **App ID** dan **App Secret** → klik **Save App Credentials**.
4. Klik **Add Page** → login Facebook → pilih Page yang ingin dipakai → izinkan permission.
5. Page akan muncul di daftar **Connected Pages**. Page pertama otomatis jadi **Default**.

Tombol yang tersedia per Page:
- ⭐ **Set as default** — dipakai otomatis saat membuat stream
- 🔗 **Disconnect** — lepas satu Page
- 🗑️ **Disconnect All Pages** — lepas semua Page

---

## 5. Membuat Stream

### Live hanya di Facebook
1. Klik **New Stream** → pilih mode **Facebook API**.
2. Pilih video, isi judul & deskripsi.
3. Pilih **Facebook Page** dan **Privacy** (`Public`, `Friends`, atau `Only me` untuk uji coba).
4. Klik **Create Stream**, lalu **Start**.

### Live di YouTube dan Facebook sekaligus
1. Klik **New Stream** → pilih mode **Both (Simulcast)**.
2. Pilih video, isi judul & deskripsi.
3. Pada **Stream Destinations**, centang **YouTube** dan/atau **Facebook**.
4. Pilih channel YouTube dan Facebook Page tujuan.
5. Klik **Create Stream**, lalu **Start**.

Video hanya di-encode **satu kali** lalu dibagi ke semua tujuan (FFmpeg `tee` muxer), jadi beban CPU hampir sama dengan live satu platform.

---

## 6. Catatan Teknis Penting

- **Bitrate dibatasi otomatis maksimal 4000 kbps** ketika Facebook menjadi salah satu tujuan. Ini mencegah stream ditolak atau patah karena melewati batas ingest Facebook.
- **Keyframe interval 2 detik** dan audio 44.1/48 kHz stereo diterapkan otomatis sesuai kebutuhan Facebook.
- Facebook memakai **RTMPS** (`rtmps://live-api-s.facebook.com:443/rtmp`). FFmpeg bundled sudah mendukung protokol ini.
- Live video Facebook otomatis **diakhiri** ketika stream dihentikan dari aplikasi.
- Token OAuth (user token & page token) disimpan **terenkripsi** di database.

---

## 7. Migrasi Database

Tidak ada langkah manual. Saat aplikasi dijalankan, migrasi berjalan otomatis dan bersifat **aditif + idempoten**:

- Tabel baru: `facebook_targets`, `stream_targets`
- Kolom baru pada `streams`, `users`, dan `stream_history`
- Data stream lama otomatis dipetakan ke `stream_targets`

Aman dijalankan berulang; database lama tidak akan rusak. Tetap disarankan backup:

```bash
cp db/streamfire.db db/streamfire.db.backup
```

---

## 8. Troubleshooting

| Masalah | Penyebab & Solusi |
|---------|-------------------|
| `URL Blocked` / `redirect_uri is not allowed` | Redirect URI di Facebook App tidak sama dengan `BASE_URL` + `/auth/facebook/callback`. Samakan persis (termasuk http/https dan port). |
| Tombol **Add Page** tidak bisa diklik | App ID/Secret belum disimpan. Simpan dulu credentials. |
| Tidak ada Page yang muncul setelah login | Akun tidak punya Page, atau tidak punya izin publish di Page tersebut. Buat Page atau minta role admin. |
| `Invalid OAuth access token` | Token kedaluwarsa atau password Facebook berganti. Disconnect Page lalu **Add Page** ulang. |
| Live jalan di YouTube tapi Facebook mati | Cek log stream. Umumnya bitrate terlalu tinggi atau permission `publish_video` belum disetujui. |
| Stream langsung berhenti | Jalankan `pm2 logs` untuk melihat error FFmpeg. Pastikan resolusi/fps video didukung. |

---

## 9. Endpoint Baru (referensi developer)

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| POST | `/api/settings/facebook-credentials` | Simpan App ID & Secret |
| GET | `/api/settings/facebook-status` | Status koneksi Facebook |
| GET | `/api/settings/facebook-pages` | Daftar Page terhubung |
| POST | `/api/settings/facebook-page/:id/default` | Set Page default |
| DELETE | `/api/settings/facebook-page/:id` | Disconnect satu Page |
| POST | `/api/settings/facebook-disconnect` | Disconnect semua Page |
| GET | `/auth/facebook` | Mulai OAuth |
| GET | `/auth/facebook/callback` | Callback OAuth |
| POST | `/api/streams/facebook` | Buat stream Facebook (API) |
| POST | `/api/streams/multi` | Buat stream multi-platform |

Format `targets` untuk `/api/streams/multi`:

```json
{
  "videoId": "...",
  "title": "Judul stream",
  "description": "Deskripsi",
  "targets": [
    { "platform": "youtube", "mode": "api", "channelId": "...", "privacy": "unlisted" },
    { "platform": "facebook", "mode": "api", "targetId": "...", "privacy": "EVERYONE" }
  ]
}
```

Target manual juga didukung: `{ "platform": "twitch", "mode": "manual", "rtmpUrl": "...", "streamKey": "..." }`.
