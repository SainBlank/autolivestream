// src/middleware/csrf.js
//
// Menyediakan CSRF token untuk semua template lewat res.locals.csrfToken.
//
// KENAPA ADA FILE INI:
// Banyak view (login.ejs, settings.ejs, signup.ejs, rotations.ejs, dll) dan
// sebagian JS front-end merujuk variabel `csrfToken`. Di kode hasil port dari
// StreamFire, middleware yang menyediakannya HILANG, sehingga render EJS gagal
// dengan error "csrfToken is not defined". Middleware ini mengembalikannya.
//
// Paket `csrf` sudah ada di package.json (dependencies), jadi tidak perlu
// install tambahan.

const Tokens = require('csrf');
const tokens = new Tokens();

// Pasang SEBELUM route (setelah express-session). Membuat secret per-session
// lalu menaruh token di res.locals.csrfToken agar bisa dipakai di semua EJS.
function provideCsrfToken(req, res, next) {
  try {
    if (req.session) {
      if (!req.session.csrfSecret) {
        req.session.csrfSecret = tokens.secretSync();
      }
      res.locals.csrfToken = tokens.create(req.session.csrfSecret);
    } else {
      res.locals.csrfToken = '';
    }
  } catch (e) {
    res.locals.csrfToken = '';
  }
  next();
}

// OPSIONAL (belum diaktifkan): verifikasi CSRF untuk request yang mengubah data.
// Belum dipasang secara default supaya tidak memblokir form multipart (signup,
// setup-account, upload avatar) dan fetch yang saat ini belum semuanya mengirim
// token. Untuk mengaktifkan: pasang verifyCsrf setelah provideCsrfToken di
// app.js, dan pastikan SEMUA form/fetch mengirim token (input hidden name="_csrf"
// atau header X-CSRF-Token) -- termasuk menambahkan token ke layout.ejs.
function verifyCsrf(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();

  // Lewati multipart: body-nya baru diparse oleh multer di dalam route.
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return next();

  const secret = req.session && req.session.csrfSecret;
  const token =
    (req.body && req.body._csrf) ||
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    req.headers['x-xsrf-token'];

  if (!secret || !token || !tokens.verify(secret, token)) {
    return res.status(403).send('Invalid CSRF token');
  }
  next();
}

module.exports = { provideCsrfToken, verifyCsrf };
