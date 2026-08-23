const db = require('./database');
const { v4: uuidv4 } = require('uuid');

/**
 * Model untuk tujuan live Facebook (Page / profil).
 * Struktur & gaya API sengaja dibuat identik dengan YoutubeChannel.js
 * agar route dan UI bisa memakai pola yang sama.
 */
class FacebookTarget {
  static findAll(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM facebook_targets WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
        [userId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      if (!id) return resolve(null);
      db.get('SELECT * FROM facebook_targets WHERE id = ?', [id], (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  static findByTargetId(userId, targetId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM facebook_targets WHERE user_id = ? AND target_id = ?',
        [userId, targetId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  }

  static findDefault(userId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM facebook_targets WHERE user_id = ? AND is_default = 1',
        [userId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        }
      );
    });
  }

  /**
   * Ambil target default; jika belum ada default, pakai target pertama.
   */
  static async resolveTarget(userId, targetId = null) {
    if (targetId) {
      const target = await this.findById(targetId);
      if (target && target.user_id === userId) {
        return target;
      }
      return null;
    }

    const defaultTarget = await this.findDefault(userId);
    if (defaultTarget) {
      return defaultTarget;
    }

    const targets = await this.findAll(userId);
    return targets[0] || null;
  }

  static async create(data) {
    const id = uuidv4();
    const existing = await this.findAll(data.user_id);
    const isDefault = existing.length === 0 ? 1 : 0;

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO facebook_targets (
          id, user_id, target_type, target_id, target_name, target_thumbnail,
          follower_count, access_token, token_expires_at, is_default
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.user_id,
          data.target_type || 'page',
          data.target_id,
          data.target_name || null,
          data.target_thumbnail || null,
          data.follower_count || '0',
          data.access_token || null,
          data.token_expires_at || null,
          isDefault
        ],
        function (err) {
          if (err) return reject(err);
          resolve({ id, ...data, is_default: isDefault });
        }
      );
    });
  }

  static update(id, data) {
    const fields = [];
    const values = [];

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) {
      return Promise.resolve({ id });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE facebook_targets SET ${fields.join(', ')} WHERE id = ?`,
        values,
        function (err) {
          if (err) return reject(err);
          resolve({ id, ...data });
        }
      );
    });
  }

  static setDefault(userId, targetId) {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run(
          'UPDATE facebook_targets SET is_default = 0 WHERE user_id = ?',
          [userId],
          (err) => {
            if (err) return reject(err);
          }
        );
        db.run(
          'UPDATE facebook_targets SET is_default = 1 WHERE id = ? AND user_id = ?',
          [targetId, userId],
          function (err) {
            if (err) return reject(err);
            resolve({ success: true });
          }
        );
      });
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM facebook_targets WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) return reject(err);
          resolve({ deleted: this.changes > 0 });
        }
      );
    });
  }

  static deleteAll(userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM facebook_targets WHERE user_id = ?',
        [userId],
        function (err) {
          if (err) return reject(err);
          resolve({ deleted: this.changes });
        }
      );
    });
  }

  static count(userId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT COUNT(*) as count FROM facebook_targets WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? row.count : 0);
        }
      );
    });
  }
}

module.exports = FacebookTarget;
