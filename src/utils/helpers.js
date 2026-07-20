// src/utils/helpers.js
//
// Kumpulan helper untuk template EJS. Objek ini di-expose lewat
// app.locals.helpers (lihat app.js) sehingga otomatis tersedia sebagai
// variabel `helpers` di SEMUA view (layout.ejs, history.ejs, dll).
//
// KENAPA ADA FILE INI:
// layout.ejs & history.ejs memanggil helpers.getAvatar/getUsername/
// getPlatformIcon/getPlatformColor/formatDateTime/formatDuration, dan
// userRoutes.js mengoper `helpers: app.locals.helpers`, tapi modul helper-nya
// hilang saat porting dari StreamFire -> "helpers is not defined".

const moment = require('moment-timezone');
const TZ = process.env.TZ || 'Asia/Jakarta';

const DEFAULT_AVATAR = '/images/default-avatar.jpg';

// Mengembalikan potongan HTML <img> untuk avatar (dipakai dengan <%- %>).
function getAvatar(req) {
  const avatar = (req && req.session && req.session.avatar_path) || DEFAULT_AVATAR;
  return `<img src="${avatar}" alt="avatar" class="w-full h-full object-cover" onerror="this.src='${DEFAULT_AVATAR}'">`;
}

function getUsername(req) {
  return (req && req.session && req.session.username) || 'User';
}

// Suffix untuk class Tabler Icons: ti ti-brand-<suffix>
function getPlatformIcon(platform) {
  const p = String(platform || '').toLowerCase();
  const map = {
    youtube: 'youtube',
    facebook: 'facebook',
    twitch: 'twitch',
    instagram: 'instagram',
    tiktok: 'tiktok',
    twitter: 'x',
    x: 'x'
  };
  return map[p] || 'youtube';
}

// Warna Tailwind untuk class text-<warna>
function getPlatformColor(platform) {
  const p = String(platform || '').toLowerCase();
  const map = {
    youtube: 'red-500',
    facebook: 'blue-500',
    twitch: 'purple-500',
    instagram: 'pink-500',
    tiktok: 'gray-100',
    twitter: 'gray-100',
    x: 'gray-100'
  };
  return map[p] || 'gray-400';
}

function formatDateTime(value) {
  if (!value) return '-';
  const m = moment(value);
  if (!m.isValid()) return '-';
  return m.tz(TZ).format('DD MMM YYYY, HH:mm');
}

// Durasi dalam detik -> "1h 2m 3s"
function formatDuration(totalSeconds) {
  const s = parseInt(totalSeconds, 10);
  if (isNaN(s) || s <= 0) return '-';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (sec || parts.length === 0) parts.push(sec + 's');
  return parts.join(' ');
}

module.exports = {
  getAvatar,
  getUsername,
  getPlatformIcon,
  getPlatformColor,
  formatDateTime,
  formatDuration
};
