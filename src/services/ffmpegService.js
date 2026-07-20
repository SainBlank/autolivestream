const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

function startStream(videoPath, settings = { bitrate: '2500k', resolution: '1280x720', fps: 30 }, loop = false, customRtmp) {

  let absolutePath = videoPath;
  if (!fs.existsSync(absolutePath)) {
    absolutePath = path.resolve(process.cwd(), videoPath);
  }

  if (!fs.existsSync(absolutePath)) {
    logger.error(`FATAL: Video missing: ${absolutePath}`);
    return null;
  }

  const bitrate = settings.bitrate || '2500k';
  const fps = settings.fps || '30';
  const bufSize = (parseInt(bitrate) * 2) + 'k';

  let targetRes = settings.resolution || '1280x720';
  let [w, h] = targetRes.split('x').map(Number);
  if (w % 2 !== 0) w--;
  if (h % 2 !== 0) h--;
  if (w === 854) w = 852;

  const vfFilter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

  const args = [
    '-re',
    ...(loop ? ['-stream_loop', '-1'] : []),

    '-thread_queue_size', '1024',
    '-i', absolutePath,

    '-threads', '0',

    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',

    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-minrate', bitrate,
    '-bufsize', bufSize,

    '-pix_fmt', 'yuv420p',
    '-g', (parseInt(fps) * 2).toString(),
    '-r', fps,

    '-vf', vfFilter,

    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '44100',
    '-b:a', '128k',
  ];

  let destinationStr = '';

  if (Array.isArray(customRtmp)) {
    if (customRtmp.length === 0) return null;

    const outputs = customRtmp.map(url => {
      return `[f=flv:onfail=ignore]${url}`;
    });
    destinationStr = outputs.join('|');
  } else {
    destinationStr = `[f=flv:onfail=ignore]${customRtmp}`;
  }

  args.push(
    '-f', 'tee',
    '-map', '0:v',
    '-map', '0:a',
    destinationStr
  );

  logger.info(`System FFmpeg Start: ${w}x${h} @ ${fps}fps`);

  const proc = spawn(ffmpeg, args);
  let lastLog = '';

  proc.stderr.on('data', data => {
    lastLog = data.toString();
  });

  proc.on('close', (code, signal) => {
    if (code !== 0 && code !== 255 && signal !== 'SIGTERM') {
      logger.error(`FFmpeg Error (${signal || code}). Log: ${lastLog.slice(-300)}`);
    } else {
      logger.info(`Stream stopped.`);
    }

    for (let videoId in global.streamProcesses) {
      if (global.streamProcesses[videoId].pid === proc.pid) {
        delete global.streamProcesses[videoId];
        global.io.emit('streamStatus', { videoId, running: false });
        break;
      }
    }
  });

  return proc;
}

module.exports = { startStream };