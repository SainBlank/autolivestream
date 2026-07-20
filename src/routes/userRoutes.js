const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Video = require('../models/Video');
const MediaFolder = require('../models/MediaFolder');
const Playlist = require('../models/Playlist');
const Stream = require('../models/Stream');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const systemMonitor = require('../services/systemMonitor');
const packageJson = require('../../package.json');
const { upload } = require('../middleware/uploadMiddleware');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');
// FIX: userRoutes referenced a top-level `db` (e.g. in /welcome/continue) that
// was never imported -> ReferenceError. Import the unified DB handle here.
const db = require('../models/database');

router.get('/', (req, res) => {
  res.redirect('/dashboard');
});
router.get('/welcome', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || user.welcome_shown === 1) {
      return res.redirect('/dashboard');
    }
    res.render('welcome', {
      title: 'Welcome'
    });
  } catch (error) {
    console.error('Welcome page error:', error);
    res.redirect('/dashboard');
  }
});

router.get('/welcome-bypass', (req, res) => {
  res.render('welcome', {
    title: 'Welcome'
  });
});
router.get('/welcome/continue', isAuthenticated, async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET welcome_shown = 1 WHERE id = ?', [req.session.userId], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Welcome continue error:', error);
    res.redirect('/dashboard');
  }
});
router.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    const YoutubeChannel = require('../models/YoutubeChannel');
    const youtubeChannels = await YoutubeChannel.findAll(req.session.userId);
    const hasYoutubeCredentials = !!(user.youtube_client_id && user.youtube_client_secret);
    const isYoutubeConnected = youtubeChannels.length > 0;
    const defaultChannel = youtubeChannels.find(c => c.is_default) || youtubeChannels[0];
    
    const initialStreamsData = await Stream.findAllPaginated(req.session.userId, {
      page: 1,
      limit: 10,
      search: ''
    });
    
    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      user: user,
      youtubeConnected: isYoutubeConnected,
      youtubeChannels: youtubeChannels,
      youtubeChannelName: defaultChannel?.channel_name || '',
      youtubeChannelThumbnail: defaultChannel?.channel_thumbnail || '',
      youtubeSubscriberCount: defaultChannel?.subscriber_count || '0',
      hasYoutubeCredentials: hasYoutubeCredentials,
      initialStreams: JSON.stringify(initialStreamsData.streams),
      initialPagination: JSON.stringify(initialStreamsData.pagination)
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.redirect('/login');
  }
});
function normalizeFolderId(folderId) {
  if (folderId === undefined || folderId === null || folderId === '' || folderId === 'root' || folderId === 'null') {
    return null;
  }
  return folderId;
}

async function findLiveStreamConflictsForVideos(userId, videoIds) {
  const targetIds = Array.from(new Set((videoIds || []).filter(Boolean)));
  if (targetIds.length === 0) {
    return [];
  }

  const targetIdSet = new Set(targetIds);
  const liveStreams = await Stream.findAll(userId, 'live');
  const playlistCache = new Map();
  const conflicts = [];

  for (const stream of liveStreams) {
    if (!stream || !stream.video_id) {
      continue;
    }

    if (stream.video_type === 'video') {
      if (targetIdSet.has(stream.video_id)) {
        conflicts.push({
          videoId: stream.video_id,
          streamId: stream.id,
          streamTitle: stream.title || 'Untitled stream'
        });
      }
      continue;
    }

    if (stream.video_type === 'playlist') {
      let playlist = playlistCache.get(stream.video_id);
      if (playlist === undefined) {
        playlist = await Playlist.findByIdWithVideos(stream.video_id);
        playlistCache.set(stream.video_id, playlist || null);
      }

      if (!playlist) {
        continue;
      }

      const playlistItems = [...(playlist.videos || []), ...(playlist.audios || [])];
      for (const item of playlistItems) {
        if (targetIdSet.has(item.id)) {
          conflicts.push({
            videoId: item.id,
            streamId: stream.id,
            streamTitle: stream.title || playlist.name || 'Untitled stream'
          });
        }
      }
    }
  }

  return conflicts;
}

function buildDeleteBlockedMessage(conflicts, videoMap, targetType) {
  if (!conflicts || conflicts.length === 0) {
    return null;
  }

  const firstConflict = conflicts[0];
  const streamTitle = firstConflict.streamTitle || 'Untitled stream';
  const blockedItem = videoMap.get(firstConflict.videoId);
  const blockedItemTitle = blockedItem?.title || 'This file';

  if (targetType === 'folder') {
    return `Cannot delete folder because "${blockedItemTitle}" is currently used by live stream "${streamTitle}". Stop the stream first.`;
  }

  return `Cannot delete file because it is currently used by live stream "${streamTitle}". Stop the stream first.`;
}

router.get('/gallery', isAuthenticated, async (req, res) => {
  try {
    const currentFolderId = normalizeFolderId(req.query.folder);
    const folders = await MediaFolder.findAllByUser(req.session.userId);
    const currentFolder = currentFolderId ? await MediaFolder.findById(currentFolderId, req.session.userId) : null;
    if (currentFolderId && !currentFolder) {
      return res.redirect('/gallery');
    }
    const videos = await Video.findByUserAndFolder(req.session.userId, currentFolderId);
    res.render('gallery', {
      title: 'Video Gallery',
      active: 'gallery',
      user: await User.findById(req.session.userId),
      videos: videos,
      folders: folders,
      currentFolder: currentFolder,
      currentFolderId: currentFolderId || ''
    });
  } catch (error) {
    console.error('Gallery error:', error);
    res.redirect('/dashboard');
  }
});

router.get('/api/gallery/data', isAuthenticated, async (req, res) => {
  try {
    const currentFolderId = normalizeFolderId(req.query.folder);
    const folders = await MediaFolder.findAllByUser(req.session.userId);
    const currentFolder = currentFolderId ? await MediaFolder.findById(currentFolderId, req.session.userId) : null;

    if (currentFolderId && !currentFolder) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    const videos = await Video.findByUserAndFolder(req.session.userId, currentFolderId);
    res.json({
      success: true,
      videos,
      folders,
      currentFolder,
      currentFolderId: currentFolderId || ''
    });
  } catch (error) {
    console.error('Gallery data error:', error);
    res.status(500).json({ success: false, error: 'Failed to load gallery data' });
  }
});

router.post('/api/media-folders', isAuthenticated, [
  body('name').trim().notEmpty().withMessage('Folder name is required').isLength({ max: 80 }).withMessage('Folder name is too long')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const name = req.body.name.trim();
    const existingFolder = await MediaFolder.findByName(req.session.userId, name);
    if (existingFolder) {
      return res.status(400).json({ success: false, error: 'Folder name already exists' });
    }

    const folder = await MediaFolder.create({
      name,
      user_id: req.session.userId
    });

    res.json({ success: true, folder });
  } catch (error) {
    console.error('Error creating media folder:', error);
    res.status(500).json({ success: false, error: 'Failed to create folder' });
  }
});

router.put('/api/media-folders/:id', isAuthenticated, [
  body('name').trim().notEmpty().withMessage('Folder name is required').isLength({ max: 80 }).withMessage('Folder name is too long')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const folder = await MediaFolder.findById(req.params.id, req.session.userId);
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    const name = req.body.name.trim();
    const existingFolder = await MediaFolder.findByName(req.session.userId, name);
    if (existingFolder && existingFolder.id !== folder.id) {
      return res.status(400).json({ success: false, error: 'Folder name already exists' });
    }

    await MediaFolder.update(folder.id, req.session.userId, { name });
    res.json({ success: true, message: 'Folder renamed successfully' });
  } catch (error) {
    console.error('Error renaming media folder:', error);
    res.status(500).json({ success: false, error: 'Failed to rename folder' });
  }
});

router.delete('/api/media-folders/:id', isAuthenticated, async (req, res) => {
  try {
    const folder = await MediaFolder.findById(req.params.id, req.session.userId);
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    const videosInFolder = await Video.findByUserAndFolder(req.session.userId, folder.id);
    const videoMap = new Map(videosInFolder.map(video => [video.id, video]));
    const conflicts = await findLiveStreamConflictsForVideos(req.session.userId, videosInFolder.map(video => video.id));
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: buildDeleteBlockedMessage(conflicts, videoMap, 'folder')
      });
    }

    for (const video of videosInFolder) {
      await Video.delete(video.id);
    }

    await MediaFolder.delete(folder.id, req.session.userId);
    res.json({ success: true, message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Error deleting media folder:', error);
    res.status(500).json({ success: false, error: 'Failed to delete folder' });
  }
});

router.put('/api/videos/:id/folder', isAuthenticated, async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }

    await Video.update(req.params.id, { folder_id: folderId });
    res.json({ success: true, folderId });
  } catch (error) {
    console.error('Error moving video to folder:', error);
    res.status(500).json({ success: false, error: 'Failed to move video' });
  }
});
router.get('/settings', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    
    const { decrypt } = require('../utils/encryption');
    const YoutubeChannel = require('../models/YoutubeChannel');
    const AppSettings = require('../models/AppSettings');
    const hasYoutubeCredentials = !!(user.youtube_client_id && user.youtube_client_secret);
    const youtubeChannels = await YoutubeChannel.findAll(req.session.userId);
    const isYoutubeConnected = youtubeChannels.length > 0;
    const defaultChannel = youtubeChannels.find(c => c.is_default) || youtubeChannels[0];
    
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: user,
      appVersion: packageJson.version,
      youtubeClientId: user.youtube_client_id || '',
      youtubeClientSecret: user.youtube_client_secret ? '����������������' : '',
      youtubeConnected: isYoutubeConnected,
      youtubeChannels: youtubeChannels,
      youtubeChannelName: defaultChannel?.channel_name || '',
      youtubeChannelThumbnail: defaultChannel?.channel_thumbnail || '',
      youtubeSubscriberCount: defaultChannel?.subscriber_count || '0',
      hasYoutubeCredentials: hasYoutubeCredentials,
      recaptchaSiteKey: recaptchaSettings.siteKey || '',
      recaptchaSecretKey: recaptchaSettings.secretKey ? '����������������' : '',
      hasRecaptchaKeys: recaptchaSettings.hasKeys,
      recaptchaEnabled: recaptchaSettings.enabled,
      success: req.query.success || null,
      error: req.query.error || null,
      activeTab: req.query.activeTab || null
    });
  } catch (error) {
    console.error('Settings error:', error);
    res.redirect('/login');
  }
});
router.get('/history', isAuthenticated, async (req, res) => {
  try {
    const db = require('../models/database').db;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
    const platform = req.query.platform || 'all';
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE h.user_id = ?';
    const params = [req.session.userId];

    if (platform !== 'all') {
      whereClause += ' AND h.platform = ?';
      params.push(platform);
    }

    if (search) {
      whereClause += ' AND h.title LIKE ?';
      params.push(`%${search}%`);
    }

    const totalCount = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COUNT(*) as count FROM stream_history h ${whereClause}`,
        params,
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    const history = await new Promise((resolve, reject) => {
      db.all(
        `SELECT h.*, v.thumbnail_path 
         FROM stream_history h 
         LEFT JOIN videos v ON h.video_id = v.id 
         ${whereClause}
         ORDER BY h.start_time ${sort}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const totalPages = Math.ceil(totalCount / limit);

    res.render('history', {
      active: 'history',
      title: 'Stream History',
      history: history,
      // helpers TIDAK perlu dioper di sini: sudah tersedia global lewat app.locals.helpers (app.js).
      // Baris lama `helpers: app.locals.helpers` bikin "app is not defined" karena `app` tidak ada di file router ini.
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        sort: req.query.sort || 'newest',
        platform,
        search
      }
    });
  } catch (error) {
    console.error('Error fetching stream history:', error);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Failed to load stream history',
      error: error
    });
  }
});
router.delete('/api/history/:id', isAuthenticated, async (req, res) => {
  try {
    const db = require('../models/database').db;
    const historyId = req.params.id;
    const history = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM stream_history WHERE id = ? AND user_id = ?',
        [historyId, req.session.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    if (!history) {
      return res.status(404).json({
        success: false,
        error: 'History entry not found or not authorized'
      });
    }
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM stream_history WHERE id = ?',
        [historyId],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
    res.json({ success: true, message: 'History entry deleted' });
  } catch (error) {
    console.error('Error deleting history entry:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete history entry'
    });
  }
});

router.get('/users', isAdmin, async (req, res) => {
  try {
    const users = await User.findAll();
    
    const usersWithStats = await Promise.all(users.map(async (user) => {
      const videoStats = await new Promise((resolve, reject) => {
        db.get(
          `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalSize 
           FROM videos WHERE user_id = ?`,
          [user.id],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });
      
      const streamStats = await new Promise((resolve, reject) => {
         db.get(
           `SELECT COUNT(*) as count FROM streams WHERE user_id = ?`,
           [user.id],
           (err, row) => {
             if (err) reject(err);
             else resolve(row);
           }
         );
       });
       
       const activeStreamStats = await new Promise((resolve, reject) => {
         db.get(
           `SELECT COUNT(*) as count FROM streams WHERE user_id = ? AND status = 'live'`,
           [user.id],
           (err, row) => {
             if (err) reject(err);
             else resolve(row);
           }
         );
       });
      
      const formatFileSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };
      
      return {
         ...user,
         videoCount: videoStats.count,
         totalVideoSize: videoStats.totalSize > 0 ? formatFileSize(videoStats.totalSize) : null,
         streamCount: streamStats.count,
         activeStreamCount: activeStreamStats.count
       };
    }));
    
    res.render('users', {
      title: 'User Management',
      active: 'users',
      users: usersWithStats,
      user: req.user
    });
  } catch (error) {
    console.error('Users page error:', error);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Failed to load users page',
      user: req.user
    });
  }
});

router.post('/api/users/status', isAdmin, async (req, res) => {
  try {
    const { userId, status } = req.body;
    
    if (!userId || !status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID or status'
      });
    }

    if (userId == req.session.userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot change your own status'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await User.updateStatus(userId, status);
    
    res.json({
      success: true,
      message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status'
    });
  }
});

router.post('/api/users/role', isAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body;
    
    if (!userId || !role || !['admin', 'member'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID or role'
      });
    }

    if (userId == req.session.userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot change your own role'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await User.updateRole(userId, role);
    
    res.json({
      success: true,
      message: `User role updated to ${role} successfully`
    });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user role'
    });
  }
});

router.post('/api/users/delete', isAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    if (userId == req.session.userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await User.delete(userId);
    
    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
});

router.post('/api/users/update', isAdmin, upload.single('avatar'), async (req, res) => {
  try {
    const { userId, username, role, status, password, diskLimit } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    let avatarPath = user.avatar_path;
    if (req.file) {
      avatarPath = `/uploads/avatars/${req.file.filename}`;
    }

    const updateData = {
      username: username || user.username,
      user_role: role || user.user_role,
      status: status || user.status,
      avatar_path: avatarPath,
      disk_limit: diskLimit !== undefined && diskLimit !== '' ? parseInt(diskLimit) : user.disk_limit
    };

    if (password && password.trim() !== '') {
      const bcrypt = require('bcrypt');
      updateData.password = await bcrypt.hash(password, 10);
    }

    await User.updateProfile(userId, updateData);
    
    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user'
    });
  }
});

router.post('/api/users/create', isAdmin, upload.single('avatar'), async (req, res) => {
  try {
    const { username, role, status, password, diskLimit } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    let avatarPath = '/uploads/avatars/default-avatar.png';
    if (req.file) {
      avatarPath = `/uploads/avatars/${req.file.filename}`;
    }

    const userData = {
      username: username,
      password: password,
      user_role: role || 'user',
      status: status || 'active',
      avatar_path: avatarPath,
      disk_limit: diskLimit ? parseInt(diskLimit) : 0
    };

    const result = await User.create(userData);
    
    res.json({
      success: true,
      message: 'User created successfully',
      userId: result.id
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create user'
    });
  }
});

router.get('/api/users/:id/videos', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const videos = await Video.findAll(userId);
    res.json({ success: true, videos });
  } catch (error) {
    console.error('Get user videos error:', error);
    res.status(500).json({ success: false, message: 'Failed to get user videos' });
  }
});

router.get('/api/users/:id/streams', isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const streams = await Stream.findAll(userId);
    res.json({ success: true, streams });
  } catch (error) {
    console.error('Get user streams error:', error);
    res.status(500).json({ success: false, message: 'Failed to get user streams' });
  }
});

router.get('/api/user/disk-usage', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const diskUsage = await User.getDiskUsage(req.session.userId);
    res.json({
      success: true,
      diskUsage: diskUsage,
      diskLimit: user.disk_limit || 0
    });
  } catch (error) {
    console.error('Get disk usage error:', error);
    res.status(500).json({ success: false, message: 'Failed to get disk usage' });
  }
});

router.get('/api/system-stats', isAuthenticated, async (req, res) => {
  try {
    const stats = await systemMonitor.getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.keys(interfaces).forEach((ifname) => {
    interfaces[ifname].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });
  return addresses.length > 0 ? addresses : ['localhost'];
}
router.post('/settings/profile', isAuthenticated, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.redirect('/settings?error=' + encodeURIComponent(err.message) + '&activeTab=profile#profile');
    } else if (err) {
      return res.redirect('/settings?error=' + encodeURIComponent(err.message) + '&activeTab=profile#profile');
    }
    next();
  });
}, [
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'profile'
      });
    }
    const currentUser = await User.findById(req.session.userId);
    if (req.body.username !== currentUser.username) {
      const existingUser = await User.findByUsername(req.body.username);
      if (existingUser) {
        return res.render('settings', {
          title: 'Settings',
          active: 'settings',
          user: currentUser,
          error: 'Username is already taken',
          activeTab: 'profile'
        });
      }
    }
    const updateData = {
      username: req.body.username
    };
    if (req.file) {
      updateData.avatar_path = `/uploads/avatars/${req.file.filename}`;
    }
    await User.update(req.session.userId, updateData);
    req.session.username = updateData.username;
    if (updateData.avatar_path) {
      req.session.avatar_path = updateData.avatar_path;
    }
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Profile updated successfully!',
      activeTab: 'profile'
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while updating your profile',
      activeTab: 'profile'
    });
  }
});
router.post('/settings/password', isAuthenticated, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.newPassword)
    .withMessage('Passwords do not match'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'security'
      });
    }
    const user = await User.findById(req.session.userId);
    const passwordMatch = await User.verifyPassword(req.body.currentPassword, user.password);
    if (!passwordMatch) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: user,
        error: 'Current password is incorrect',
        activeTab: 'security'
      });
    }
    const hashedPassword = await bcrypt.hash(req.body.newPassword, 10);
    await User.update(req.session.userId, { password: hashedPassword });
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Password changed successfully',
      activeTab: 'security'
    });
  } catch (error) {
    console.error('Error changing password:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while changing your password',
      activeTab: 'security'
    });
  }
});

router.get('/api/settings/logs', isAuthenticated, async (req, res) => {
  try {
    const logPath = path.join(__dirname, '../../logs', 'app.log');
    const lines = parseInt(req.query.lines) || 200;
    const filter = req.query.filter || '';

    if (!fs.existsSync(logPath)) {
      return res.json({ success: true, logs: [], message: 'Log file not found' });
    }

    const stats = fs.statSync(logPath);
    const fileSize = stats.size;

    const maxReadSize = 5 * 1024 * 1024;
    let content = '';

    if (fileSize > maxReadSize) {
      const fd = fs.openSync(logPath, 'r');
      const buffer = Buffer.alloc(maxReadSize);
      fs.readSync(fd, buffer, 0, maxReadSize, fileSize - maxReadSize);
      fs.closeSync(fd);
      content = buffer.toString('utf8');
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) {
        content = content.substring(firstNewline + 1);
      }
    } else {
      content = fs.readFileSync(logPath, 'utf8');
    }

    let logLines = content.split('\n').filter(line => line.trim());

    if (filter) {
      const filterLower = filter.toLowerCase();
      logLines = logLines.filter(line => line.toLowerCase().includes(filterLower));
    }

    logLines = logLines.slice(-lines);

    res.json({ success: true, logs: logLines });
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/settings/logs/clear', isAuthenticated, async (req, res) => {
  try {
    const logPath = path.join(__dirname, '../../logs', 'app.log');
    fs.writeFileSync(logPath, '');
    res.json({ success: true, message: 'Logs cleared successfully' });
  } catch (error) {
    console.error('Error clearing logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/integrations/gdrive', isAuthenticated, [
  body('apiKey').notEmpty().withMessage('API Key is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'integrations'
      });
    }
    await User.update(req.session.userId, {
      gdrive_api_key: req.body.apiKey
    });
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Google Drive API key saved successfully!',
      activeTab: 'integrations'
    });
  } catch (error) {
    console.error('Error saving Google Drive API key:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while saving your Google Drive API key',
      activeTab: 'integrations'
    });
  }
});
module.exports = router;

