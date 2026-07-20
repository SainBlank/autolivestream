const express = require('express');
const db = require('../models/database');
const router = express.Router();

router.get('/data', (req, res) => {
  db.all('SELECT * FROM videos', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch videos' });
    res.json(rows);
  });
});

router.get('/', (req, res) => {
  db.all("SELECT * FROM videos WHERE filename IS NOT NULL AND filename != '' ORDER BY id DESC", [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database Error');
    }
    try {
      res.render('gallery', { videos: rows, path: '/gallery' });
    } catch (e) {
      console.error('Gallery Render Error:', e);
      res.status(500).send('Template Error: ' + e.message);
    }
  });
});

router.get('/view', (req, res) => {
  res.redirect('/gallery');
});

module.exports = router;