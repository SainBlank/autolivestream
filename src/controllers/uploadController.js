const db = require('../models/database');
const logger = require('../utils/logger');

function handleUpload(req, res) {
  const { title } = req.body;
  const path = req.file.path;
  db.run('INSERT INTO videos (title, path) VALUES (?, ?)', [title, path], function(err) {
    if (err) {
      logger.error(`Upload error: ${err.message}`);
      return res.status(500).json({ error: 'Failed to save video' });
    }
    res.json({ message: 'Video uploaded!', videoId: this.lastID });
  });
}

module.exports = { handleUpload };