const axios = require('axios');
const Stream = require('../models/Stream');
const User = require('../models/User');
const FacebookTarget = require('../models/FacebookTarget');
const StreamTarget = require('../models/StreamTarget');
const { encrypt, decrypt } = require('../utils/encryption');
const { PLATFORMS } = require('../utils/platformRegistry');

/**
 * Service integrasi Facebook Live via Graph API.
 *
 * Catatan penting:
 *  - TIDAK memakai SDK Facebook apa pun. Hanya `axios` yang sudah menjadi
 *    dependency proyek, jadi `npm install` tidak berubah sama sekali.
 *  - Semua token disimpan terenkripsi memakai src/utils/encryption.js.
 *  - Semua fungsi mengembalikan error dengan pesan yang enak dibaca user,
 *    bukan dump JSON Graph API.
 */

const GRAPH_VERSION = process.env.FB_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const REQUEST_TIMEOUT = 20000;

const PAGE_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'publish_video'
];

function buildGraphError(error, fallbackMessage) {
  const apiError = error?.response?.data?.error;

  if (apiError) {
    const parts = [apiError.message || fallbackMessage];

    if (apiError.error_user_msg && apiError.error_user_msg !== apiError.message) {
      parts.push(apiError.error_user_msg);
    }

    const message = parts.filter(Boolean).join(' - ');
    const wrapped = new Error(`Facebook: ${message}`);
    wrapped.facebookCode = apiError.code;
    wrapped.facebookSubcode = apiError.error_subcode;
    wrapped.facebookType = apiError.type;
    return wrapped;
  }

  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return new Error('Facebook: permintaan ke Graph API timeout. Periksa koneksi internet server.');
  }

  return new Error(`Facebook: ${error?.message || fallbackMessage}`);
}

async function graphGet(endpoint, params = {}) {
  try {
    const response = await axios.get(`${GRAPH_BASE}${endpoint}`, {
      params,
      timeout: REQUEST_TIMEOUT
    });
    return response.data;
  } catch (error) {
    throw buildGraphError(error, `Gagal memanggil ${endpoint}`);
  }
}

async function graphPost(endpoint, data = {}, params = {}) {
  try {
    const response = await axios.post(`${GRAPH_BASE}${endpoint}`, data, {
      params,
      timeout: REQUEST_TIMEOUT,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    throw buildGraphError(error, `Gagal memanggil ${endpoint}`);
  }
}

/**
 * URL login OAuth Facebook.
 */
function buildAuthUrl({ appId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state: state || '',
    response_type: 'code',
    scope: PAGE_SCOPES.join(','),
    auth_type: 'rerequest'
  });

  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Tukar authorization code menjadi short-lived user access token.
 */
async function exchangeCodeForToken({ appId, appSecret, redirectUri, code }) {
  const data = await graphGet('/oauth/access_token', {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code
  });

  if (!data.access_token) {
    throw new Error('Facebook: tidak menerima access token dari Graph API.');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null
  };
}

/**
 * Tukar short-lived token menjadi long-lived token (berlaku ~60 hari).
 */
async function exchangeForLongLivedToken({ appId, appSecret, accessToken }) {
  const data = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: accessToken
  });

  return {
    accessToken: data.access_token || accessToken,
    expiresIn: data.expires_in || null
  };
}

/**
 * Ambil daftar Page yang bisa dipakai live oleh user.
 * Page access token yang dikembalikan tidak kedaluwarsa selama user token
 * yang dipakai untuk mengambilnya adalah long-lived token.
 */
async function listPages(userAccessToken) {
  const data = await graphGet('/me/accounts', {
    access_token: userAccessToken,
    fields: 'id,name,access_token,followers_count,fan_count,picture{url},tasks',
    limit: 100
  });

  return (data.data || []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    followerCount: String(page.followers_count || page.fan_count || 0),
    picture: page.picture?.data?.url || null,
    canPublish: Array.isArray(page.tasks) ? page.tasks.includes('CREATE_CONTENT') : true
  }));
}

/**
 * Verifikasi token masih valid (dipakai halaman settings).
 */
async function verifyToken(accessToken) {
  try {
    const data = await graphGet('/me', { access_token: accessToken, fields: 'id,name' });
    return { valid: true, id: data.id, name: data.name };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Pisahkan secure_stream_url Facebook menjadi base URL + stream key.
 * Contoh input:
 *   rtmps://live-api-s.facebook.com:443/rtmp/FB-123456-0-AbCdEf
 * Output:
 *   { rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp', streamKey: 'FB-123456-0-AbCdEf' }
 */
function splitStreamUrl(fullUrl) {
  if (!fullUrl) {
    return { rtmpUrl: PLATFORMS.facebook.defaultRtmpUrl, streamKey: '' };
  }

  const trimmed = String(fullUrl).trim();
  const separatorIndex = trimmed.lastIndexOf('/');

  if (separatorIndex <= 0) {
    return { rtmpUrl: PLATFORMS.facebook.defaultRtmpUrl, streamKey: trimmed };
  }

  return {
    rtmpUrl: trimmed.slice(0, separatorIndex),
    streamKey: trimmed.slice(separatorIndex + 1)
  };
}

function resolvePageToken(target) {
  if (!target || !target.access_token) {
    return null;
  }

  // Token disimpan terenkripsi; decrypt() mengembalikan null jika gagal.
  const decrypted = decrypt(target.access_token);
  return decrypted || null;
}

/**
 * Buat live video baru di Facebook dan kembalikan kredensial ingest.
 *
 * @param {object} options
 * @param {object} options.facebookTarget baris facebook_targets
 * @param {string} options.title
 * @param {string} options.description
 * @param {string} options.privacy  SELF | FRIENDS | EVERYONE (hanya untuk profil)
 * @returns {Promise<{liveVideoId: string, rtmpUrl: string, streamKey: string, permalink: string|null}>}
 */
async function createLiveVideo({ facebookTarget, title, description, privacy }) {
  if (!facebookTarget) {
    throw new Error('Facebook: target (Page) belum dipilih.');
  }

  const pageToken = resolvePageToken(facebookTarget);
  if (!pageToken) {
    throw new Error('Facebook: access token Page tidak valid. Hubungkan ulang akun Facebook di halaman Settings.');
  }

  const payload = {
    access_token: pageToken,
    status: 'LIVE_NOW',
    title: (title || 'Live Stream').slice(0, 255),
    description: (description || '').slice(0, 5000)
  };

  // privacy hanya berlaku untuk live di profil pribadi. Page memakai
  // visibilitas Page itu sendiri, dan mengirim privacy justru memicu error.
  if (facebookTarget.target_type === 'profile' && privacy) {
    payload.privacy = JSON.stringify({ value: privacy });
  }

  const data = await graphPost(`/${facebookTarget.target_id}/live_videos`, payload);

  if (!data.id) {
    throw new Error('Facebook: Graph API tidak mengembalikan ID live video.');
  }

  const fullUrl = data.secure_stream_url || data.stream_url;
  if (!fullUrl) {
    throw new Error('Facebook: Graph API tidak mengembalikan stream URL. Pastikan Page punya izin publish video.');
  }

  const { rtmpUrl, streamKey } = splitStreamUrl(fullUrl);

  let permalink = null;
  try {
    const details = await graphGet(`/${data.id}`, {
      access_token: pageToken,
      fields: 'permalink_url'
    });
    permalink = details.permalink_url ? `https://www.facebook.com${details.permalink_url}` : null;
  } catch (e) {
    // permalink bersifat opsional, kegagalan di sini tidak boleh membatalkan live.
  }

  return {
    liveVideoId: data.id,
    rtmpUrl,
    streamKey,
    fullUrl,
    permalink
  };
}

/**
 * Akhiri live video Facebook.
 */
async function endLiveVideo({ facebookTarget, liveVideoId }) {
  if (!liveVideoId) {
    return { success: false, error: 'liveVideoId tidak tersedia' };
  }

  const pageToken = resolvePageToken(facebookTarget);
  if (!pageToken) {
    return { success: false, error: 'Access token Page tidak valid' };
  }

  try {
    await graphPost(`/${liveVideoId}`, {
      access_token: pageToken,
      end_live_video: true
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Status live video (dipakai untuk diagnosa di UI).
 */
async function getLiveVideoStatus({ facebookTarget, liveVideoId }) {
  const pageToken = resolvePageToken(facebookTarget);
  if (!pageToken || !liveVideoId) {
    return null;
  }

  try {
    return await graphGet(`/${liveVideoId}`, {
      access_token: pageToken,
      fields: 'id,status,broadcast_status,live_views,permalink_url'
    });
  } catch (error) {
    return null;
  }
}

/**
 * Siapkan Facebook live untuk sebuah stream_target ber-mode `api`.
 * Menyimpan hasilnya ke stream_targets DAN ke kolom legacy pada tabel streams
 * agar UI/riwayat versi lama tetap menampilkan data yang benar.
 *
 * @returns {Promise<{rtmpUrl: string, streamKey: string, liveVideoId: string, permalink: string|null}>}
 */
async function prepareTargetForStream(stream, target) {
  const facebookTarget = await FacebookTarget.resolveTarget(
    stream.user_id,
    target.facebook_target_id || stream.facebook_target_id
  );

  if (!facebookTarget) {
    throw new Error('Facebook: belum ada Page yang terhubung. Buka Settings > Integration untuk menghubungkan Facebook.');
  }

  const live = await createLiveVideo({
    facebookTarget,
    title: target.title || stream.title,
    description: target.description || stream.facebook_description,
    privacy: target.privacy || stream.facebook_privacy
  });

  await StreamTarget.update(target.id, {
    rtmp_url: live.rtmpUrl,
    stream_key: live.streamKey,
    facebook_live_video_id: live.liveVideoId,
    facebook_permalink: live.permalink,
    facebook_target_id: facebookTarget.id,
    last_error: null
  });

  await Stream.update(stream.id, {
    facebook_live_video_id: live.liveVideoId,
    facebook_permalink: live.permalink,
    facebook_stream_url: live.fullUrl,
    facebook_target_id: facebookTarget.id
  });

  return live;
}

/**
 * Akhiri live Facebook untuk satu target (dipanggil saat stream berhenti).
 */
async function finalizeTarget(stream, target) {
  const liveVideoId = target.facebook_live_video_id || stream.facebook_live_video_id;
  if (!liveVideoId) {
    return { success: false, error: 'Tidak ada live video aktif' };
  }

  const facebookTarget = await FacebookTarget.resolveTarget(
    stream.user_id,
    target.facebook_target_id || stream.facebook_target_id
  );

  const result = await endLiveVideo({ facebookTarget, liveVideoId });

  await StreamTarget.update(target.id, {
    facebook_live_video_id: null,
    status: 'ended'
  });

  await Stream.update(stream.id, {
    facebook_live_video_id: null
  });

  return result;
}

/**
 * Simpan kredensial app Facebook milik user.
 */
async function saveAppCredentials(userId, { appId, appSecret }) {
  const updates = { facebook_app_id: appId };

  if (appSecret) {
    updates.facebook_app_secret = encrypt(appSecret);
  }

  await User.update(userId, updates);
  return { success: true };
}

/**
 * Ambil kredensial app Facebook milik user (secret sudah didekripsi).
 */
async function getAppCredentials(userId) {
  const user = await User.findById(userId);

  if (!user || !user.facebook_app_id || !user.facebook_app_secret) {
    return null;
  }

  const appSecret = decrypt(user.facebook_app_secret);
  if (!appSecret) {
    return null;
  }

  return { appId: user.facebook_app_id, appSecret };
}

module.exports = {
  GRAPH_VERSION,
  GRAPH_BASE,
  PAGE_SCOPES,
  buildAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listPages,
  verifyToken,
  splitStreamUrl,
  createLiveVideo,
  endLiveVideo,
  getLiveVideoStatus,
  prepareTargetForStream,
  finalizeTarget,
  saveAppCredentials,
  getAppCredentials
};
