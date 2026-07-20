#!/usr/bin/env bash
# ================================================
#   AutoLivestream Quick Installer
#   Repo: https://github.com/SainBlank/autolivestream
# ================================================
set -e

REPO_URL="https://github.com/SainBlank/autolivestream.git"
APP_DIR="autolivestream"
APP_NAME="autolivestream"

green(){ echo -e "\033[1;32m$1\033[0m"; }
blue(){ echo -e "\033[1;34m$1\033[0m"; }
yellow(){ echo -e "\033[1;33m$1\033[0m"; }

# Gunakan sudo hanya jika bukan root
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

blue "\n=== [1/6] Update sistem & pasang dependency ==="
$SUDO apt-get update -y
$SUDO apt-get install -y curl git ffmpeg python3 make g++ build-essential

if ! command -v node >/dev/null 2>&1; then
  blue "Memasang Node.js 22 (LTS)..."
  if [ -n "$SUDO" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  fi
  $SUDO apt-get install -y nodejs
else
  green "Node.js sudah terpasang: $(node -v)"
fi

blue "\n=== [2/6] Memperbarui npm & Memasang pm2 ==="
blue "Mengatur registry npm ke default untuk menghindari error EALLOWREMOTE pada mirror Tencent..."
$SUDO npm config set registry https://registry.npmjs.org/ --global
$SUDO npm config set registry https://registry.npmjs.org/

blue "Memperbarui npm ke versi terbaru..."
$SUDO npm install -g npm@latest

if ! command -v pm2 >/dev/null 2>&1; then
  $SUDO npm install -g pm2
else
  green "pm2 sudah terpasang."
fi

blue "\n=== [3/6] Mengambil kode aplikasi ==="
# Cek apakah kita sudah di dalam folder autolivestream
if [ -f "package.json" ] && [ -f "app.js" ] && grep -q '"name": "autolivestream"' package.json; then
  green "Sudah berada di dalam folder proyek. Melewati clone."
else
  # Pindah ke home folder sebelum clone jika belum di folder
  cd "$HOME" 2>/dev/null || cd ~
  if [ -d "$APP_DIR/.git" ]; then
    green "Folder sudah ada, menarik update terbaru..."
    cd "$APP_DIR" && git pull
  else
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
  fi
fi

blue "\n=== [4/6] Memasang paket Node.js ==="
npm config set registry https://registry.npmjs.org/
npm config set ignore-scripts false
npm install --foreground-scripts --no-fund --no-audit

# npm versi baru memblokir install-scripts lewat gerbang keamanan "allowScripts",
# sehingga modul native (sqlite3, bcrypt, ffmpeg) TIDAK ikut ter-build saat
# "npm install". Kita setujui (approve) lalu build ulang. Ini menggantikan
# proses "approve" manual, dan mencegah error "Could not locate the bindings file".
for p in bcrypt sqlite3 ffmpeg-static @ffmpeg-installer/linux-x64 @ffprobe-installer/linux-x64; do
  npm install-scripts approve "$p" 2>/dev/null || true
done
npm rebuild --foreground-scripts || true

# Verifikasi modul native benar-benar bisa di-load.
node -e "require('sqlite3'); require('bcrypt'); console.log('Native modules OK: sqlite3 + bcrypt')" \
  || echo "PERINGATAN: modul native belum ter-build. Jalankan manual: npm install-scripts approve sqlite3 bcrypt && npm rebuild --foreground-scripts"

blue "\n=== [5/6] Menyiapkan konfigurasi (.env) ==="
if [ ! -f .env ]; then
  cp .env.example .env 2>/dev/null || echo "PORT=7575" > .env
  green ".env disiapkan."
fi
# Jalankan generate-secret untuk membuat SESSION_SECRET
npm run generate-secret
# Jalankan inisialisasi database jika ada
if [ -f "db/database.js" ]; then
  node db/database.js || true
fi

blue "\n=== [6/6] Menjalankan aplikasi (PM2) ==="
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start app.js --name "$APP_NAME"
pm2 save
$SUDO env PATH=$PATH pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

# Setup timezone
$SUDO timedatectl set-timezone Asia/Jakarta || true

# Buka firewall untuk port aplikasi (jika ufw aktif)
PORT=$(grep -E "^PORT=" .env | cut -d '=' -f2 | tr -d ' ' || true)
PORT=${PORT:-7575}
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow "$PORT" >/dev/null 2>&1 || true
  $SUDO ufw allow ssh >/dev/null 2>&1 || true
fi

IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}' || echo "IP_SERVER")
echo
echo "=========================================================="
green "✅ INSTALASI SELESAI!"
echo "=========================================================="
echo "🌐 URL Akses: http://$IP:$PORT"
echo "📦 Node.js: $(node -v)"
echo "📦 PM2: $(pm2 --version)"
echo
echo "📋 Langkah selanjutnya:"
echo "1. Buka URL di browser"
echo "2. Buat username & password"
echo "3. Setelah membuat akun, lakukan Sign Out kemudian login kembali untuk sinkronisasi database"
echo "=========================================================="
yellow "💡 Tip: Untuk cek status app kapan saja, jalankan:"
echo "   pm2 status"
echo "=========================================================="
