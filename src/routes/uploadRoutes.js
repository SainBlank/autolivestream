const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const ffmpegPath = 'ffmpeg';
const db = require('../models/database');
const logger = require('../utils/logger');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = process.env.UPLOAD_PATH || 'public/uploads';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '.mp4');
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2048 * 1024 * 1024 }
});

router.post('/local', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  const { title } = req.body;
  const filePath = req.file.path;
  const thumbnailDir = path.join(process.env.UPLOAD_PATH || 'public/uploads', 'thumbnails');
  const thumbnailPath = path.join(thumbnailDir, `${req.file.filename}.jpg`);

  if (!fs.existsSync(thumbnailDir)) fs.mkdirSync(thumbnailDir, { recursive: true });
  const cmd = `${ffmpegPath} -i "${filePath}" -ss 00:00:01 -vframes 1 "${thumbnailPath}" -y`;

  exec(cmd, (err) => {
    if (err) {
      logger.error(`Thumbnail failed: ${err.message}`);
      saveToDatabase(title, req.file.filename, null, res);
    } else {
      saveToDatabase(title, req.file.filename, thumbnailPath, res);
    }
  });
});

function saveToDatabase(title, filename, thumbnail, res) {
  const thumbnailName = thumbnail ? path.basename(thumbnail) : null;

  db.run(
    'INSERT INTO videos (title, filename, thumbnail, views) VALUES (?, ?, ?, 0)',
    [title, filename, thumbnailName],
    function (err) {
      if (err) {
        console.error('Database Insert Error:', err.message);
        return res.status(500).json({ message: 'DB Error: ' + err.message });
      }
      res.json({ message: 'Success', videoId: this.lastID });
    }
  );
}

module.exports = router;