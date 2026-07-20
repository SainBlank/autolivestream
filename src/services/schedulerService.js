const schedule = require('node-schedule');
const moment = require('moment-timezone');
const db = require('../models/database');
const { startStream } = require('./ffmpegService');
const logger = require('../utils/logger');

function scheduleStream(videoId, scheduleTime, timezone = 'UTC', settings, loop, customRtmp) {
  const localTime = moment.tz(scheduleTime, timezone).toDate();
  schedule.scheduleJob(localTime, () => {
    db.get('SELECT path FROM videos WHERE id = ?', [videoId], (err, row) => {
      if (err || !row) {
        logger.error(`Failed to start scheduled stream: ${err || 'Video not found'}`);
        return;
      }
      const proc = startStream(row.path, settings, loop, customRtmp);
      global.streamProcesses[videoId] = { pid: proc.pid, proc };
      global.io.emit('streamStatus', { videoId, pid: proc.pid, running: true });
      logger.info(`Scheduled stream started for video ${videoId}`);
    });
  });
}

module.exports = { scheduleStream };