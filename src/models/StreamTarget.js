const db = require('./database');
const { v4: uuidv4 } = require('uuid');

const BOOLEAN_COLUMNS = new Set(['is_enabled', 'monetization']);

function normalizeRow(row) {
  if (!row) return row;
  row.is_enabled = row.is_enabled === 1 || row.is_enabled === true;
  row.monetization = row.monetization === 1 || row.monetization === true;
  return row;
}

/**
 * Model tujuan streaming per-stream. Satu stream bisa punya beberapa target
 * (mis. YouTube + Facebook) untuk mode simulcast.
 */
class StreamTarget {
  static create(data) {
    const id = data.id || uuidv4();

    const record = {
      id,
      stream_id: data.stream_id,
      platform: (data.platform || 'custom').toLowerCase(),
      platform_icon: data.platform_icon || null,
      mode: data.mode || 'manual',
      rtmp_url: data.rtmp_url || null,
      stream_key: data.stream_key || null,
      is_enabled: data.is_enabled === false ? 0 : 1,
      status: data.status || 'idle',
      last_error: data.last_error || null,
      order_index: Number.isFinite(data.order_index) ? data.order_index : 0,
      youtube_channel_id: data.youtube_channel_id || null,
      facebook_target_id: data.facebook_target_id || null,
      youtube_broadcast_id: data.youtube_broadcast_id || null,
      youtube_stream_id: data.youtube_stream_id || null,
      facebook_live_video_id: data.facebook_live_video_id || null,
      facebook_permalink: data.facebook_permalink || null,
      title: data.title || null,
      description: data.description || null,
      privacy: data.privacy || null,
      tags: data.tags || null,
      category: data.category || null,
      thumbnail_path: data.thumbnail_path || null,
      monetization: data.monetization ? 1 : 0
    };

    const columns = Object.keys(record);
    const placeholders = columns.map(() => '?').join(', ');

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_targets (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map((column) => record[column]),
        function (err) {
          if (err) {
            console.error('Error creating stream target:', err.message);
            return reject(err);
          }
          resolve(normalizeRow({ ...record }));
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM stream_targets WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        resolve(normalizeRow(row) || null);
      });
    });
  }

  static findByStream(streamId, { enabledOnly = false } = {}) {
    return new Promise((resolve, reject) => {
      const where = enabledOnly
        ? 'WHERE stream_id = ? AND is_enabled = 1'
        : 'WHERE stream_id = ?';

      db.all(
        `SELECT * FROM stream_targets ${where} ORDER BY order_index ASC, created_at ASC`,
        [streamId],
        (err, rows) => {
          if (err) return reject(err);
          resolve((rows || []).map(normalizeRow));
        }
      );
    });
  }

  static async findPrimary(streamId) {
    const targets = await this.findByStream(streamId, { enabledOnly: true });
    return targets[0] || null;
  }

  static update(id, data) {
    const fields = [];
    const values = [];

    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined) return;

      if (BOOLEAN_COLUMNS.has(key) && typeof value === 'boolean') {
        fields.push(`${key} = ?`);
        values.push(value ? 1 : 0);
        return;
      }

      fields.push(`${key} = ?`);
      values.push(value);
    });

    if (fields.length === 0) {
      return Promise.resolve({ id });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE stream_targets SET ${fields.join(', ')} WHERE id = ?`,
        values,
        function (err) {
          if (err) {
            console.error('Error updating stream target:', err.message);
            return reject(err);
          }
          resolve({ id, ...data });
        }
      );
    });
  }

  static setStatus(id, status, lastError = null) {
    const payload = { status };

    if (status === 'live') {
      payload.started_at = new Date().toISOString();
      payload.last_error = null;
    }

    if (status === 'ended' || status === 'idle') {
      payload.ended_at = new Date().toISOString();
    }

    if (lastError) {
      payload.last_error = String(lastError).slice(0, 500);
    }

    return this.update(id, payload);
  }

  static deleteByStream(streamId) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM stream_targets WHERE stream_id = ?', [streamId], function (err) {
        if (err) return reject(err);
        resolve({ deleted: this.changes });
      });
    });
  }

  static delete(id) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM stream_targets WHERE id = ?', [id], function (err) {
        if (err) return reject(err);
        resolve({ deleted: this.changes > 0 });
      });
    });
  }

  /**
   * Ganti seluruh target milik satu stream (dipakai oleh endpoint update stream).
   */
  static async replaceForStream(streamId, targets) {
    await this.deleteByStream(streamId);

    const created = [];
    for (let index = 0; index < targets.length; index++) {
      created.push(await this.create({
        ...targets[index],
        stream_id: streamId,
        order_index: Number.isFinite(targets[index].order_index) ? targets[index].order_index : index
      }));
    }

    return created;
  }

  /**
   * Fallback penting untuk kompatibilitas: jika sebuah stream lama belum punya
   * baris stream_targets (mis. dibuat oleh versi sebelumnya saat aplikasi
   * berjalan), buat satu target dari kolom lama pada tabel streams.
   */
  static async ensureForStream(stream) {
    if (!stream || !stream.id) {
      return [];
    }

    const existing = await this.findByStream(stream.id);
    if (existing.length > 0) {
      return existing;
    }

    const isYoutubeApi = stream.is_youtube_api === true || stream.is_youtube_api === 1;
    const isFacebookApi = stream.is_facebook_api === true || stream.is_facebook_api === 1;

    let platform = (stream.platform || 'custom').toLowerCase();
    if (isYoutubeApi) platform = 'youtube';
    if (isFacebookApi) platform = 'facebook';

    await this.create({
      stream_id: stream.id,
      platform,
      platform_icon: stream.platform_icon,
      mode: isYoutubeApi || isFacebookApi ? 'api' : 'manual',
      rtmp_url: stream.rtmp_url,
      stream_key: stream.stream_key,
      status: stream.status === 'live' ? 'live' : 'idle',
      order_index: 0,
      youtube_channel_id: stream.youtube_channel_id,
      facebook_target_id: stream.facebook_target_id,
      youtube_broadcast_id: stream.youtube_broadcast_id,
      youtube_stream_id: stream.youtube_stream_id,
      facebook_live_video_id: stream.facebook_live_video_id,
      title: stream.title,
      description: isFacebookApi ? stream.facebook_description : stream.youtube_description,
      privacy: isFacebookApi ? stream.facebook_privacy : stream.youtube_privacy,
      tags: stream.youtube_tags,
      category: stream.youtube_category,
      thumbnail_path: stream.youtube_thumbnail,
      monetization: stream.youtube_monetization === true || stream.youtube_monetization === 1
    });

    return this.findByStream(stream.id);
  }
}

module.exports = StreamTarget;
