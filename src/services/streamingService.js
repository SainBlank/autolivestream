const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { v4: uuidv4 } = require('uuid');
const db = require('../models/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');
const StreamTarget = require('../models/StreamTarget');
const {
  resolveTargetPlatform,
  detectPlatformFromUrl,
  buildIngestUrl,
  resolveSafeBitrate,
  resolveKeyframeIntervalSeconds,
  resolveAudioSampleRate
} = require('../utils/platformRegistry');

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
} else {
  ffmpegPath = ffmpegInstaller.path;
}

let ffprobePath;
if (fs.existsSync('/usr/bin/ffprobe')) {
  ffprobePath = '/usr/bin/ffprobe';
} else {
  ffprobePath = ffprobeInstaller.path;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const manuallyStoppingStreams = new Set();
const startingStreams = new Set();

const MAX_LOG_LINES = 50;
const MAX_RETRY_ATTEMPTS = 15;
const BASE_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 30000;
const SYNC_INTERVAL = 60000;
const STREAM_START_TIMEOUT = 15000;

const YOUTUBE_COPY_ALLOWED_VIDEO_CODECS = new Set(['h264']);
const YOUTUBE_COPY_ALLOWED_AUDIO_CODECS = new Set(['aac', 'mp3']);

const DEFAULT_COPY_CONSTRAINTS = {
  videoCodecs: YOUTUBE_COPY_ALLOWED_VIDEO_CODECS,
  audioCodecs: YOUTUBE_COPY_ALLOWED_AUDIO_CODECS,
  platformLabel: 'YouTube'
};

/**
 * Bangun daftar target "implisit" dari kolom lama tabel streams.
 * Dipakai sebagai fallback agar kode lama (dan endpoint validasi yang hanya
 * mengirim rtmpUrl) tetap bekerja tanpa baris stream_targets.
 */
function buildImplicitTargets({ isYouTubeApi = false, isFacebookApi = false, rtmpUrl = '' } = {}) {
  if (isYouTubeApi) {
    return [{ platform: 'youtube', rtmp_url: rtmpUrl }];
  }

  if (isFacebookApi) {
    return [{ platform: 'facebook', rtmp_url: rtmpUrl }];
  }

  return [{ platform: detectPlatformFromUrl(rtmpUrl).key, rtmp_url: rtmpUrl }];
}

/**
 * Aturan copy mode gabungan untuk sekumpulan target.
 *
 * Saat simulcast, satu bitstream dikirim ke semua platform sekaligus, jadi
 * media sumber harus memenuhi aturan TERKETAT dari semua platform tujuan
 * (irisan himpunan codec). Contoh nyata: video dengan audio MP3 aman di
 * YouTube, tetapi akan ditolak Facebook, sehingga harus di-re-encode.
 *
 * @returns {null|{videoCodecs:Set,audioCodecs:Set,platformLabel:string}}
 *          null berarti tidak ada aturan ketat (mis. custom RTMP saja).
 */
function getCopyConstraintsForTargets(targets) {
  const list = (targets || []).filter(Boolean);

  let videoCodecs = null;
  let audioCodecs = null;
  const labels = [];

  for (const target of list) {
    const platform = resolveTargetPlatform(target);

    // Custom RTMP tidak punya aturan yang bisa kita pastikan.
    if (platform.key === 'custom') {
      continue;
    }

    labels.push(platform.label);

    const platformVideo = new Set((platform.allowedCopyVideoCodecs || []).map((c) => c.toLowerCase()));
    const platformAudio = new Set((platform.allowedCopyAudioCodecs || []).map((c) => c.toLowerCase()));

    videoCodecs = videoCodecs
      ? new Set([...videoCodecs].filter((codec) => platformVideo.has(codec)))
      : platformVideo;

    audioCodecs = audioCodecs
      ? new Set([...audioCodecs].filter((codec) => platformAudio.has(codec)))
      : platformAudio;
  }

  if (labels.length === 0) {
    return null;
  }

  return {
    videoCodecs,
    audioCodecs,
    platformLabel: [...new Set(labels)].join(' + ')
  };
}

let schedulerService = null;
let syncIntervalId = null;
let healthCheckIntervalId = null;
let initialized = false;

function setSchedulerService(service) {
  schedulerService = service;

  if (!initialized) {
    initialized = true;
    syncIntervalId = setInterval(syncStreamStatuses, SYNC_INTERVAL);
    healthCheckIntervalId = setInterval(healthCheckStreams, HEALTH_CHECK_INTERVAL);
  }
}

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({ timestamp: new Date().toISOString(), message });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

function cleanupStreamData(streamId) {
  streamRetryCount.delete(streamId);
  manuallyStoppingStreams.delete(streamId);
  startingStreams.delete(streamId);
}

function getRetryDelay(retryCount) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
  return delay + Math.random() * 1000;
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function resolvePublicFilePath(relativePath) {
  if (!relativePath) {
    throw new Error('Missing media filepath');
  }

  const relPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
  return path.join(getProjectRoot(), 'public', relPath);
}

function isYouTubeDestination(stream) {
  if (stream && stream.is_youtube_api) {
    return true;
  }

  const rtmpUrl = (stream.rtmp_url || '').toLowerCase();
  return rtmpUrl.includes('youtube.com');
}

function isProgressLogLine(line) {
  return line.includes('frame=') || line.includes('time=') || line.includes('speed=');
}

function buildMediaLabel(media, index, type) {
  if (media && media.title) {
    return `${type} "${media.title}"`;
  }

  return `${type} #${index + 1}`;
}

function isSupportedYouTubePixelFormat(pixFmt) {
  const normalized = (pixFmt || '').toLowerCase();
  return normalized === 'yuv420p' || normalized === 'yuvj420p';
}

function getPrimaryStream(probeData, codecType) {
  return (probeData.streams || []).find(stream => stream.codec_type === codecType) || null;
}

function getFrameRateLabel(videoStream) {
  return videoStream && videoStream.avg_frame_rate ? videoStream.avg_frame_rate : 'unknown fps';
}

function buildCopyModeCompatibilityError(label, detail, platformLabel = 'YouTube') {
  return `${label} tidak kompatibel dengan ${platformLabel}: ${detail}.`;
}

function createUnsupportedCopyModeError(message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_COPY_MODE_MEDIA';
  return error;
}

function getRelevantStartupLog(line) {
  const trimmed = (line || '').trim();
  if (!trimmed || isProgressLogLine(trimmed)) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('press [q]') ||
    lower.startsWith('input #') ||
    lower.startsWith('output #') ||
    lower.startsWith('metadata:') ||
    lower.startsWith('stream mapping:')
  ) {
    return null;
  }

  return trimmed;
}

function buildStartupFailureMessage(startupState, fallbackMessage = null) {
  const detail = startupState.lastErrorLine || startupState.lastLogLine || fallbackMessage;
  if (detail) {
    return `FFmpeg gagal memulai stream: ${detail}`;
  }

  return 'FFmpeg gagal memulai stream';
}

function runFFprobe(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobeProcess = spawn(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ffprobeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobeProcess.on('error', (error) => {
      reject(error);
    });

    ffprobeProcess.on('exit', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateYouTubeCopyVideoProbe(probeData, label, constraints = DEFAULT_COPY_CONSTRAINTS) {
  const rules = constraints || DEFAULT_COPY_CONSTRAINTS;
  const platformLabel = rules.platformLabel || 'YouTube';

  const videoStream = getPrimaryStream(probeData, 'video');
  if (!videoStream) {
    return buildCopyModeCompatibilityError(label, 'video stream tidak ditemukan', platformLabel);
  }

  const videoCodec = (videoStream.codec_name || '').toLowerCase();
  if (!rules.videoCodecs.has(videoCodec)) {
    return buildCopyModeCompatibilityError(
      label,
      `codec video ${videoCodec || 'unknown'} tidak didukung (butuh ${[...rules.videoCodecs].join('/')})`,
      platformLabel
    );
  }

  if (!isSupportedYouTubePixelFormat(videoStream.pix_fmt)) {
    return buildCopyModeCompatibilityError(
      label,
      `pixel format ${videoStream.pix_fmt || 'unknown'} bukan 4:2:0 standar`,
      platformLabel
    );
  }

  const audioStream = getPrimaryStream(probeData, 'audio');
  if (audioStream) {
    const audioCodec = (audioStream.codec_name || '').toLowerCase();
    if (!rules.audioCodecs.has(audioCodec)) {
      return buildCopyModeCompatibilityError(
        label,
        `codec audio ${audioCodec || 'unknown'} tidak didukung (butuh ${[...rules.audioCodecs].join('/')})`,
        platformLabel
      );
    }
  }

  return null;
}

function validateYouTubeCopyAudioProbe(probeData, label, constraints = DEFAULT_COPY_CONSTRAINTS) {
  const rules = constraints || DEFAULT_COPY_CONSTRAINTS;
  const platformLabel = rules.platformLabel || 'YouTube';

  const audioStream = getPrimaryStream(probeData, 'audio');
  if (!audioStream) {
    return buildCopyModeCompatibilityError(label, 'audio stream tidak ditemukan', platformLabel);
  }

  const audioCodec = (audioStream.codec_name || '').toLowerCase();
  if (!rules.audioCodecs.has(audioCodec)) {
    return buildCopyModeCompatibilityError(
      label,
      `codec audio ${audioCodec || 'unknown'} tidak didukung (butuh ${[...rules.audioCodecs].join('/')})`,
      platformLabel
    );
  }

  return null;
}

function validatePlaylistCopyConsistency(referenceStream, currentStream, label) {
  const mismatches = [];

  if ((currentStream.codec_name || '').toLowerCase() !== (referenceStream.codec_name || '').toLowerCase()) {
    mismatches.push('codec video berbeda');
  }

  if (currentStream.width !== referenceStream.width || currentStream.height !== referenceStream.height) {
    mismatches.push('resolusi berbeda');
  }

  if ((currentStream.pix_fmt || '').toLowerCase() !== (referenceStream.pix_fmt || '').toLowerCase()) {
    mismatches.push('pixel format berbeda');
  }

  if (getFrameRateLabel(currentStream) !== getFrameRateLabel(referenceStream)) {
    mismatches.push('frame rate berbeda');
  }

  if (mismatches.length === 0) {
    return null;
  }

  return `${label} tidak bisa digabung aman di copy mode karena ${mismatches.join(', ')}.`;
}

async function validateCopyModeCompatibility(stream, targets = null) {
  return validateCopyModeCompatibilityForInput({
    videoId: stream.video_id,
    useAdvancedSettings: stream.use_advanced_settings,
    isYouTubeApi: stream.is_youtube_api,
    isFacebookApi: stream.is_facebook_api,
    rtmpUrl: stream.rtmp_url,
    targets
  });
}

async function validateCopyModeCompatibilityForInput({
  videoId,
  useAdvancedSettings = false,
  isYouTubeApi = false,
  isFacebookApi = false,
  rtmpUrl = '',
  targets = null
}) {
  if (useAdvancedSettings) {
    return;
  }

  const effectiveTargets = (targets && targets.length > 0)
    ? targets
    : buildImplicitTargets({ isYouTubeApi, isFacebookApi, rtmpUrl });

  const constraints = getCopyConstraintsForTargets(effectiveTargets);

  // Tidak ada platform dengan aturan pasti (mis. custom RTMP saja) => lewati.
  if (!constraints) {
    return;
  }

  const playlist = await Playlist.findByIdWithVideos(videoId);

  if (playlist) {
    if (!playlist.videos || playlist.videos.length === 0) {
      throw new Error('Playlist is empty');
    }

    let referenceVideoStream = null;

    for (let index = 0; index < playlist.videos.length; index++) {
      const video = playlist.videos[index];
      const probeData = await runFFprobe(resolvePublicFilePath(video.filepath));
      const label = buildMediaLabel(video, index, 'Video');
      const compatibilityError = validateYouTubeCopyVideoProbe(probeData, label, constraints);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }

      const currentVideoStream = getPrimaryStream(probeData, 'video');
      if (!referenceVideoStream) {
        referenceVideoStream = currentVideoStream;
      } else {
        const consistencyError = validatePlaylistCopyConsistency(referenceVideoStream, currentVideoStream, label);
        if (consistencyError) {
          throw createUnsupportedCopyModeError(consistencyError);
        }
      }
    }

    for (let index = 0; index < (playlist.audios || []).length; index++) {
      const audio = playlist.audios[index];
      const probeData = await runFFprobe(resolvePublicFilePath(audio.filepath));
      const label = buildMediaLabel(audio, index, 'Audio');
      const compatibilityError = validateYouTubeCopyAudioProbe(probeData, label, constraints);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }
    }

    return;
  }

  const video = await Video.findById(videoId);
  if (!video) {
    throw new Error('Video not found');
  }

  const compatibilityError = validateYouTubeCopyVideoProbe(
    await runFFprobe(resolvePublicFilePath(video.filepath)),
    buildMediaLabel(video, 0, 'Video'),
    constraints
  );

  if (compatibilityError) {
    throw createUnsupportedCopyModeError(compatibilityError);
  }
}

/**
 * Escape URL untuk dipakai di dalam spesifikasi muxer `tee`.
 * Di dalam tee spec, karakter `|` memisahkan output dan `\` adalah escape,
 * jadi keduanya wajib di-escape.
 */
function escapeTeeUrl(url) {
  return String(url).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Ubah daftar target menjadi URL ingest lengkap.
 */
function buildTargetUrls(targets) {
  return (targets || [])
    .filter((target) => target && target.rtmp_url && target.stream_key)
    .map((target) => ({
      target,
      url: buildIngestUrl(target.rtmp_url, target.stream_key),
      platform: resolveTargetPlatform(target)
    }));
}

/**
 * Bangun bagian OUTPUT dari argumen FFmpeg.
 *
 * PENTING (kompatibilitas mundur):
 *  - Jika hanya ada SATU target, output yang dihasilkan identik dengan versi
 *    aplikasi sebelumnya: `-f flv -flvflags no_duration_filesize <url>`.
 *    Tidak ada argumen tambahan, sehingga tidak ada risiko regresi.
 *  - Jika ada DUA target atau lebih, dipakai muxer `tee` sehingga video hanya
 *    di-encode SEKALI lalu dikirim ke semua platform. Ini jauh lebih ringan
 *    untuk VPS kecil dibanding menjalankan dua proses FFmpeg.
 *  - `onfail=ignore` membuat satu platform yang bermasalah tidak mematikan
 *    stream ke platform lainnya.
 *
 * @param {Array} resolvedTargets hasil buildTargetUrls()
 * @param {object} options
 * @param {boolean} options.isCopyMode true jika memakai -c:v copy
 * @param {Array<string>} options.mapArgs argumen -map yang wajib ada saat tee
 * @param {boolean} options.audioIsAac apakah audio keluaran berformat AAC
 */
function buildOutputArgs(resolvedTargets, { isCopyMode = false, mapArgs = [], audioIsAac = true } = {}) {
  if (!resolvedTargets || resolvedTargets.length === 0) {
    throw new Error('Tidak ada tujuan streaming yang valid (RTMP URL / stream key kosong)');
  }

  if (resolvedTargets.length === 1) {
    return [
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      resolvedTargets[0].url
    ];
  }

  // Bitstream filter harus dideklarasikan per-output saat memakai tee.
  const needsAdtsToAsc = isCopyMode && audioIsAac;

  const teeSpec = resolvedTargets
    .map(({ url }) => {
      const options = ['f=flv', 'onfail=ignore', 'flvflags=no_duration_filesize'];
      if (needsAdtsToAsc) {
        options.push('bsfs/a=aac_adtstoasc');
      }
      return `[${options.join(':')}]${escapeTeeUrl(url)}`;
    })
    .join('|');

  return [
    ...mapArgs,
    // Diperlukan agar header global ditulis untuk setiap output tee.
    '-flags', '+global_header',
    '-f', 'tee',
    teeSpec
  ];
}

function waitForStreamStartup(streamId, ffmpegProcess, startupState) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const finishReject = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      finishReject(buildStartupFailureMessage(
        startupState,
        `tidak ada progres FFmpeg dalam ${Math.round(STREAM_START_TIMEOUT / 1000)} detik`
      ));
    }, STREAM_START_TIMEOUT);

    startupState.resolve = finishResolve;

    startupState.reject = finishReject;
  });
}

/**
 * Target "legacy" dari kolom lama tabel streams, dipakai bila stream belum
 * punya baris stream_targets (kompatibilitas dengan data versi lama).
 */
function buildLegacyTargetFromStream(stream) {
  return [{
    platform: stream.is_facebook_api
      ? 'facebook'
      : (stream.is_youtube_api ? 'youtube' : detectPlatformFromUrl(stream.rtmp_url).key),
    rtmp_url: stream.rtmp_url,
    stream_key: stream.stream_key
  }];
}

function resolveTargetsForArgs(stream, targets) {
  const source = (targets && targets.length > 0) ? targets : buildLegacyTargetFromStream(stream);
  const resolved = buildTargetUrls(source);

  if (resolved.length === 0) {
    throw new Error('Missing RTMP URL or stream key');
  }

  return resolved;
}

/**
 * Parameter encoding efektif setelah mempertimbangkan batas tiap platform.
 *
 * Contoh: user memilih 8000 kbps untuk simulcast YouTube + Facebook.
 * Facebook menolak di atas 4000 kbps, jadi nilai dipangkas otomatis ke 4000
 * supaya stream tidak terputus di tengah jalan.
 */
function resolveEncodingParams(stream, resolvedTargets) {
  const rawTargets = resolvedTargets.map((item) => item.target);
  const requestedBitrate = stream.bitrate || 2500;
  const safe = resolveSafeBitrate(requestedBitrate, rawTargets);

  return {
    resolution: stream.resolution || '1280x720',
    bitrate: safe.bitrate || requestedBitrate,
    fps: stream.fps || 30,
    keyframeSeconds: resolveKeyframeIntervalSeconds(rawTargets),
    audioSampleRate: resolveAudioSampleRate(rawTargets),
    bitrateCapped: safe.capped,
    bitrateLimit: safe.limit,
    requestedBitrate
  };
}

async function buildFFmpegArgsForPlaylist(stream, playlist, targets = null) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error('Playlist is empty');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const resolvedTargets = resolveTargetsForArgs(stream, targets);
  const encoding = resolveEncodingParams(stream, resolvedTargets);
  const { keyframeSeconds, audioSampleRate } = encoding;
  const tempDir = path.join(projectRoot, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let videoPaths = [];
  const videos = playlist.is_shuffle ? shuffleArray(playlist.videos) : playlist.videos;

  for (const video of videos) {
    const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Video file not found: ${fullPath}`);
    }
    videoPaths.push(fullPath);
  }

  const concatFile = path.join(tempDir, `playlist_${stream.id}.txt`);
  let content = '';
  const loopCount = stream.loop_video ? 10000 : 1;

  for (let i = 0; i < loopCount; i++) {
    for (const vp of videoPaths) {
      content += `file '${vp.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(concatFile, content);

  const hasAudio = playlist.audios && playlist.audios.length > 0;

  if (!hasAudio) {
    if (!stream.use_advanced_settings) {
      return [
        '-nostdin',
        '-loglevel', 'warning',
        '-stats',
        '-re',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c:v', 'copy',
        '-c:a', 'copy',
        ...(resolvedTargets.length === 1 ? ['-bsf:a', 'aac_adtstoasc'] : []),
        ...buildOutputArgs(resolvedTargets, {
          isCopyMode: true,
          mapArgs: ['-map', '0:v:0', '-map', '0:a:0?']
        })
      ];
    }

    const { resolution, bitrate, fps } = encoding;

    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-level', '4.1',
      '-b:v', `${bitrate}k`,
      '-maxrate', `${Math.round(bitrate * 1.1)}k`,
      '-bufsize', `${bitrate * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(Math.max(1, Math.round(fps * keyframeSeconds))),
      '-keyint_min', String(fps),
      '-sc_threshold', '0',
      '-s', resolution,
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', String(audioSampleRate),
      '-ac', '2',
      ...buildOutputArgs(resolvedTargets, {
        isCopyMode: false,
        mapArgs: ['-map', '0:v:0', '-map', '0:a:0?']
      })
    ];
  }

  let audioPaths = [];
  const audios = playlist.is_shuffle ? shuffleArray(playlist.audios) : playlist.audios;

  for (const audio of audios) {
    const relPath = audio.filepath.startsWith('/') ? audio.filepath.substring(1) : audio.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audio file not found: ${fullPath}`);
    }
    audioPaths.push(fullPath);
  }

  const audioConcatFile = path.join(tempDir, `playlist_audio_${stream.id}.txt`);
  let audioContent = '';
  for (let i = 0; i < 10000; i++) {
    for (const ap of audioPaths) {
      audioContent += `file '${ap.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(audioConcatFile, audioContent);

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-re',
      '-f', 'concat',
      '-safe', '0',
      '-i', audioConcatFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      ...buildOutputArgs(resolvedTargets, {
        isCopyMode: true,
        mapArgs: []
      })
    ];
  }

  const { resolution, bitrate, fps } = encoding;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', audioConcatFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(Math.max(1, Math.round(fps * keyframeSeconds))),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'copy',
    ...buildOutputArgs(resolvedTargets, {
      isCopyMode: true,
      mapArgs: []
    })
  ];
}

async function buildFFmpegArgs(stream, targets = null) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    return await buildFFmpegArgsForPlaylist(stream, playlist, targets);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error('Video not found');
  }

  const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const resolvedTargets = resolveTargetsForArgs(stream, targets);
  const encoding = resolveEncodingParams(stream, resolvedTargets);
  const { keyframeSeconds, audioSampleRate } = encoding;
  const loopValue = stream.loop_video ? '-1' : '0';

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-stream_loop', loopValue,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      ...(resolvedTargets.length === 1 ? ['-bsf:a', 'aac_adtstoasc'] : []),
      ...buildOutputArgs(resolvedTargets, {
        isCopyMode: true,
        mapArgs: ['-map', '0:v:0', '-map', '0:a:0?']
      })
    ];
  }

  const { resolution, bitrate, fps } = encoding;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-stream_loop', loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(Math.max(1, Math.round(fps * keyframeSeconds))),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', String(audioSampleRate),
    '-ac', '2',
    ...buildOutputArgs(resolvedTargets, {
      isCopyMode: false,
      mapArgs: ['-map', '0:v:0', '-map', '0:a:0?']
    })
  ];
}


async function killFFmpegProcess(streamId, streamData) {
  return new Promise((resolve) => {
    if (!streamData || !streamData.process) {
      resolve(true);
      return;
    }

    const proc = streamData.process;

    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }

    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    };

    proc.once('exit', cleanup);
    proc.once('error', cleanup);

    try {
      proc.kill('SIGTERM');
    } catch (e) { }

    setTimeout(() => {
      if (!resolved) {
        try {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        } catch (e) { }
      }
    }, 3000);

    setTimeout(cleanup, 5000);
  });
}

/**
 * Siapkan semua target yang memakai mode API (YouTube Data API / Facebook Graph API)
 * sebelum FFmpeg dijalankan.
 *
 * Dijalankan berurutan (bukan paralel) supaya pesan error jelas dan tidak ada
 * broadcast "nyangkut" saat salah satu platform gagal.
 */
async function prepareApiTargets(streamId, stream, targets, baseUrl) {
  const effectiveBaseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:7575';
  let currentStream = stream;
  const prepared = [];

  for (const target of targets) {
    const platform = resolveTargetPlatform(target);
    const isApiMode = target.mode === 'api';

    if (isApiMode && platform.key === 'youtube') {
      addStreamLog(streamId, 'Creating YouTube broadcast...');

      try {
        const youtubeService = require('./youtubeService');
        const ytResult = await youtubeService.createYouTubeBroadcast(streamId, effectiveBaseUrl);

        if (!ytResult.success) {
          addStreamLog(streamId, `YouTube broadcast failed: ${ytResult.error}`);
          await StreamTarget.setStatus(target.id, 'error', ytResult.error || 'Failed to create YouTube broadcast');
          return { success: false, error: ytResult.error || 'Failed to create YouTube broadcast' };
        }

        // youtubeService menulis kredensial ke kolom lama tabel streams,
        // jadi kita baca ulang lalu salin ke baris target.
        currentStream = await Stream.findById(streamId);

        const patch = {
          rtmp_url: currentStream.rtmp_url,
          stream_key: currentStream.stream_key,
          youtube_broadcast_id: currentStream.youtube_broadcast_id,
          youtube_stream_id: currentStream.youtube_stream_id,
          status: 'live',
          last_error: null
        };

        await StreamTarget.update(target.id, patch);
        prepared.push({ ...target, ...patch });
        addStreamLog(streamId, `YouTube broadcast created: ${ytResult.broadcastId}`);
      } catch (ytError) {
        addStreamLog(streamId, `YouTube API error: ${ytError.message}`);
        await StreamTarget.setStatus(target.id, 'error', ytError.message);
        return { success: false, error: `YouTube API error: ${ytError.message}` };
      }

      continue;
    }

    if (isApiMode && platform.key === 'facebook') {
      addStreamLog(streamId, 'Creating Facebook live video...');

      try {
        const facebookService = require('./facebookService');
        const live = await facebookService.prepareTargetForStream(currentStream, target);

        currentStream = await Stream.findById(streamId);

        const patch = {
          rtmp_url: live.rtmpUrl,
          stream_key: live.streamKey,
          facebook_live_video_id: live.liveVideoId,
          facebook_permalink: live.permalink || null,
          status: 'live',
          last_error: null
        };

        prepared.push({ ...target, ...patch });
        addStreamLog(streamId, `Facebook live video created: ${live.liveVideoId}`);
      } catch (fbError) {
        addStreamLog(streamId, `Facebook API error: ${fbError.message}`);
        await StreamTarget.setStatus(target.id, 'error', fbError.message);
        return { success: false, error: fbError.message };
      }

      continue;
    }

    // Mode manual: RTMP URL + stream key sudah diisi user.
    prepared.push(target);
  }

  // Sinkronkan kolom lama streams.rtmp_url / stream_key dengan target pertama
  // supaya UI lama, riwayat, dan fitur "check key" tetap berjalan.
  const primary = prepared[0];

  if (primary && primary.rtmp_url && primary.stream_key
    && (currentStream.rtmp_url !== primary.rtmp_url || currentStream.stream_key !== primary.stream_key)) {
    await Stream.update(streamId, {
      rtmp_url: primary.rtmp_url,
      stream_key: primary.stream_key
    });
    currentStream = await Stream.findById(streamId);
  }

  return { success: true, stream: currentStream, targets: prepared };
}

/**
 * Akhiri semua sesi API saat stream dihentikan (Facebook live video, dsb).
 * Selalu "best effort": kegagalan di sini tidak boleh menggagalkan stop.
 */
async function finalizeApiTargets(stream) {
  let targets = [];

  try {
    targets = await StreamTarget.findByStream(stream.id);
  } catch (e) {
    return;
  }

  for (const target of targets) {
    const platform = resolveTargetPlatform(target);

    if (target.mode === 'api' && platform.key === 'facebook' && target.facebook_live_video_id) {
      try {
        const facebookService = require('./facebookService');
        await facebookService.finalizeTarget(stream, target);
        addStreamLog(stream.id, 'Facebook live video ended');
      } catch (e) {
        addStreamLog(stream.id, `Failed to end Facebook live video: ${e.message}`);
      }
    }

    try {
      await StreamTarget.setStatus(target.id, 'ended');
    } catch (e) { }
  }
}

/**
 * Ringkasan platform untuk log & riwayat, mis. "YouTube + Facebook".
 */
function describeTargets(targets) {
  return (targets || [])
    .map((target) => resolveTargetPlatform(target).label)
    .join(' + ');
}

async function startStream(streamId, isRetry = false, baseUrl = null) {
  if (startingStreams.has(streamId)) {
    return { success: false, error: 'Stream start is already in progress' };
  }

  startingStreams.add(streamId);

  try {
    if (!isRetry) {
      streamRetryCount.set(streamId, 0);
    }

    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      if (existing.process && existing.process.exitCode === null) {
        if (!isRetry) {
          return { success: false, error: 'Stream is already active' };
        }
        addStreamLog(streamId, 'Killing existing FFmpeg process before restart...');
        manuallyStoppingStreams.add(streamId);
        await killFFmpegProcess(streamId, existing);
        manuallyStoppingStreams.delete(streamId);
      }
      activeStreams.delete(streamId);
    }

    let stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    const originalStartTime = stream.start_time;
    const originalEndTime = stream.end_time;

    // Pastikan stream punya daftar tujuan. Untuk stream versi lama, baris
    // stream_targets dibuat otomatis dari kolom lama (tanpa mengubah perilaku).
    let targets = [];

    try {
      await StreamTarget.ensureForStream(stream);
      targets = await StreamTarget.findByStream(streamId, { enabledOnly: true });
    } catch (targetError) {
      addStreamLog(streamId, `Failed to load stream targets: ${targetError.message}`);
      return { success: false, error: `Failed to load stream targets: ${targetError.message}` };
    }

    if (!targets || targets.length === 0) {
      return { success: false, error: 'Tidak ada platform tujuan yang aktif untuk stream ini' };
    }

    await validateCopyModeCompatibility(stream, targets);

    const preparation = await prepareApiTargets(streamId, stream, targets, baseUrl);

    if (!preparation.success) {
      return { success: false, error: preparation.error };
    }

    stream = preparation.stream;
    targets = preparation.targets;

    const incompleteTarget = targets.find((target) => !target.rtmp_url || !target.stream_key);

    if (incompleteTarget) {
      const label = resolveTargetPlatform(incompleteTarget).label;
      return { success: false, error: `Missing RTMP URL or stream key (${label})` };
    }

    if (targets.length > 1) {
      addStreamLog(streamId, `Simulcast aktif ke ${targets.length} platform: ${describeTargets(targets)}`);
    }

    const safeBitrate = resolveSafeBitrate(stream.bitrate || 2500, targets);

    if (safeBitrate.capped) {
      addStreamLog(streamId, `Bitrate dibatasi otomatis ke ${safeBitrate.bitrate} kbps (batas ${describeTargets(targets)}: ${safeBitrate.limit} kbps)`);
    }

    const ffmpegArgs = await buildFFmpegArgs(stream, targets);

    addStreamLog(streamId, `Starting FFmpeg process`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const startupState = {
      lastLogLine: '',
      lastErrorLine: '',
      resolve: null,
      reject: null
    };

    const startupPromise = waitForStreamStartup(streamId, ffmpegProcess, startupState);

    let startTimeIso;
    if (isRetry && originalStartTime) {
      startTimeIso = originalStartTime;
    } else {
      startTimeIso = new Date().toISOString();
    }

    activeStreams.set(streamId, {
      process: ffmpegProcess,
      userId: stream.user_id,
      startTime: startTimeIso,
      endTime: originalEndTime,
      pid: ffmpegProcess.pid,
      lastActivity: Date.now()
    });

    ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        addStreamLog(streamId, `[OUT] ${msg}`);
        updateStreamActivity(streamId);
      }
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const lines = data.toString().split(/\r?\n|\r/g);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        updateStreamActivity(streamId);

        if (isProgressLogLine(line)) {
          if (startupState.resolve) {
            startupState.resolve();
          }
          continue;
        }

        addStreamLog(streamId, `[FFmpeg] ${line}`);

        const relevantLog = getRelevantStartupLog(line);
        if (relevantLog) {
          startupState.lastLogLine = relevantLog;

          if (/(error|failed|invalid|unsupported|broken pipe|connection.*refused|input\/output error|could not write header)/i.test(relevantLog)) {
            startupState.lastErrorLine = relevantLog;
          }
        }
      }
    });

    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `FFmpeg exited: code=${code}, signal=${signal}`);

      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      if (isManualStop) {
        manuallyStoppingStreams.delete(streamId);
        cleanupStreamData(streamId);
        return;
      }

      if (startupState.reject) {
        startupState.reject(buildStartupFailureMessage(
          startupState,
          `FFmpeg exited with code=${code}, signal=${signal}`
        ));
      }

      const currentStream = await Stream.findById(streamId);

      if (currentStream && currentStream.end_time) {
        const endTime = new Date(currentStream.end_time);
        const now = new Date();
        if (endTime.getTime() <= now.getTime()) {
          addStreamLog(streamId, 'Stream ended - scheduled end time reached');
          if (wasActive) {
            try {
              await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
              if (schedulerService) {
                schedulerService.handleStreamStopped(streamId);
              }
            } catch (e) { }
          }
          cleanupStreamData(streamId);
          return;
        }
      }

      const shouldRetry = signal === 'SIGSEGV' || signal === 'SIGKILL' || signal === 'SIGPIPE' ||
        (code !== 0 && code !== null) || (code === null && signal === null);

      if (shouldRetry && currentStream && currentStream.status !== 'offline') {
        const retryCount = streamRetryCount.get(streamId) || 0;

        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          const delay = getRetryDelay(retryCount);

          addStreamLog(streamId, `Retry #${retryCount + 1} in ${Math.round(delay / 1000)}s`);

          setTimeout(async () => {
            try {
              const latestStream = await Stream.findById(streamId);
              if (latestStream && latestStream.status !== 'offline') {
                if (latestStream.end_time) {
                  const endTime = new Date(latestStream.end_time);
                  const now = new Date();
                  if (endTime.getTime() <= now.getTime()) {
                    await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                    cleanupStreamData(streamId);
                    return;
                  }
                }
                const result = await startStream(streamId, true, baseUrl);
                if (!result.success) {
                  await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                  cleanupStreamData(streamId);
                }
              } else {
                cleanupStreamData(streamId);
              }
            } catch (e) {
              cleanupStreamData(streamId);
            }
          }, delay);
          return;
        } else {
          addStreamLog(streamId, `Max retries (${MAX_RETRY_ATTEMPTS}) reached`);
        }
      }

      if (wasActive && currentStream) {
        try {
          await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
          if (schedulerService) {
            schedulerService.handleStreamStopped(streamId);
          }
        } catch (e) { }
        cleanupStreamData(streamId);
      }
    });

    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Process error: ${err.message}`);
      startupState.lastErrorLine = err.message;
      if (startupState.reject) {
        startupState.reject(buildStartupFailureMessage(startupState, err.message));
      }
      activeStreams.delete(streamId);
      try {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      } catch (e) { }
      cleanupStreamData(streamId);
    });

    try {
      await startupPromise;
    } catch (startupError) {
      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, activeStreams.get(streamId));
      manuallyStoppingStreams.delete(streamId);
      activeStreams.delete(streamId);
      cleanupTempFiles(streamId);
      cleanupStreamData(streamId);
      throw startupError;
    }

    if (!isRetry) {
      await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });
    }

    if (schedulerService && originalEndTime) {
      if (typeof schedulerService.scheduleStreamTerminationByEndTime === 'function') {
        schedulerService.scheduleStreamTerminationByEndTime(streamId, originalEndTime, stream.user_id);
      }
    }

    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Start failed: ${error.message}`);
    return { success: false, error: error.message, code: error.code || null };
  } finally {
    startingStreams.delete(streamId);
  }
}

function updateStreamActivity(streamId) {
  const streamData = activeStreams.get(streamId);
  if (streamData) {
    streamData.lastActivity = Date.now();
  }
}

async function stopStream(streamId) {
  try {
    const streamData = activeStreams.get(streamId);
    const stream = await Stream.findById(streamId);

    if (!streamData) {
      if (stream && stream.status === 'live') {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (schedulerService) {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
        return { success: true, message: 'Stream status fixed' };
      }
      return { success: false, error: 'Stream is not active' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);

    await killFFmpegProcess(streamId, streamData);

    activeStreams.delete(streamId);
    cleanupTempFiles(streamId);

    if (stream) {
      if (stream.is_youtube_api && stream.youtube_broadcast_id) {
        try {
          const youtubeService = require('./youtubeService');
          await youtubeService.deleteYouTubeBroadcast(streamId);
        } catch (e) { }
      }

      await finalizeApiTargets(stream);

      await saveStreamHistory(stream);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
    }

    if (schedulerService) {
      schedulerService.handleStreamStopped(streamId);
    }

    cleanupStreamData(streamId);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    return { success: false, error: error.message };
  }
}

function cleanupTempFiles(streamId) {
  const tempDir = path.join(__dirname, '..', 'temp');
  const files = [
    path.join(tempDir, `playlist_${streamId}.txt`),
    path.join(tempDir, `playlist_audio_${streamId}.txt`)
  ];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) { }
  }
}

function isStreamActive(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return false;

  if (streamData.process && streamData.process.exitCode !== null) {
    activeStreams.delete(streamId);
    return false;
  }

  return true;
}

function isStreamStarting(streamId) {
  return startingStreams.has(streamId);
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getActiveStreamInfo(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return null;

  return {
    streamId,
    userId: streamData.userId,
    startTime: streamData.startTime,
    endTime: streamData.endTime,
    pid: streamData.pid,
    lastActivity: streamData.lastActivity,
    retryCount: streamRetryCount.get(streamId) || 0
  };
}


async function syncStreamStatuses() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      const isActive = activeStreams.has(stream.id);

      if (!isActive) {
        const retryCount = streamRetryCount.get(stream.id);
        if (retryCount !== undefined && retryCount < MAX_RETRY_ATTEMPTS) {
          continue;
        }

        if (stream.end_time) {
          const endTime = new Date(stream.end_time);
          if (endTime.getTime() <= Date.now()) {
            await Stream.updateStatus(stream.id, 'offline', stream.user_id);
            cleanupStreamData(stream.id);
            continue;
          }
        }

        await Stream.updateStatus(stream.id, 'offline', stream.user_id, { preserveEndTime: true });
        cleanupStreamData(stream.id);
      }
    }

    for (const [streamId, streamData] of activeStreams) {
      const stream = await Stream.findById(streamId);

      if (!stream) {
        const proc = streamData.process;
        if (proc && typeof proc.kill === 'function') {
          try {
            proc.kill('SIGTERM');
          } catch (e) { }
        }
        activeStreams.delete(streamId);
        cleanupStreamData(streamId);
        continue;
      }

      if (stream.status !== 'live') {
        await Stream.updateStatus(streamId, 'live', stream.user_id);
      }

      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        cleanupStreamData(streamId);
      }
    }
  } catch (error) { }
}

async function healthCheckStreams() {
  try {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [streamId, streamData] of activeStreams) {
      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }
          await Stream.updateStatus(streamId, 'offline', stream.user_id, { preserveEndTime: true });
        }
        cleanupStreamData(streamId);
        continue;
      }

      if (streamData.lastActivity && (now - streamData.lastActivity) > staleThreshold) {
        addStreamLog(streamId, 'Stream appears stale, restarting...');

        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              manuallyStoppingStreams.add(streamId);
              await killFFmpegProcess(streamId, streamData);
              activeStreams.delete(streamId);
              manuallyStoppingStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }

          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamId, streamData);
          activeStreams.delete(streamId);
          manuallyStoppingStreams.delete(streamId);

          setTimeout(async () => {
            try {
              const currentStream = await Stream.findById(streamId);
              if (currentStream && currentStream.status === 'live') {
                await startStream(streamId, true);
              }
            } catch (e) { }
          }, 3000);
        }
      }
    }
  } catch (error) { }
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      return false;
    }

    const startTime = new Date(stream.start_time);
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);

    if (durationSeconds < 10) {
      return false;
    }

    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;

    // Kolom `platforms` menyimpan semua tujuan (mis. "Youtube + Facebook").
    // Kolom lama `platform` tetap diisi agar tampilan riwayat versi lama aman.
    let platformsLabel = stream.platform || 'Custom';

    try {
      const historyTargets = await StreamTarget.findByStream(stream.id);

      if (historyTargets && historyTargets.length > 0) {
        platformsLabel = historyTargets
          .map((target) => String(target.platform || 'custom'))
          .map((name) => name.charAt(0).toUpperCase() + name.slice(1))
          .join(' + ');
      }
    } catch (targetError) {
      // Abaikan: fallback ke stream.platform di atas.
    }

    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: endTime.toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id,
      platforms: platformsLabel
    };

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id,
          platforms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id,
          historyData.platforms
        ],
        function (err) {
          if (err) {
            return reject(err);
          }
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    return false;
  }
}

async function gracefulShutdown() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  const streamIds = Array.from(activeStreams.keys());

  for (const streamId of streamIds) {
    try {
      const streamData = activeStreams.get(streamId);

      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, streamData);

      const stream = await Stream.findById(streamId);
      if (stream) {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      }

      activeStreams.delete(streamId);
      cleanupStreamData(streamId);
    } catch (e) { }
  }
}

process.on('SIGTERM', async () => {
  await gracefulShutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await gracefulShutdown();
  process.exit(0);
});

module.exports = {
  startStream,
  stopStream,
  validateCopyModeCompatibilityForInput,
  buildFFmpegArgs,
  buildOutputArgs,
  buildTargetUrls,
  resolveEncodingParams,
  getCopyConstraintsForTargets,
  escapeTeeUrl,
  finalizeApiTargets,
  isStreamActive,
  isStreamStarting,
  getActiveStreams,
  getActiveStreamInfo,
  getStreamLogs,
  syncStreamStatuses,
  healthCheckStreams,
  saveStreamHistory,
  gracefulShutdown,
  setSchedulerService
};
