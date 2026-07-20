const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../models/database');
const logger = require('../utils/logger');
const router = express.Router();

router.delete('/:id', (req, res) => {
  const videoId = req.params.id;
  
  db.get('SELECT path, thumbnail FROM videos WHERE id = ?', [videoId], (err, row) => {
    if (err || !row) {
      logger.error(`Error finding video ${videoId}: ${err || 'Video not found'}`);
      return res.status(404).json({ message: 'Video not found' });
    }

    if (global.streamProcesses[videoId]) {
      try {
        global.streamProcesses[videoId].proc.kill();
        delete global.streamProcesses[videoId];
        global.io.emit('streamStatus', { videoId, running: false });
      } catch (e) {
        logger.error(`Error killing process for video ${videoId}: ${e}`);
      }
    }

    if (row.path && fs.existsSync(row.path)) {
      fs.unlink(row.path, (err) => {
        if (err) logger.error(`Error deleting file ${row.path}: ${err}`);
      });
    }

    if (row.thumbnail && fs.existsSync(row.thumbnail)) {
      fs.unlink(row.thumbnail, (err) => {
        if (err) logger.error(`Error deleting thumbnail ${row.thumbnail}: ${err}`);
      });
    }

    db.run('DELETE FROM videos WHERE id = ?', [videoId], (err) => {
      if (err) {
        logger.error(`Error deleting video ${videoId} from database: ${err}`);
        return res.status(500).json({ message: 'Failed to delete video' });
      }
      logger.info(`Video ${videoId} deleted successfully`);
      res.json({ message: 'Video deleted successfully' });
    });
  });
});

module.exports = router;