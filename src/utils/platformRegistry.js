/**
 * Registry platform streaming.
 *
 * Tujuannya: semua aturan yang berbeda antar platform (batas bitrate, codec
 * yang boleh dipakai di copy mode, protokol RTMP, ikon, dsb.) dikumpulkan di
 * SATU tempat, supaya menambah platform baru tidak perlu menyentuh
 * streamingService lagi.
 */

const PLATFORMS = {
  youtube: {
    key: 'youtube',
    label: 'YouTube',
    icon: 'ti-brand-youtube',
    color: '#FF0000',
    defaultRtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    ingestHosts: ['youtube.com', 'youtu.be', 'ytl-us-'],
    supportsApi: true,
    // YouTube menerima RTMP biasa.
    requiresTls: false,
    // Batas aman yang direkomendasikan YouTube untuk 1080p60.
    maxBitrateKbps: 12000,
    maxDurationHours: 12,
    allowedCopyVideoCodecs: ['h264'],
    allowedCopyAudioCodecs: ['aac', 'mp3'],
    recommendedAudioSampleRate: 44100,
    maxKeyframeIntervalSeconds: 4
  },
  facebook: {
    key: 'facebook',
    label: 'Facebook',
    icon: 'ti-brand-facebook',
    color: '#1877F2',
    // Facebook sudah mewajibkan RTMPS (RTMP biasa ditolak sejak 2020).
    defaultRtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp',
    ingestHosts: ['facebook.com', 'fb.gg', 'live-api-s.facebook.com'],
    supportsApi: true,
    requiresTls: true,
    // Batas keras Facebook Live: 4000 kbps video / 128 kbps audio.
    maxBitrateKbps: 4000,
    maxAudioBitrateKbps: 128,
    maxDurationHours: 8,
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 60,
    // Facebook TIDAK menerima MP3 di RTMP ingest, hanya AAC.
    allowedCopyVideoCodecs: ['h264'],
    allowedCopyAudioCodecs: ['aac'],
    recommendedAudioSampleRate: 48000,
    // Keyframe wajib maksimal setiap 2 detik.
    maxKeyframeIntervalSeconds: 2
  },
  twitch: {
    key: 'twitch',
    label: 'Twitch',
    icon: 'ti-brand-twitch',
    color: '#9146FF',
    ingestHosts: ['twitch.tv'],
    supportsApi: false,
    requiresTls: false,
    maxBitrateKbps: 6000,
    allowedCopyVideoCodecs: ['h264'],
    allowedCopyAudioCodecs: ['aac'],
    recommendedAudioSampleRate: 44100,
    maxKeyframeIntervalSeconds: 2
  },
  tiktok: {
    key: 'tiktok',
    label: 'TikTok',
    icon: 'ti-brand-tiktok',
    color: '#000000',
    ingestHosts: ['tiktok.com'],
    supportsApi: false,
    requiresTls: false,
    maxBitrateKbps: 6000,
    allowedCopyVideoCodecs: ['h264'],
    allowedCopyAudioCodecs: ['aac'],
    recommendedAudioSampleRate: 44100,
    maxKeyframeIntervalSeconds: 2
  },
  instagram: {
    key: 'instagram',
    label: 'Instagram',
    icon: 'ti-brand-instagram',
    color: '#E4405F',
    ingestHosts: ['instagram.com'],
    supportsApi: false,
    requiresTls: false,
    maxBitrateKbps: 4000,
    allowedCopyVideoCodecs: ['h264'],
    allowedCopyAudioCodecs: ['aac'],
    recommendedAudioSampleRate: 44100,
    maxKeyframeIntervalSeconds: 2
  },
  custom: {
    key: 'custom',
    label: 'Custom RTMP',
    icon: 'ti-broadcast',
    color: '#6c757d',
    ingestHosts: [],
    supportsApi: false,
    requiresTls: false,
    maxBitrateKbps: null,
    allowedCopyVideoCodecs: ['h264', 'hevc'],
    allowedCopyAudioCodecs: ['aac', 'mp3'],
    recommendedAudioSampleRate: 44100,
    maxKeyframeIntervalSeconds: null
  }
};

const STREAM_MODES = {
  SINGLE: 'single',
  MULTI: 'multi'
};

function getPlatform(key) {
  if (!key) return PLATFORMS.custom;
  return PLATFORMS[String(key).toLowerCase()] || PLATFORMS.custom;
}

/**
 * Deteksi platform dari URL RTMP. Dipakai untuk stream manual, supaya
 * aturan bitrate/codec Facebook otomatis berlaku walau user hanya menempel
 * persistent stream key tanpa memakai Graph API.
 */
function detectPlatformFromUrl(rtmpUrl) {
  if (!rtmpUrl) return PLATFORMS.custom;

  const url = String(rtmpUrl).toLowerCase();

  for (const platform of Object.values(PLATFORMS)) {
    if (!platform.ingestHosts || platform.ingestHosts.length === 0) continue;
    if (platform.ingestHosts.some((host) => url.includes(host))) {
      return platform;
    }
  }

  return PLATFORMS.custom;
}

/**
 * Platform efektif untuk sebuah target stream.
 */
function resolveTargetPlatform(target) {
  if (!target) return PLATFORMS.custom;

  if (target.platform && PLATFORMS[String(target.platform).toLowerCase()]) {
    return PLATFORMS[String(target.platform).toLowerCase()];
  }

  return detectPlatformFromUrl(target.rtmp_url);
}

function isFacebookTarget(target) {
  return resolveTargetPlatform(target).key === 'facebook';
}

function isYouTubeTarget(target) {
  return resolveTargetPlatform(target).key === 'youtube';
}

/**
 * Gabungkan URL dan stream key menjadi satu URL output FFmpeg.
 * Menangani kasus user menempel key yang sudah berisi query string
 * (Facebook kadang memberi `?s_bl=1&s_...` pada secure_stream_url).
 */
function buildIngestUrl(rtmpUrl, streamKey) {
  const base = String(rtmpUrl || '').trim().replace(/\/+$/, '');
  const key = String(streamKey || '').trim().replace(/^\/+/, '');

  if (!base) return key;
  if (!key) return base;

  return `${base}/${key}`;
}

/**
 * Bitrate paling aman untuk sekumpulan target.
 * Saat simulcast, satu encode dipakai bersama, jadi kita harus memakai
 * batas TERKECIL di antara semua platform (mis. YouTube 12000 + Facebook 4000
 * => 4000) agar Facebook tidak memutus koneksi.
 */
function resolveSafeBitrate(requestedBitrate, targets) {
  const requested = Number(requestedBitrate) || 0;
  const limits = (targets || [])
    .map((target) => resolveTargetPlatform(target).maxBitrateKbps)
    .filter((limit) => Number.isFinite(limit) && limit > 0);

  if (limits.length === 0) {
    return { bitrate: requested, capped: false, limit: null };
  }

  const limit = Math.min(...limits);

  if (requested > 0 && requested > limit) {
    return { bitrate: limit, capped: true, limit };
  }

  return { bitrate: requested, capped: false, limit };
}

/**
 * Interval keyframe (detik) paling ketat dari semua target.
 */
function resolveKeyframeIntervalSeconds(targets) {
  const intervals = (targets || [])
    .map((target) => resolveTargetPlatform(target).maxKeyframeIntervalSeconds)
    .filter((value) => Number.isFinite(value) && value > 0);

  if (intervals.length === 0) {
    return 2;
  }

  return Math.min(...intervals);
}

/**
 * Sample rate audio yang dipakai saat re-encode.
 * Facebook merekomendasikan 48 kHz; kalau ada target Facebook kita pakai itu.
 */
function resolveAudioSampleRate(targets) {
  const rates = (targets || []).map((target) => resolveTargetPlatform(target));

  if (rates.some((platform) => platform.key === 'facebook')) {
    return 48000;
  }

  return 44100;
}

function requiresTls(targets) {
  return (targets || []).some((target) => resolveTargetPlatform(target).requiresTls);
}

module.exports = {
  PLATFORMS,
  STREAM_MODES,
  getPlatform,
  detectPlatformFromUrl,
  resolveTargetPlatform,
  isFacebookTarget,
  isYouTubeTarget,
  buildIngestUrl,
  resolveSafeBitrate,
  resolveKeyframeIntervalSeconds,
  resolveAudioSampleRate,
  requiresTls
};
