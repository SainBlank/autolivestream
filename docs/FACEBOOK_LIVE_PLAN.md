# RENCANA IMPLEMENTASI: Auto Live Facebook + Multi-Platform (YouTube & Facebook)

Dokumen ini adalah rencana teknis mendalam (blueprint) untuk menambahkan **Auto Live Streaming Facebook** ke AutoLivestream, sekaligus menambahkan **opsi tujuan streaming**: hanya YouTube, hanya Facebook, atau **kedua platform sekaligus (simulcast)**, plus mode **bergantian (alternate)**.

Target utama: **tidak ada error saat instalasi di VPS** (`install.sh`, Docker, `npm install`) dan **tidak merusak database / fitur lama** (backward compatible 100%).

---

## 1. HASIL AUDIT KODE SAAT INI

### 1.1 Peta arsitektur yang relevan

| Lapisan | File | Peran saat ini |
|---|---|---|
| Entry | `app.js` | Express + socket.io, init `autoSchedulerService`, `streamingService`, `rotationService` |
| Skema DB | `db/database.js` | Satu-satunya sumber skema. Pola migrasi = `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN` yang error-nya diabaikan bila `duplicate column name` |
| Alias DB | `src/models/database.js` | Delegasi ke `db/database.js` (handle sqlite3 mentah) |
| Model | `src/models/Stream.js` | CRUD tabel `streams`; kolom YouTube API di-hardcode di `create()` (daftar 29 kolom) |
| Model | `src/models/YoutubeChannel.js` | Multi-channel YouTube (token terenkripsi, `is_default`) |
| Service | `src/services/streamingService.js` (1322 baris) | Inti FFmpeg: `buildFFmpegArgs`, `buildFFmpegArgsForPlaylist`, `startStream`, `stopStream`, retry/backoff, health check, `saveStreamHistory` |
| Service | `src/services/youtubeService.js` | `createYouTubeBroadcast()` (liveBroadcasts.insert → liveStreams.insert → bind), monetisasi, thumbnail, transition |
| Service | `src/services/autoSchedulerService.js` | Polling 15s stream `scheduled` → `startStream`; polling 30s untuk `end_time` |
| Service | `src/services/rotationService.js` | Rotasi konten (khusus YouTube API saat ini) |
| Route | `src/routes/mainRoutes.js` (2953 baris) | `POST /api/streams` (manual RTMP), `POST /api/streams/youtube` (YouTube API), `PUT /api/streams/:id`, `POST /api/streams/:id/status`, OAuth `/auth/youtube` + callback, settings YouTube |
| UI | `src/views/dashboard.ejs` (4323 baris) | Modal create/edit dengan 2 tab: **Manual** (dropdown platform → RTMP URL) dan **YouTube API** |
| UI | `src/views/settings.ejs` | Form Client ID/Secret + daftar channel YouTube |
| Util | `src/utils/encryption.js` | AES-256-GCM, kunci turunan dari `SESSION_SECRET` |
| Util | `src/utils/helpers.js` | `getPlatformIcon`, `getPlatformColor` |

### 1.2 Temuan penting (yang menentukan desain)

1. **Satu stream = satu tujuan.** Tabel `streams` hanya punya satu `rtmp_url` + `stream_key`, dan `buildFFmpegArgs()` menghasilkan **satu output** `-f flv <rtmpUrl>` (baris ~406 dan ~608). Jadi simulcast **tidak mungkin** tanpa perubahan struktural.
2. **Facebook sudah dikenali sebagai label saja.** Di `POST /api/streams` sudah ada deteksi `rtmpUrl.includes('facebook.com')` → `platform = 'Facebook'`. Artinya *manual* RTMP Facebook sudah bisa; yang belum ada adalah **otomatisasi via Graph API** (bikin live video, ambil stream key, judul/deskripsi, end live).
3. **Copy mode (tanpa re-encode) divalidasi khusus YouTube** (`YOUTUBE_COPY_ALLOWED_VIDEO_CODECS`, `isSupportedYouTubePixelFormat`, `validateCopyModeCompatibility`). Facebook punya syarat lebih ketat (lihat §3.4) → butuh validator sendiri, kalau tidak stream akan gagal/di-reject Facebook.
4. **`Stream.create()` menulis kolom secara eksplisit** → setiap kolom baru **wajib** ditambahkan di `db/database.js` (ALTER) *dan* di `Stream.create()`, kalau tidak nilainya hilang tanpa error.
5. **FFmpeg wajib mendukung `rtmps`** karena Facebook hanya menerima `rtmps://live-api-s.facebook.com:443/rtmp/`. Sudah diverifikasi: build `@ffmpeg-installer/ffmpeg` dan ffmpeg sistem mendukung protokol `rtmps` (hasil `ffmpeg -protocols`). Tetap perlu **preflight check** agar user tahu lebih awal jika ffmpeg-nya tanpa TLS.
6. **Tidak ada dependency baru yang dibutuhkan**: `axios@^1.8.1` sudah ada di `package.json` → Graph API cukup pakai `axios`. **Tidak** memakai `facebook-nodejs-business-sdk` (berat + risiko install gagal di VPS). Ini poin kunci "anti-error saat instalasi".
7. **Retry/health-check per stream** memakai `Map` ber-key `streamId` (satu proses FFmpeg per stream). Desain simulcast harus tetap **satu proses FFmpeg per stream row** agar semua logika retry, `syncStreamStatuses`, `healthCheckStreams`, `stopStream`, dan `saveStreamHistory` tetap jalan tanpa ditulis ulang → **gunakan muxer `tee`**.
8. `stream_history` menyimpan `platform` sebagai TEXT → simulcast bisa dicatat `"YouTube + Facebook"` tanpa migrasi tambahan (aman).
9. `.env.example` masih menyebut `DB_PATH=./db/streamfire.db` (warisan lama, tidak dipakai). Akan dirapikan sekalian + tambah variabel Facebook opsional.

---

## 2. RUANG LINGKUP FITUR (SCOPE)

### 2.1 Yang akan dibangun

**A. Facebook Live otomatis (Graph API)**
- Hubungkan akun Facebook via OAuth (Facebook Login), simpan token terenkripsi.
- Pilih tujuan: **Page**, **Profil pribadi**, atau **Group** (Page = paling stabil untuk API).
- Multi-target seperti multi-channel YouTube: tabel `facebook_targets` (analog `youtube_channels`), ada `is_default`.
- Saat stream start: `POST /{target-id}/live_videos` → dapat `secure_stream_url` (rtmps + key) → simpan → FFmpeg push.
- Saat stop: `POST /{live_video_id}` dengan `end_live_video=true`.
- Metadata: title, description, privacy (`SELF`/`FRIENDS`/`EVERYONE` untuk profil), status (`LIVE_NOW` / `SCHEDULED_UNPUBLISHED`), `stream_type=REGULAR`.
- Fallback **Manual Facebook**: user tempel Persistent Stream Key sendiri (tanpa OAuth, tanpa App Review). **Ini jalur default yang selalu bekerja.**

**B. Opsi tujuan streaming (inti permintaan)**

| Mode | Nilai kolom `stream_mode` | Perilaku |
|---|---|---|
| Satu platform (YouTube) | `single` + target YouTube saja | Seperti sekarang |
| Satu platform (Facebook) | `single` + target Facebook saja | Baru |
| **Keduanya sekaligus** | `simulcast` | 1 proses FFmpeg, output `tee` ke 2 RTMP; 1x baca disk, 1x encode → hemat CPU |
| **Bergantian** | `alternate` | Live ke platform A selama N menit → stop → live ke platform B selama N menit → ulang (loop) selama masih dalam jendela jadwal |

**C. UI**
- Tab modal jadi: `Manual RTMP` | `YouTube API` | `Facebook API` | **`Multi-Platform`**.
- Di tab Multi-Platform: checkbox YouTube + checkbox Facebook, pilih channel/page, pilih mode `Bersamaan`/`Bergantian`, interval bergantian.
- Badge platform di tabel/kartu dashboard mendukung banyak platform (chip ganda + indikator status per target).
- Halaman Settings: kartu "Facebook Integration" (App ID/Secret, tombol Connect, daftar Page/akun, tombol default/hapus) meniru pola YouTube agar konsisten.

### 2.2 Non-goal (agar tidak melebar & tidak berisiko)
- Tidak mengubah alur upload/gallery/playlist.
- Tidak mengubah `rotationService` selain menambah kompatibilitas Facebook opsional (fase 5, terpisah).
- Tidak menambah dependency npm baru sama sekali.
- Tidak mengubah struktur tabel lama secara destruktif (tidak ada DROP/RENAME kolom).

---

## 3. DESAIN TEKNIS RINCI

### 3.1 Perubahan skema database (aditif & idempoten)

Semua di `db/database.js`, mengikuti pola yang sudah ada (abaikan error `duplicate column name`).

**Tabel baru 1 — `facebook_targets`** (analog `youtube_channels`):
```sql
CREATE TABLE IF NOT EXISTS facebook_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_type TEXT DEFAULT 'page',      -- page | user | group
  target_id TEXT NOT NULL,              -- page id / user id / group id
  target_name TEXT,
  target_thumbnail TEXT,
  follower_count TEXT DEFAULT '0',
  access_token TEXT,                    -- terenkripsi (page/long-lived token)
  token_expires_at TIMESTAMP,
  is_default INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**Tabel baru 2 — `stream_targets`** (kunci simulcast; 1 stream → N tujuan):
```sql
CREATE TABLE IF NOT EXISTS stream_targets (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  platform TEXT NOT NULL,               -- youtube | facebook | custom
  platform_icon TEXT,
  mode TEXT DEFAULT 'manual',           -- manual | api
  rtmp_url TEXT,
  stream_key TEXT,                      -- terenkripsi bila berasal dari API
  is_enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'idle',           -- idle | starting | live | error | ended
  last_error TEXT,
  order_index INTEGER DEFAULT 0,        -- urutan untuk mode alternate
  -- referensi akun
  youtube_channel_id TEXT,
  facebook_target_id TEXT,
  -- artefak API
  youtube_broadcast_id TEXT,
  youtube_stream_id TEXT,
  facebook_live_video_id TEXT,
  facebook_permalink TEXT,
  -- metadata per platform
  title TEXT, description TEXT, privacy TEXT, tags TEXT, category TEXT,
  thumbnail_path TEXT, monetization INTEGER DEFAULT 0,
  started_at TIMESTAMP, ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stream_targets_stream ON stream_targets(stream_id);
```

**Kolom baru di `streams`** (semua `ALTER TABLE ... ADD COLUMN`, nilai default menjaga perilaku lama):
```
stream_mode              TEXT DEFAULT 'single'   -- single | simulcast | alternate
alternate_interval_min   INTEGER DEFAULT 60
alternate_active_index   INTEGER DEFAULT 0
is_multi_platform        INTEGER DEFAULT 0
is_facebook_api          INTEGER DEFAULT 0
facebook_target_id       TEXT
facebook_live_video_id   TEXT
facebook_description     TEXT
facebook_privacy         TEXT
facebook_permalink       TEXT
facebook_stream_url      TEXT
```

**Kolom baru di `users`**: `facebook_app_id TEXT`, `facebook_app_secret TEXT` (terenkripsi), `facebook_redirect_uri TEXT`, `facebook_user_token TEXT` (terenkripsi).

**Kolom baru di `stream_history`**: `platforms TEXT` (mis. `"YouTube,Facebook"`) — kolom `platform` lama tetap diisi untuk kompatibilitas tampilan.

> **Aturan anti-error:** kolom `streams.rtmp_url` & `stream_key` **tetap NOT NULL** dan selalu diisi dengan **target primer** (target pertama yang aktif). Semua kode lama (history, dashboard, rotation) terus bekerja tanpa diubah.

**Backfill (idempoten, dijalankan sekali di `createTables()` setelah ALTER):** untuk setiap baris `streams` yang belum punya baris di `stream_targets`, buat 1 baris target dari `platform/rtmp_url/stream_key/youtube_*` yang ada. Jadi data user lama otomatis ikut model baru.

### 3.2 Modul baru

```
src/models/FacebookTarget.js      # CRUD facebook_targets (pola YoutubeChannel.js)
src/models/StreamTarget.js        # CRUD stream_targets + helper findByStream/primary/enabled
src/services/facebookService.js   # Graph API: OAuth, list pages, createLiveVideo, endLiveVideo, poll status
src/services/platformRegistry.js  # metadata per platform: rtmp default, batas bitrate/GOP, validator copy-mode
src/services/simulcastService.js  # orkestrasi target: prepare(), buildOutputs(), finalize(), alternate switching
docs/FACEBOOK_SETUP.md            # panduan buat Facebook App + izin (untuk user)
docs/FACEBOOK_LIVE_PLAN.md        # dokumen ini
```

### 3.3 `facebookService.js` — kontrak fungsi

Graph API versi dipin ke `v21.0` lewat konstanta `FB_API_VERSION` (bisa dioverride `.env`: `FB_GRAPH_VERSION`).

| Fungsi | Endpoint Graph | Catatan |
|---|---|---|
| `getAuthUrl(appId, redirectUri, state)` | `https://www.facebook.com/v21.0/dialog/oauth` | scope: `public_profile,pages_show_list,pages_read_engagement,pages_manage_posts,publish_video` |
| `exchangeCode(appId, appSecret, redirectUri, code)` | `GET /v21.0/oauth/access_token` | dapat short-lived user token |
| `getLongLivedUserToken(...)` | `GET /oauth/access_token?grant_type=fb_exchange_token` | ~60 hari |
| `listPages(userToken)` | `GET /me/accounts?fields=id,name,access_token,picture,followers_count` | page token = tidak kedaluwarsa selama app aktif |
| `getMe(userToken)` | `GET /me?fields=id,name,picture` | untuk target profil pribadi |
| `createLiveVideo({targetId, token, title, description, privacy, scheduled})` | `POST /{targetId}/live_videos` | body: `status=LIVE_NOW`/`SCHEDULED_UNPUBLISHED`, `title`, `description`, `stream_type=REGULAR`; respons: `id`, `stream_url`, `secure_stream_url`, `permalink_url` |
| `parseIngest(secureStreamUrl)` | – | pisah jadi `rtmp_url` (`rtmps://live-api-s.facebook.com:443/rtmp`) + `stream_key` |
| `getLiveVideoStatus(liveVideoId, token)` | `GET /{id}?fields=status,live_status,permalink_url` | untuk sinkron status di UI |
| `endLiveVideo(liveVideoId, token)` | `POST /{id}` body `end_live_video=true` | dipanggil di `stopStream` |
| `validateToken(token, appId, appSecret)` | `GET /debug_token` | dipakai di halaman Settings untuk tampilkan masa berlaku |

Penanganan error: semua respons Graph dinormalisasi ke `{ ok, data, error: { code, subcode, message, userMessage } }`; `userMessage` dipetakan ke pesan Bahasa Indonesia yang jelas (mis. code 190 → "Token Facebook kedaluwarsa, hubungkan ulang di Settings"). Retry 3x dengan backoff hanya untuk error transient (HTTP 5xx / code 1, 2, 4, 17, 341 rate-limit).

### 3.4 Aturan encoder Facebook (mencegah stream ditolak)

Ditanam di `platformRegistry.js`:

| Parameter | YouTube (sekarang) | Facebook (baru) |
|---|---|---|
| Protokol | `rtmp/rtmps` | **wajib `rtmps` port 443** |
| Codec video | h264 | h264 **saja** |
| Profile | high | high, level ≤ 4.1 |
| Pixel format | yuv420p / yuvj420p | yuv420p **saja** |
| Keyframe (GOP) | 2s (`-g fps*2`) | **≤ 2s, wajib** (`-g fps*2 -keyint_min fps -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*2)`) |
| Resolusi maks | 1080p+ | 1920x1080 (API), 720p disarankan |
| Bitrate video | fleksibel | ≤ 4000 kbps (cap otomatis + peringatan UI) |
| Codec audio | aac / mp3 | **aac saja** |
| Sample rate audio | 44.1k ok | **48 kHz**, stereo, ≤ 128 kbps |
| Durasi | panjang | **maks 8 jam** per live video (auto-restart opsional bila `end_time` lebih panjang) |

**Konsekuensi penting untuk copy-mode:** validator Facebook (`validateFacebookCopyProbe`) menolak copy bila codec audio bukan aac, sample rate ≠ 48000, atau GOP video tidak terdeteksi ≤ 2s (kita tidak bisa mengubah GOP saat `-c:v copy`). Perilaku default yang dipilih: **jika target Facebook aktif dan media tidak lolos validasi, otomatis aktifkan transcode audio saja** (`-c:v copy -c:a aac -ar 48000 -b:a 128k`) — murah CPU dan menyelamatkan 90% kasus. Jika video pun tidak lolos (GOP > 2s / bukan h264), tampilkan opsi "aktifkan Advanced Settings (re-encode)" dengan pesan jelas, tidak silent-fail.

### 3.5 Cara simulcast di FFmpeg (keputusan arsitektur)

**Dipilih: muxer `tee` (satu proses FFmpeg, satu encode, N output).**

Contoh (advanced/re-encode):
```
... -c:v libx264 ... -c:a aac -ar 48000 \
-f tee -map 0:v -map 0:a \
"[f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmp://a.rtmp.youtube.com/live2/KEY_YT|
 [f=flv:onfail=ignore:flvflags=no_duration_filesize]rtmps://live-api-s.facebook.com:443/rtmp/KEY_FB"
```
Contoh (copy-mode + audio fix):
```
... -c:v copy -c:a aac -ar 48000 -b:a 128k -bsf:v h264_mp4toannexb -f tee ...
```

Alasan memilih `tee`:
- **Hemat CPU/disk**: satu decode + satu encode untuk 2 platform (penting di VPS 1 core / 1 GB RAM sesuai README).
- **Kompatibel penuh** dengan `activeStreams` Map, retry, health check, `stopStream` yang semuanya ber-key `streamId` → hampir tidak ada perubahan pada logika proses.
- `onfail=ignore` menjaga stream tetap jalan jika satu platform putus (tidak menjatuhkan yang lain).

Risiko & mitigasi:
- Karakter khusus di URL/key harus di-escape (`\`, `|`, `[`, `]`) → helper `escapeTeeTarget()` + unit test.
- Jika satu output gagal permanen sedangkan yang lain hidup, FFmpeg tidak exit → kita deteksi dari log stderr per-URL dan set `stream_targets.status='error'` + tampilkan di UI (log parser sudah ada, cukup ditambah pola).
- Alternatif tersedia (`SIMULCAST_STRATEGY=process-per-target` di `.env`) yang menjalankan proses FFmpeg terpisah per target jika suatu saat dibutuhkan isolasi penuh; diimplementasikan di belakang flag, default `tee`.

### 3.6 Mode "bergantian" (alternate)

- Field: `stream_mode='alternate'`, `alternate_interval_min` (default 60), `alternate_active_index`.
- Diorkestrasi di `autoSchedulerService` (menambah interval baru `ALTERNATE_CHECK_INTERVAL = 30s`, tidak mengubah interval lama):
  1. Saat start, ambil target `is_enabled=1` urut `order_index`, mulai index `alternate_active_index`.
  2. Jika `now - started_at >= alternate_interval_min`, lakukan `switchTarget()`: hentikan FFmpeg (graceful, `manuallyStoppingStreams`), akhiri live video platform lama (`endLiveVideo` / YouTube `transition complete` jika mode API), naikkan index (wrap-around), simpan, lalu `startStream()` lagi.
  3. Status stream tetap `live` selama pergantian (ada state transisi `switching` di log + socket event agar UI tidak berkedip "offline").
- Gap antar-switch dapat dikonfigurasi (`alternate_gap_seconds`, default 5) agar platform punya waktu menutup sesi.

### 3.7 Perubahan pada `streamingService.js` (bedah minimal, berisiko rendah)

1. `buildFFmpegArgs()` / `buildFFmpegArgsForPlaylist()`: pisahkan bagian **input+encoder** dari bagian **output**. Fungsi baru `buildOutputArgs(stream, targets)` yang mengembalikan `['-f','flv',url]` (1 target, perilaku lama identik) atau `['-f','tee', teeSpec]` (≥2 target). **Ini satu-satunya perubahan pada pembentukan argumen** → jika hanya 1 target, byte-per-byte sama seperti sekarang (aman untuk regresi).
2. `startStream()`: sebelum spawn, panggil `simulcastService.prepareTargets(streamId, baseUrl)` yang:
   - memanggil `youtubeService.createYouTubeBroadcast()` untuk target YouTube API (kode lama dipakai ulang, tetap ada `is_youtube_api` untuk kompatibilitas),
   - memanggil `facebookService.createLiveVideo()` untuk target Facebook API,
   - menulis `rtmp_url/stream_key` ke `stream_targets` dan menyalin target primer ke `streams` (kompatibilitas),
   - mengembalikan daftar target siap-pakai; jika **sebagian** gagal → lanjut dengan yang berhasil + log peringatan; jika **semua** gagal → `{success:false}` seperti sekarang.
3. `stopStream()`: setelah proses mati, panggil `simulcastService.finalizeTargets(streamId)` → `endLiveVideo` (FB) + `transition('complete')` (YT, jika sudah ada di kode) + set status target.
4. `validateCopyModeCompatibility()`: dijadikan multi-platform — jalankan validator per target dari `platformRegistry`, gabungkan hasil; tambahkan auto-fix audio (§3.4).
5. `saveStreamHistory()`: isi `platforms` dari daftar target.
6. Preflight baru `assertProtocolSupport(targets)`: jika ada target `rtmps` dan `ffmpeg -protocols` tidak memuat `rtmps`, kembalikan error yang menjelaskan cara memperbaiki (install ffmpeg sistem). Dijalankan sekali dan di-cache.

### 3.8 API endpoint baru/berubah

| Method & path | Fungsi |
|---|---|
| `GET /auth/facebook` | Mulai OAuth (butuh App ID/Secret tersimpan) |
| `GET /auth/facebook/callback` | Tukar code → token panjang → simpan pages ke `facebook_targets` |
| `POST /api/settings/facebook-credentials` | Simpan App ID/Secret (secret dienkripsi) |
| `GET /api/settings/facebook-status` | Status koneksi + masa berlaku token |
| `GET /api/settings/facebook-targets` | Daftar page/akun |
| `POST /api/settings/facebook-target/:id/default` | Set default |
| `DELETE /api/settings/facebook-target/:id` | Hapus target |
| `POST /api/settings/facebook-disconnect` | Hapus semua target |
| `POST /api/streams/facebook` | Buat stream Facebook API (mirror `POST /api/streams/youtube`) |
| `POST /api/streams/multi` | Buat stream multi-platform: body `{ mode: 'simulcast'\|'alternate', targets: [...] }` |
| `GET /api/streams/:id/targets` | Status tiap target (untuk UI live) |
| `PUT /api/streams/:id` | Diperluas: sinkronisasi `stream_targets` (tambah/hapus/ubah target) |

Semua endpoint baru memakai `isAuthenticated` + CSRF (`provideCsrfToken` sudah global) dan `express-validator` seperti pola existing. Endpoint lama **tidak diubah kontraknya** (hanya ditambah field opsional) agar front-end lama tetap jalan.

### 3.9 Perubahan UI

- `dashboard.ejs`: tambah tab `Facebook API` dan `Multi-Platform` (create & edit), reuse komponen pemilih video/playlist yang sudah ada (`loadYoutubeVideos` di-generalisasi menjadi `loadStreamVideos(scope)` supaya tidak duplikasi 200 baris).
- Dropdown platform manual: tambah entri **Facebook** (`rtmps://live-api-s.facebook.com:443/rtmp`) yang saat ini belum ada di daftar (padahal deteksi label sudah ada di backend).
- Chip platform ganda + badge status per target (hijau/merah) di tabel desktop & kartu mobile.
- `settings.ejs`: kartu "Facebook Integration" + panduan langkah-langkah pembuatan App (link ke `docs/FACEBOOK_SETUP.md`).
- `helpers.js`: `getPlatformIcon('facebook') → 'facebook'`, `getPlatformColor('facebook') → 'blue-500'`, plus helper `getPlatformsList(stream)`.
- Locale `src/locales/en.json` & `id.json`: tambah key baru (middleware i18n saat ini dinonaktifkan di `app.js`, jadi ini hanya persiapan, tidak mengubah runtime).

---

## 4. STRATEGI "ANTI-ERROR SAAT INSTALASI"

Ini bagian yang paling kamu tekankan. Langkah konkret:

1. **Nol dependency baru.** Hanya `axios` + `crypto` bawaan. `package.json` tidak berubah → `npm install` di VPS tidak punya permukaan error baru (tidak ada modul native tambahan yang harus di-build).
2. **Migrasi DB aditif & idempoten.** Hanya `CREATE TABLE IF NOT EXISTS` dan `ALTER TABLE ADD COLUMN` dengan penanganan `duplicate column name`, sama seperti 20+ migrasi yang sudah ada. Aman dijalankan berulang, aman untuk `database.sqlite`/`autolivestream.db` lama. **Tidak ada** DROP/RENAME/NOT NULL baru.
3. **Kompatibilitas mundur data.** Backfill otomatis membuat `stream_targets` untuk stream lama; kolom `streams.rtmp_url`, `stream_key`, `platform`, `is_youtube_api` tetap diisi → semua view/route lama tetap benar.
4. **Preflight runtime check** saat boot (`app.js`): cek ffmpeg ada, cek dukungan `rtmps`, cek `SESSION_SECRET` (karena kunci enkripsi token diturunkan darinya — jika berubah, token lama tidak bisa didekripsi → tampilkan peringatan, bukan crash).
5. **Semua fitur Facebook opsional.** Tanpa App ID/Secret, aplikasi berjalan normal; tab Facebook API menampilkan panduan, tab Manual RTMP Facebook tetap berfungsi penuh. Tidak ada env var wajib baru.
6. **Syntax gate.** Sebelum commit: `node --check` untuk **setiap** file `.js` yang disentuh + render-check semua `.ejs` (compile via `ejs.compile`) + boot test aplikasi headless (`PORT=7599 node app.js` lalu smoke-test HTTP + `SIGTERM`).
7. **DB migration test.** Uji dua skenario: (a) DB kosong/baru, (b) salinan `database.sqlite` lama yang ada di repo → pastikan skema akhir identik dan tidak ada error.
8. **`install.sh` & Docker**: tidak butuh paket OS baru; hanya menambah pesan info bahwa ffmpeg harus punya TLS (ffmpeg dari apt sudah punya). `Dockerfile` diperiksa agar ffmpeg-nya mendukung rtmps.
9. **Dokumentasi + CHANGELOG** diperbarui agar orang lain yang meng-clone repo tidak salah setup.
10. **Rollback mudah**: seluruh fitur berada di file baru + patch kecil terisolasi; ada catatan cara menonaktifkan (`ALTER` tidak perlu dibatalkan, cukup jangan pakai tab Multi-Platform).

---

## 5. RENCANA EKSEKUSI BERTAHAP (setiap fase bisa di-commit & diuji terpisah)

| Fase | Isi | Uji |
|---|---|---|
| **F0** | Baseline: catat `node --check` semua file, backup DB contoh, buat branch `feat/facebook-live-multiplatform` | boot app OK |
| **F1** | Skema DB: tabel `facebook_targets`, `stream_targets`, kolom baru, backfill | uji DB baru & DB lama |
| **F2** | Model `FacebookTarget.js`, `StreamTarget.js`; `Stream.create/update` mendukung kolom baru | unit test CRUD via skrip node |
| **F3** | `platformRegistry.js` + refactor `buildOutputArgs()` + validator copy-mode multi-platform | snapshot test: argumen FFmpeg 1 target = identik dengan versi lama |
| **F4** | `facebookService.js` (Graph API) + manual RTMP Facebook di dropdown | mock HTTP test; live test manual dengan Persistent Key milikmu |
| **F5** | `simulcastService.js` + integrasi `startStream/stopStream` (mode `simulcast`) | test lokal ke 2 endpoint RTMP dummy (nginx-rtmp/ffmpeg listener) |
| **F6** | Mode `alternate` di `autoSchedulerService` | test interval pendek (2 menit) |
| **F7** | Endpoint API baru (`/api/streams/facebook`, `/api/streams/multi`, settings FB, OAuth) | test curl end-to-end |
| **F8** | UI: dashboard tab baru, settings Facebook, chip multi-platform, helpers, locales | render test EJS + klik-through manual |
| **F9** | Dokumentasi: `README.md`, `docs/FACEBOOK_SETUP.md`, `CHANGELOG.md`, `.env.example` | review |
| **F10** | QA menyeluruh + paket ZIP siap-GitHub + ringkasan commit | regresi penuh |

---

## 6. RENCANA PENGUJIAN

**Statis:** `node --check` semua file; kompilasi semua EJS; grep untuk pemanggilan fungsi yang tidak ada.

**DB:** skenario fresh vs upgrade; verifikasi `PRAGMA table_info` untuk `streams`, `stream_targets`, `facebook_targets`; verifikasi backfill.

**Unit (skrip node, tanpa framework baru):**
- `escapeTeeTarget()` dengan URL/key berkarakter aneh.
- `buildOutputArgs()` 1 target vs 2 target (snapshot).
- Validator copy-mode: matriks probe (h264/aac48k → lolos; h264/mp3 → auto-fix audio; hevc → minta advanced).
- Parser `secure_stream_url` Facebook.

**Integrasi lokal tanpa akun sungguhan:** jalankan 2 listener RTMP lokal (`ffmpeg -listen 1 -i rtmp://...`) sebagai "YouTube" & "Facebook" palsu, lalu jalankan stream `simulcast` dan `alternate` untuk memastikan `tee`, retry, health check, stop, dan history bekerja.

**Manual (di VPS-mu, setelah upload):** manual RTMP Facebook → Facebook API (Page) → simulcast YT+FB → alternate.

---

## 7. RISIKO & MITIGASI

| Risiko | Dampak | Mitigasi |
|---|---|---|
| App Facebook belum di-review (izin `publish_video`) | API live gagal untuk akun non-tester | Jalur **Manual Persistent Stream Key** selalu tersedia; panduan Development Mode + tester di `docs/FACEBOOK_SETUP.md` |
| FFmpeg tanpa TLS (rtmps mati) | Stream FB gagal | Preflight check + pesan perbaikan; sudah diverifikasi build ffmpeg proyek mendukung rtmps |
| Copy-mode tidak sesuai syarat FB | Stream ditolak/patah | Validator + auto-fix audio + saran advanced settings |
| `tee` gagal parsial | Satu platform mati diam-diam | `onfail=ignore` + parser log per-URL → status per target di UI |
| Token FB kedaluwarsa (60 hari) | Live gagal saat scheduled | Simpan `token_expires_at`, tampilkan peringatan di Settings & dashboard, cek saat prepare |
| VPS 1 core kewalahan | Frame drop | `tee` (1x encode), cap bitrate FB 4000k, peringatan UI saat simulcast + advanced settings |
| Batas 8 jam FB | Live terputus | Deteksi + opsi auto-recreate live video (log jelas) |
| `SESSION_SECRET` diubah user | Token tidak bisa didekripsi | Peringatan boot + tombol reconnect (tidak crash) |

---

## 8. PERKIRAAN PERUBAHAN

- File baru: 8 (5 kode, 2 dokumen, 1 skrip uji)
- File diubah: `db/database.js`, `src/models/Stream.js`, `src/services/streamingService.js`, `src/services/autoSchedulerService.js`, `src/routes/mainRoutes.js`, `src/routes/userRoutes.js` (settings), `src/views/dashboard.ejs`, `src/views/settings.ejs`, `src/utils/helpers.js`, `src/locales/*.json`, `README.md`, `CHANGELOG.md`, `.env.example`
- Dependency baru: **0**
- Migrasi destruktif: **0**

---

## 9. KEPUTUSAN YANG PERLU KONFIRMASI SEBELUM CODING

1. **Prioritas jalur Facebook**: mulai dari *Manual Persistent Stream Key* (pasti jalan, tanpa App Review) lalu Graph API, atau langsung dua-duanya sekaligus? (rekomendasi: dua-duanya, tapi manual dijadikan default aman)
2. **Arti "bergantian"**: (a) sekadar memilih salah satu platform per stream, atau (b) benar-benar berganti otomatis tiap N menit dalam satu jadwal? Rencana ini mencakup **keduanya**; konfirmasi agar prioritas jelas.
3. **Target Facebook**: fokus **Page** saja dulu, atau Page + Profil pribadi + Group?
4. **Batas bitrate simulcast**: paksa cap 4000k saat Facebook aktif (aman) atau biarkan user override dengan peringatan?

---

# STATUS IMPLEMENTASI FINAL

Semua fase yang disetujui sudah selesai diimplementasikan.

## Keputusan final (hasil konfirmasi)

| Topik | Keputusan |
|-------|-----------|
| Jalur Facebook | Manual stream key + Graph API |
| Arti "bergantian" | Cukup pilih salah satu platform (tanpa auto-switch berjadwal) |
| Tujuan Facebook | Facebook Page saja |
| Bitrate saat Facebook aktif | Cap otomatis 4000 kbps |

Mode akhir: `single` (YouTube saja / Facebook saja / manual) dan `multi` (simulcast).
Mode `alternate` (pergantian otomatis berjadwal) DIBATALKAN sesuai keputusan di atas.

## Checklist implementasi

- [x] F1 Migrasi database (aditif + idempoten)
- [x] F2 Model `FacebookTarget` & `StreamTarget`
- [x] F3 Platform registry terpusat
- [x] F4 Service Facebook Graph API
- [x] F5 FFmpeg multi-output (`tee` muxer) + finalize live video
- [x] F6 Routes: settings Facebook, OAuth, create stream facebook/multi
- [x] F7 UI Settings (kartu Facebook Integration)
- [x] F8 UI Dashboard (mode Facebook API & Both/Simulcast)
- [x] F9 Dokumentasi (README, CHANGELOG, .env.example, FACEBOOK_SETUP.md)
- [x] F10 Verifikasi statis (node --check + EJS balance)

## Kompatibilitas mundur

- Stream lama tetap berjalan: output FFmpeg untuk satu target identik dengan versi sebelumnya.
- Stream lama otomatis dipetakan ke `stream_targets` saat pertama kali dijalankan.
- Kolom & tabel baru bersifat tambahan; tidak ada kolom yang dihapus atau diubah tipenya.
