const express = require('express');
const { startLiveStream, stopLiveStream, saveStreamConfig } = require('../controllers/streamController');
const { scheduleStream } = require('../services/schedulerService');
const db = require('../models/database');
const router = express.Router();

router.post('/start', (req, res, next) => {
  console.log('Stream Start Request Received:', req.body);
  next();
}, startLiveStream);

router.post('/stop', stopLiveStream);

router.post('/config', saveStreamConfig);

router.post('/schedule', (req, res) => {
  const { videoId, scheduleTime, timezone, settings, loop, customRtmp } = req.body;
  db.run('INSERT INTO schedules (video_id, platforms, schedule_time, timezone) VALUES (?, ?, ?, ?)',
    [videoId, JSON.stringify({ customRtmp }), scheduleTime, timezone], function (err) {
      if (err) return res.status(500).json({ error: 'Failed to schedule stream' });
      scheduleStream(videoId, scheduleTime, timezone, settings, loop, customRtmp);
      res.json({ message: 'Stream scheduled!', scheduleId: this.lastID });
    });
});

module.exports = router;