const db = require('../models/database');
const { startStream } = require('../services/ffmpegService');
const logger = require('../utils/logger');

function startLiveStream(req, res) {
  const { videoId, settings, loop, customRtmp } = req.body;

  db.get('SELECT filename FROM videos WHERE id = ?', [videoId], (err, row) => {
    if (err || !row) {
      logger.error(`Stream error: ${err || 'Video not found in DB'}`);
      return res.status(404).json({ error: 'Video not found in database' });
    }

    if (global.streamProcesses[videoId]) {
      return res.status(400).json({ error: 'Stream is already running!' });
    }

    try {
      const uploadPath = process.env.UPLOAD_PATH || 'public/uploads';
      const videoPath = require('path').join(uploadPath, row.filename);
      const proc = startStream(videoPath, settings, loop, customRtmp);

      if (!proc) {
        logger.error(`Failed to start FFmpeg for video ${videoId}. File missing: ${videoPath}`);
        return res.status(500).json({ error: 'File video tidak ditemukan di server (Corrupt/Hilang).' });
      }

      global.streamProcesses[videoId] = { pid: proc.pid, proc };
      db.run("UPDATE videos SET views = views + 1, destinations = ?, start_time = datetime('now', 'localtime'), resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
        [JSON.stringify(customRtmp), settings.resolution, settings.bitrate, settings.fps, loop ? 1 : 0, videoId]);

      global.io.emit('streamStatus', { videoId, pid: proc.pid, running: true, startTime: new Date() });
      res.json({ message: 'Streaming started!', pid: proc.pid });

    } catch (error) {
      logger.error(`Critical Stream Error: ${error.message}`);
      res.status(500).json({ error: 'Internal Server Error during start' });
    }
  });
}

function saveStreamConfig(req, res) {
  const { videoId, settings, loop, customRtmp } = req.body;

  db.run("UPDATE videos SET destinations = ?, resolution = ?, bitrate = ?, fps = ?, loop = ? WHERE id = ?",
    [JSON.stringify(customRtmp), settings.resolution, settings.bitrate, settings.fps, loop ? 1 : 0, videoId],
    function (err) {
      if (err) {
        logger.error(`Config save error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to save config' });
      }
      res.json({ message: 'Configuration saved!' });
    }
  );
}

function stopLiveStream(req, res) {
  const { videoId } = req.body;

  if (!global.streamProcesses[videoId]) {
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false });
    return res.json({ message: 'Stream already stopped' });
  }

  try {
    const processInfo = global.streamProcesses[videoId];
    if (processInfo && processInfo.proc) {
      processInfo.proc.kill('SIGKILL');
    }
    delete global.streamProcesses[videoId];
    db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
    global.io.emit('streamStatus', { videoId, running: false });
    res.json({ message: 'Streaming stopped!' });
  } catch (e) {
    logger.error(`Error stopping stream: ${e.message}`);
    res.status(500).json({ error: 'Failed to stop stream' });
  }
}

module.exports = { startLiveStream, stopLiveStream, saveStreamConfig };