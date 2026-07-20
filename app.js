const express = require('express');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
global.io = io;

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const db = require('./src/models/database');
const PORT = process.env.PORT || 7575;
const PUBLIC_IP = process.env.PUBLIC_IP || 'localhost';
const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');
const mainRoutes = require('./src/routes/mainRoutes');
const { checkAuth, checkSetup } = require('./src/middleware/auth');
const { ensureDirectories } = require('./src/utils/storage');

ensureDirectories();

// Autolivestream ported services
const autoSchedulerService = require('./src/services/autoSchedulerService');
const streamingService = require('./src/services/streamingService');
const rotationService = require('./src/services/rotationService');
const chunkUploadService = require('./src/services/chunkUploadService');
const audioConverter = require('./src/services/audioConverter');
const systemMonitor = require('./src/services/systemMonitor');

global.streamProcesses = {};
global.activityLogs = [];

app.use(cors());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.engine('ejs', require('ejs-mate')); // WAJIB: view pakai <% layout('layout') %> (ejs-mate). Tanpa ini -> "layout is not defined"
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));
app.locals.helpers = require('./src/utils/helpers'); // helpers global untuk semua EJS (getAvatar, getUsername, formatDateTime, dll). Tanpa ini -> "helpers is not defined"
app.locals.appVersion = require('./package.json').version; // appVersion global untuk semua EJS (dipakai layout.ejs & settings.ejs). Tanpa ini -> "appVersion is not defined"

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Sediakan CSRF token ke SEMUA template (res.locals.csrfToken).
// Variabel `csrfToken` dirujuk oleh login.ejs/settings.ejs/signup.ejs/rotations.ejs
// dan JS front-end, tapi middleware-nya hilang saat porting -> "csrfToken is not defined".
const { provideCsrfToken } = require('./src/middleware/csrf');
app.use(provideCsrfToken);

app.use(checkSetup);
app.use((req, res, next) => {
  if (req.path.startsWith('/uploads') ||
    req.path.startsWith('/css') ||
    req.path.startsWith('/js') ||
    req.path.startsWith('/img') ||
    req.path.startsWith('/login') ||
    req.path.startsWith('/setup') ||
    req.path.startsWith('/logout')) {
    return next();
  }
  checkAuth(req, res, next);
});

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.req = req; // expose req ke template EJS: layout.ejs & users.ejs pakai req.session.* -> tanpa ini "req is not defined"
  next();
});

// app.use(i18n); // DINONAKTIFKAN: variabel i18n tidak pernah di-import/didefinisikan di file ini (dangling reference)

// app.use('/api/system', systemRoutes); // DINONAKTIFKAN: variabel systemRoutes tidak pernah di-import/didefinisikan di file ini
global.addLog = (message, type = 'info') => {
  const log = {
    time: new Date().toLocaleTimeString(),
    message,
    type
  };
  global.activityLogs.push(log);
  if (global.activityLogs.length > 50) global.activityLogs.shift();
  io.emit('newLog', log);
};

// Removed streamfire index and donation to prioritize autolivestream UI

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/', mainRoutes);

io.on('connection', (socket) => {
  const statusList = Object.keys(global.streamProcesses).map(id => ({
    videoId: id, running: true
  }));
  socket.emit('streamStatuses', statusList);
});

app.use((req, res) => {
  console.log(`[${new Date().toISOString()}] 404 FALLTHROUGH: ${req.method} ${req.path}`);
  res.status(404).send('Route not found');
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n==================================================`);
  console.log(`autolivestream Running!`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Public:  http://${PUBLIC_IP}:${PORT}`);
  console.log(`==================================================\n`);

  // Initialize background services
  autoSchedulerService.init(streamingService);
  rotationService.init();
  try {
    await streamingService.syncStreamStatuses();
  } catch (error) {
    console.error('Failed to sync stream statuses:', error);
  }
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  autoSchedulerService.shutdown();
  await streamingService.gracefulShutdown();
  rotationService.shutdown();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  autoSchedulerService.shutdown();
  await streamingService.gracefulShutdown();
  rotationService.shutdown();
  server.close(() => {
    process.exit(0);
  });
});
