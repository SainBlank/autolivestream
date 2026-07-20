const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Video = require('../models/Video');
const MediaFolder = require('../models/MediaFolder');
const Playlist = require('../models/Playlist');
const Stream = require('../models/Stream');
const AppSettings = require('../models/AppSettings');
const systemMonitor = require('../services/systemMonitor');
const packageJson = require('../../package.json');
const { upload, uploadVideo, uploadThumbnail, uploadAudio } = require('../middleware/uploadMiddleware');
const chunkUploadService = require('../services/chunkUploadService');
const streamingService = require('../services/streamingService');
const schedulerService = require('../services/schedulerService');
const audioConverter = require('../services/audioConverter');
const rotationService = require('../services/rotationService');
const { getVideoInfo, generateThumbnail, generateImageThumbnail } = require('../utils/videoProcessor');
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

router.post('/upload/video', isAuthenticated, uploadVideo.single('video'), async (req, res) => {
  try {
    console.log('Upload request received:', req.file);
    console.log('Session userId for upload:', req.session.userId);
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    const { filename, originalname, path: videoPath, mimetype, size } = req.file;
    const thumbnailName = path.basename(filename, path.extname(filename)) + '.jpg';
    const videoInfo = await getVideoInfo(videoPath);
    const thumbnailRelativePath = await generateThumbnail(videoPath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);
    let format = 'unknown';
    if (mimetype === 'video/mp4') format = 'mp4';
    else if (mimetype === 'video/avi') format = 'avi';
    else if (mimetype === 'video/quicktime') format = 'mov';
    const videoData = {
      title: path.basename(originalname, path.extname(originalname)),
      original_filename: originalname,
      filepath: `/uploads/videos/${filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: size,
      duration: videoInfo.duration,
      format: format,
      user_id: req.session.userId
    };
    const video = await Video.create(videoData);
    res.json({
      success: true,
      video: {
        id: video.id,
        title: video.title,
        filepath: video.filepath,
        thumbnail_path: video.thumbnail_path,
        duration: video.duration,
        file_size: video.file_size,
        format: video.format
      }
    });
  } catch (error) {
    console.error('Upload error details:', error);
    res.status(500).json({ 
      error: 'Failed to upload video',
      details: error.message 
    });
  }
});
router.post('/api/videos/upload', isAuthenticated, (req, res, next) => {
  uploadVideo.single('video')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ 
          success: false, 
          error: 'File too large. Maximum size is 50GB.' 
        });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ 
          success: false, 
          error: 'Unexpected file field.' 
        });
      }
      return res.status(400).json({ 
        success: false, 
        error: err.message 
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No video file provided' 
      });
    }

    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }

    const user = await User.findById(req.session.userId);
    if (user.disk_limit > 0) {
      const currentUsage = await User.getDiskUsage(req.session.userId);
      const newTotal = currentUsage + req.file.size;
      if (newTotal > user.disk_limit) {
        const fs = require('fs');
        const fullFilePath = path.join(__dirname, '../../public', 'uploads', 'videos', req.file.filename);
        if (fs.existsSync(fullFilePath)) {
          fs.unlinkSync(fullFilePath);
        }
        return res.status(400).json({
          success: false,
          error: 'Disk limit exceeded. Please delete some files or contact admin.'
        });
      }
    }

    let title = path.parse(req.file.originalname).name;
    const filePath = `/uploads/videos/${req.file.filename}`;
    const fullFilePath = path.join(__dirname, '../../public', filePath);
    const fileSize = req.file.size;
    await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(fullFilePath, (err, metadata) => {
        if (err) {
          console.error('Error extracting metadata:', err);
          return reject(err);
        }
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const duration = metadata.format.duration || 0;
        const format = metadata.format.format_name || '';
        const resolution = videoStream ? `${videoStream.width}x${videoStream.height}` : '';
        const bitrate = metadata.format.bit_rate ?
          Math.round(parseInt(metadata.format.bit_rate) / 1000) :
          null;
        let fps = null;
        if (videoStream && videoStream.avg_frame_rate) {
          const fpsRatio = videoStream.avg_frame_rate.split('/');
          if (fpsRatio.length === 2 && parseInt(fpsRatio[1]) !== 0) {
            fps = Math.round((parseInt(fpsRatio[0]) / parseInt(fpsRatio[1]) * 100)) / 100;
          } else {
            fps = parseInt(fpsRatio[0]) || null;
          }
        }
        const thumbnailFilename = `thumb-${path.parse(req.file.filename).name}.jpg`;
        const thumbnailPath = `/uploads/thumbnails/${thumbnailFilename}`;
        const fullThumbnailPath = path.join(__dirname, '../../public', thumbnailPath);
        ffmpeg(fullFilePath)
          .screenshots({
            timestamps: ['10%'],
            filename: thumbnailFilename,
            folder: path.join(__dirname, '../../public', 'uploads', 'thumbnails'),
            size: '854x480'
          })
          .on('end', async () => {
            try {
              const videoData = {
              title,
              filepath: filePath,
              thumbnail_path: thumbnailPath,
              file_size: fileSize,
              duration,
              format,
              resolution,
              bitrate,
              fps,
              user_id: req.session.userId,
              folder_id: folderId
            };
              const video = await Video.create(videoData);
              res.json({
                success: true,
                message: 'Video uploaded successfully',
                video
              });
              resolve();
            } catch (dbError) {
              console.error('Database error:', dbError);
              reject(dbError);
            }
          })
          .on('error', (err) => {
            console.error('Error creating thumbnail:', err);
            reject(err);
          });
      });
    });
  } catch (error) {
    console.error('Upload error details:', error);
    res.status(500).json({ 
      error: 'Failed to upload video',
      details: error.message 
    });
  }
});
router.get('/api/videos', isAuthenticated, async (req, res) => {
  try {
    const allVideos = await Video.findAll(req.session.userId);
    const videos = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      if (filepath.includes('/audio/')) return false;
      if (filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3')) return false;
      return true;
    });
    const playlists = await Playlist.findAll(req.session.userId);
    res.json({ success: true, videos, playlists });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
});

router.post('/api/audio/upload', isAuthenticated, (req, res, next) => {
  uploadAudio.single('audio')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ 
          success: false, 
          error: 'File too large. Maximum size is 50GB.' 
        });
      }
      return res.status(400).json({ 
        success: false, 
        error: err.message 
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No audio file provided' 
      });
    }

    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }

    const user = await User.findById(req.session.userId);
    if (user.disk_limit > 0) {
      const currentUsage = await User.getDiskUsage(req.session.userId);
      const newTotal = currentUsage + req.file.size;
      if (newTotal > user.disk_limit) {
        const uploadedPath = path.join(__dirname, '../../public', 'uploads', 'audio', req.file.filename);
        if (fs.existsSync(uploadedPath)) {
          fs.unlinkSync(uploadedPath);
        }
        return res.status(400).json({
          success: false,
          error: 'Disk limit exceeded. Please delete some files or contact admin.'
        });
      }
    }

    let title = path.parse(req.file.originalname).name;
    const uploadedPath = path.join(__dirname, '../../public', 'uploads', 'audio', req.file.filename);
    const result = await audioConverter.processAudioFile(uploadedPath, req.file.originalname);
    const finalFilename = path.basename(result.filepath);
    const filePath = `/uploads/audio/${finalFilename}`;
    const fullFilePath = result.filepath;
    const audioInfo = await audioConverter.getAudioInfo(fullFilePath);
    const stats = fs.statSync(fullFilePath);
    const thumbnailPath = '/images/audio-thumbnail.png';
    const videoData = {
      title,
      filepath: filePath,
      thumbnail_path: thumbnailPath,
      file_size: stats.size,
      duration: audioInfo.duration,
      format: 'aac',
      resolution: null,
      bitrate: audioInfo.bitrate,
      fps: null,
      user_id: req.session.userId,
      folder_id: folderId
    };
    const video = await Video.create(videoData);
    res.json({
      success: true,
      message: result.converted ? 'Audio converted to AAC and uploaded successfully' : 'Audio uploaded successfully',
      video,
      converted: result.converted
    });
  } catch (error) {
    console.error('Audio upload error:', error);
    res.status(500).json({ 
      error: 'Failed to upload audio',
      details: error.message 
    });
  }
});

router.post('/api/videos/chunk/init', isAuthenticated, async (req, res) => {
  try {
    const { filename, fileSize, totalChunks } = req.body;
    if (!filename || !fileSize || !totalChunks) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }
    const allowedExts = ['.mp4', '.avi', '.mov'];
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({ success: false, error: 'Only .mp4, .avi, and .mov formats are allowed' });
    }

    const user = await User.findById(req.session.userId);
    if (user.disk_limit > 0) {
      const currentUsage = await User.getDiskUsage(req.session.userId);
      const newTotal = currentUsage + parseInt(fileSize);
      if (newTotal > user.disk_limit) {
        return res.status(400).json({
          success: false,
          error: 'Disk limit exceeded. Please delete some files or contact admin.'
        });
      }
    }

    const info = await chunkUploadService.initUpload(filename, fileSize, totalChunks, req.session.userId, { folderId });
    res.json({ 
      success: true, 
      uploadId: info.uploadId, 
      chunkSize: chunkUploadService.CHUNK_SIZE,
      uploadedChunks: info.uploadedChunks || [],
      resumed: (info.uploadedChunks || []).length > 0
    });
  } catch (error) {
    console.error('Chunk init error:', error);
    res.status(500).json({ success: false, error: 'Failed to initialize upload' });
  }
});

router.post('/api/videos/chunk/upload', isAuthenticated, express.raw({ type: 'application/octet-stream', limit: '60mb' }), async (req, res) => {
  try {
    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
    if (!uploadId || isNaN(chunkIndex)) {
      return res.status(400).json({ success: false, error: 'Missing upload ID or chunk index' });
    }
    const info = await chunkUploadService.getUploadInfo(uploadId);
    if (!info) {
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    if (info.userId !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const result = await chunkUploadService.saveChunk(uploadId, chunkIndex, req.body);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload chunk' });
  }
});

router.get('/api/videos/chunk/status/:uploadId', isAuthenticated, async (req, res) => {
  try {
    const info = await chunkUploadService.getUploadInfo(req.params.uploadId);
    if (!info) {
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    if (info.userId !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    res.json({
      success: true,
      uploadedChunks: info.uploadedChunks,
      totalChunks: info.totalChunks,
      status: info.status
    });
  } catch (error) {
    console.error('Chunk status error:', error);
    res.status(500).json({ success: false, error: 'Failed to get upload status' });
  }
});

router.post('/api/videos/chunk/complete', isAuthenticated, async (req, res) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ success: false, error: 'Missing upload ID' });
    }
    const info = await chunkUploadService.getUploadInfo(uploadId);
    if (!info) {
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    if (info.userId !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const result = await chunkUploadService.mergeChunks(uploadId);
    const title = path.parse(info.filename).name;
    const fullFilePath = result.fullPath;
    const videoData = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(fullFilePath, (err, metadata) => {
        if (err) {
          console.error('Error extracting metadata:', err);
          return reject(err);
        }
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const duration = metadata.format.duration || 0;
        const format = metadata.format.format_name || '';
        const resolution = videoStream ? `${videoStream.width}x${videoStream.height}` : '';
        const bitrate = metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : null;
        let fps = null;
        if (videoStream && videoStream.avg_frame_rate) {
          const fpsRatio = videoStream.avg_frame_rate.split('/');
          if (fpsRatio.length === 2 && parseInt(fpsRatio[1]) !== 0) {
            fps = Math.round((parseInt(fpsRatio[0]) / parseInt(fpsRatio[1]) * 100)) / 100;
          } else {
            fps = parseInt(fpsRatio[0]) || null;
          }
        }
        const thumbnailFilename = `thumb-${path.parse(result.filename).name}.jpg`;
        const thumbnailPath = `/uploads/thumbnails/${thumbnailFilename}`;
        ffmpeg(fullFilePath)
          .screenshots({
            timestamps: ['10%'],
            filename: thumbnailFilename,
            folder: path.join(__dirname, '../../public', 'uploads', 'thumbnails'),
            size: '854x480'
          })
          .on('end', async () => {
            resolve({
              title,
              filepath: result.filepath,
              thumbnail_path: thumbnailPath,
              file_size: result.fileSize,
              duration,
              format,
              resolution,
              bitrate,
              fps,
              user_id: req.session.userId,
              folder_id: info.folderId || null
            });
          })
          .on('error', (err) => {
            console.error('Error creating thumbnail:', err);
            reject(err);
          });
      });
    });
    const video = await Video.create(videoData);
    await chunkUploadService.cleanupUpload(uploadId);
    res.json({ success: true, message: 'Video uploaded successfully', video });
  } catch (error) {
    console.error('Chunk complete error:', error);
    res.status(500).json({ success: false, error: 'Failed to complete upload', details: error.message });
  }
});

router.post('/api/videos/chunk/pause', isAuthenticated, async (req, res) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ success: false, error: 'Missing upload ID' });
    }
    const info = await chunkUploadService.getUploadInfo(uploadId);
    if (!info) {
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    if (info.userId !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    await chunkUploadService.pauseUpload(uploadId);
    res.json({ success: true });
  } catch (error) {
    console.error('Chunk pause error:', error);
    res.status(500).json({ success: false, error: 'Failed to pause upload' });
  }
});

router.delete('/api/videos/chunk/:uploadId', isAuthenticated, async (req, res) => {
  try {
    const info = await chunkUploadService.getUploadInfo(req.params.uploadId);
    if (info && info.userId === req.session.userId) {
      await chunkUploadService.cleanupUpload(req.params.uploadId);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Chunk cleanup error:', error);
    res.status(500).json({ success: false, error: 'Failed to cleanup upload' });
  }
});
router.delete('/api/videos/:id', isAuthenticated, async (req, res) => {
  try {
    const videoId = req.params.id;
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const videoMap = new Map([[video.id, video]]);
    const conflicts = await findLiveStreamConflictsForVideos(req.session.userId, [video.id]);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: buildDeleteBlockedMessage(conflicts, videoMap, 'file')
      });
    }

    await Video.delete(videoId);
    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ success: false, error: 'Failed to delete video' });
  }
});
router.post('/api/videos/:id/rename', isAuthenticated, [
  body('title').trim().isLength({ min: 1 }).withMessage('Title cannot be empty')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'You don\'t have permission to rename this video' });
    }
    await Video.update(req.params.id, { title: req.body.title });
    res.json({ success: true, message: 'Video renamed successfully' });
  } catch (error) {
    console.error('Error renaming video:', error);
    res.status(500).json({ error: 'Failed to rename video' });
  }
});
router.get('/stream/:videoId', isAuthenticated, async (req, res) => {
  try {
    const videoId = req.params.videoId;
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).send('Video not found');
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).send('You do not have permission to access this video');
    }
    const videoPath = path.join(__dirname, '../../public', video.filepath);
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).send('Error streaming video');
  }
});
router.get('/api/settings/gdrive-status', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    res.json({
      hasApiKey: !!user.gdrive_api_key,
      message: user.gdrive_api_key ? 'Google Drive API key is configured' : 'No Google Drive API key found'
    });
  } catch (error) {
    console.error('Error checking Google Drive API status:', error);
    res.status(500).json({ error: 'Failed to check API key status' });
  }
});
router.post('/api/settings/gdrive-api-key', isAuthenticated, [
  body('apiKey').notEmpty().withMessage('API Key is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }
    await User.update(req.session.userId, {
      gdrive_api_key: req.body.apiKey
    });
    return res.json({
      success: true,
      message: 'Google Drive API key saved successfully!'
    });
  } catch (error) {
    console.error('Error saving Google Drive API key:', error);
    res.status(500).json({
      success: false,
      error: 'An error occurred while saving your Google Drive API key'
    });
  }
});

const { encrypt, decrypt } = require('../utils/encryption');

router.post('/api/settings/youtube-credentials', isAuthenticated, [
  body('clientId').notEmpty().withMessage('Client ID is required'),
  body('clientSecret').notEmpty().withMessage('Client Secret is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }

    const { clientId, clientSecret } = req.body;
    
    const encryptedSecret = encrypt(clientSecret);
    
    await User.update(req.session.userId, {
      youtube_client_id: clientId,
      youtube_client_secret: encryptedSecret
    });

    return res.json({
      success: true,
      message: 'YouTube API credentials saved successfully!'
    });
  } catch (error) {
    console.error('Error saving YouTube credentials:', error);
    res.status(500).json({
      success: false,
      error: 'An error occurred while saving your YouTube credentials'
    });
  }
});

router.get('/api/settings/youtube-status', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    
    const hasCredentials = !!(user.youtube_client_id && user.youtube_client_secret);
    const isConnected = !!(user.youtube_access_token && user.youtube_refresh_token);
    
    res.json({
      success: true,
      hasCredentials,
      isConnected,
      channelName: user.youtube_channel_name || null,
      channelId: user.youtube_channel_id || null
    });
  } catch (error) {
    console.error('Error checking YouTube status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check YouTube status' 
    });
  }
});

router.post('/api/settings/youtube-disconnect', isAuthenticated, async (req, res) => {
  try {
    const YoutubeChannel = require('../models/YoutubeChannel');
    await YoutubeChannel.deleteAll(req.session.userId);

    return res.json({
      success: true,
      message: 'All YouTube channels disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting YouTube:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect YouTube accounts'
    });
  }
});

router.post('/api/settings/recaptcha', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (user.user_role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only admin can manage reCAPTCHA settings'
      });
    }

    const { siteKey, secretKey, enabled } = req.body;
    
    if (!siteKey) {
      return res.status(400).json({
        success: false,
        error: 'Site Key is required'
      });
    }

    const AppSettings = require('../models/AppSettings');
    const existingSettings = await AppSettings.getRecaptchaSettings();
    
    if (secretKey) {
      const axios = require('axios');
      const verifyResponse = await axios.post(
        'https://www.google.com/recaptcha/api/siteverify',
        `secret=${encodeURIComponent(secretKey)}&response=test`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const verifyData = verifyResponse.data;
      
      if (verifyData['error-codes'] && verifyData['error-codes'].includes('invalid-input-secret')) {
        return res.status(400).json({
          success: false,
          error: 'Invalid reCAPTCHA Secret Key. Please check your credentials.'
        });
      }

      const encryptedSecretKey = encrypt(secretKey);
      await AppSettings.setRecaptchaSettings(siteKey, encryptedSecretKey, enabled);
    } else if (existingSettings.hasKeys) {
      await AppSettings.set('recaptcha_site_key', siteKey);
      await AppSettings.set('recaptcha_enabled', enabled ? '1' : '0');
    } else {
      return res.status(400).json({
        success: false,
        error: 'Secret Key is required'
      });
    }

    return res.json({
      success: true,
      message: 'reCAPTCHA settings saved successfully!'
    });
  } catch (error) {
    console.error('Error saving reCAPTCHA settings:', error);
    res.status(500).json({
      success: false,
      error: 'An error occurred while saving reCAPTCHA settings'
    });
  }
});

router.post('/api/settings/recaptcha/toggle', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (user.user_role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only admin can manage reCAPTCHA settings'
      });
    }

    const { enabled } = req.body;
    const AppSettings = require('../models/AppSettings');
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    if (!recaptchaSettings.hasKeys) {
      return res.status(400).json({
        success: false,
        error: 'Please save reCAPTCHA keys first before enabling'
      });
    }
    
    await AppSettings.set('recaptcha_enabled', enabled ? '1' : '0');

    return res.json({
      success: true,
      message: enabled ? 'reCAPTCHA enabled' : 'reCAPTCHA disabled'
    });
  } catch (error) {
    console.error('Error toggling reCAPTCHA:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update reCAPTCHA status'
    });
  }
});

router.delete('/api/settings/recaptcha', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (user.user_role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only admin can manage reCAPTCHA settings'
      });
    }

    const AppSettings = require('../models/AppSettings');
    await AppSettings.deleteRecaptchaSettings();

    return res.json({
      success: true,
      message: 'reCAPTCHA keys removed successfully'
    });
  } catch (error) {
    console.error('Error removing reCAPTCHA keys:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove reCAPTCHA keys'
    });
  }
});

router.get('/api/settings/youtube-channels', isAuthenticated, async (req, res) => {
  try {
    const YoutubeChannel = require('../models/YoutubeChannel');
    const channels = await YoutubeChannel.findAll(req.session.userId);
    res.json({ success: true, channels });
  } catch (error) {
    console.error('Error fetching YouTube channels:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch channels' });
  }
});

router.post('/api/settings/youtube-channel/:id/default', isAuthenticated, async (req, res) => {
  try {
    const YoutubeChannel = require('../models/YoutubeChannel');
    await YoutubeChannel.setDefault(req.session.userId, req.params.id);
    res.json({ success: true, message: 'Default channel updated' });
  } catch (error) {
    console.error('Error setting default channel:', error);
    res.status(500).json({ success: false, error: 'Failed to set default channel' });
  }
});

router.delete('/api/settings/youtube-channel/:id', isAuthenticated, async (req, res) => {
  try {
    const YoutubeChannel = require('../models/YoutubeChannel');
    const channel = await YoutubeChannel.findById(req.params.id);
    
    if (!channel || channel.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }
    
    await YoutubeChannel.delete(req.params.id, req.session.userId);
    
    if (channel.is_default) {
      const channels = await YoutubeChannel.findAll(req.session.userId);
      if (channels.length > 0) {
        await YoutubeChannel.setDefault(req.session.userId, channels[0].id);
      }
    }
    
    res.json({ success: true, message: 'Channel disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting channel:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect channel' });
  }
});

const { google } = require('googleapis');

function getYouTubeOAuth2Client(clientId, clientSecret, redirectUri) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

router.get('/auth/youtube', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    
    if (!user.youtube_client_id || !user.youtube_client_secret) {
      return res.redirect('/settings?error=Please save your YouTube API credentials first&activeTab=integration');
    }
    
    const clientSecret = decrypt(user.youtube_client_secret);
    if (!clientSecret) {
      return res.redirect('/settings?error=Failed to decrypt credentials&activeTab=integration');
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUri = `${protocol}://${host}/auth/youtube/callback`;
    
    const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
    
    const scopes = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube'
    ];
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state: req.session.userId
    });
    
    res.redirect(authUrl);
  } catch (error) {
    console.error('YouTube OAuth error:', error);
    res.redirect('/settings?error=Failed to initiate YouTube authentication&activeTab=integration');
  }
});

router.get('/auth/youtube/callback', isAuthenticated, async (req, res) => {
  try {
    const { code, error, state } = req.query;
    
    if (error) {
      console.error('YouTube OAuth error:', error);
      return res.redirect(`/settings?error=${encodeURIComponent(error)}&activeTab=integration`);
    }
    
    if (!code) {
      return res.redirect('/settings?error=No authorization code received&activeTab=integration');
    }
    
    const user = await User.findById(req.session.userId);
    
    if (!user.youtube_client_id || !user.youtube_client_secret) {
      return res.redirect('/settings?error=YouTube credentials not found&activeTab=integration');
    }
    
    const clientSecret = decrypt(user.youtube_client_secret);
    if (!clientSecret) {
      return res.redirect('/settings?error=Failed to decrypt credentials&activeTab=integration');
    }
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUri = `${protocol}://${host}/auth/youtube/callback`;
    
    const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
    
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const channelResponse = await youtube.channels.list({
      part: 'snippet,statistics',
      mine: true
    });
    
    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      return res.redirect('/settings?error=No YouTube channel found for this account&activeTab=integration');
    }
    
    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.default?.url || channel.snippet.thumbnails?.medium?.url || '';
    const subscriberCount = channel.statistics?.subscriberCount || '0';
    
    const YoutubeChannel = require('../models/YoutubeChannel');
    const existingChannel = await YoutubeChannel.findByChannelId(req.session.userId, channelId);
    
    if (existingChannel) {
      await YoutubeChannel.update(existingChannel.id, {
        access_token: encrypt(tokens.access_token),
        refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : existingChannel.refresh_token,
        channel_name: channelName,
        channel_thumbnail: channelThumbnail,
        subscriber_count: subscriberCount
      });
    } else {
      await YoutubeChannel.create({
        user_id: req.session.userId,
        channel_id: channelId,
        channel_name: channelName,
        channel_thumbnail: channelThumbnail,
        subscriber_count: subscriberCount,
        access_token: encrypt(tokens.access_token),
        refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : null
      });
    }
    
    await User.update(req.session.userId, {
      youtube_redirect_uri: redirectUri
    });
    
    res.redirect('/settings?success=YouTube channel connected successfully&activeTab=integration');
  } catch (error) {
    console.error('YouTube OAuth callback error:', error);
    const errorMessage = error.message || 'Failed to connect YouTube account';
    res.redirect(`/settings?error=${encodeURIComponent(errorMessage)}&activeTab=integration`);
  }
});

router.post('/api/videos/import-drive', isAuthenticated, [
  body('driveUrl').notEmpty().withMessage('Google Drive URL is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { driveUrl } = req.body;
    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }
    const { extractFileId, downloadFile } = require('../utils/googleDriveService');
    try {
      const fileId = extractFileId(driveUrl);
      const jobId = uuidv4();
      processGoogleDriveImport(jobId, fileId, req.session.userId, folderId)
        .catch(err => console.error('Drive import failed:', err));
      return res.json({
        success: true,
        message: 'Video import started',
        jobId: jobId
      });
    } catch (error) {
      console.error('Google Drive URL parsing error:', error);
      return res.status(400).json({
        success: false,
        error: 'Invalid Google Drive URL format'
      });
    }
  } catch (error) {
    console.error('Error importing from Google Drive:', error);
    res.status(500).json({ success: false, error: 'Failed to import video' });
  }
});
router.get('/api/videos/import-status/:jobId', isAuthenticated, async (req, res) => {
  const jobId = req.params.jobId;
  if (!importJobs[jobId]) {
    return res.status(404).json({ success: false, error: 'Import job not found' });
  }
  return res.json({
    success: true,
    status: importJobs[jobId]
  });
});
const importJobs = {};
async function processGoogleDriveImport(jobId, fileId, userId, folderId = null) {
  const { downloadFile } = require('../utils/googleDriveService');
  const { getVideoInfo, generateThumbnail } = require('../utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');
  
  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting download...'
  };
  
  try {
    let result;
    try {
      result = await downloadFile(fileId, (progress) => {
        importJobs[jobId] = {
          status: 'downloading',
          progress: progress.progress,
          message: `Downloading ${progress.filename}: ${progress.progress}%`
        };
      });
    } catch (downloadError) {
      importJobs[jobId] = {
        status: 'failed',
        progress: 0,
        message: downloadError.message || 'Failed to download file'
      };
      setTimeout(() => { delete importJobs[jobId]; }, 5 * 60 * 1000);
      return;
    }
    
    if (!result || !result.localFilePath) {
      importJobs[jobId] = {
        status: 'failed',
        progress: 0,
        message: 'Download completed but file path is missing'
      };
      setTimeout(() => { delete importJobs[jobId]; }, 5 * 60 * 1000);
      return;
    }
    
    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: 'Processing video...'
    };
    
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(result.localFilePath);
    } catch (infoError) {
      videoInfo = { duration: 0 };
    }
    
    let resolution = '';
    let bitrate = null;
    
    try {
      const metadata = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ffprobe timeout')), 30000);
        ffmpeg.ffprobe(result.localFilePath, (err, metadata) => {
          clearTimeout(timeout);
          if (err) return reject(err);
          resolve(metadata);
        });
      });
      
      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (videoStream) {
        resolution = `${videoStream.width}x${videoStream.height}`;
      }
      
      if (metadata.format && metadata.format.bit_rate) {
        bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
      }
    } catch (probeError) {
      console.log('ffprobe error (non-fatal):', probeError.message);
    }
    
    const thumbnailBaseName = path.basename(result.filename, path.extname(result.filename));
    const thumbnailName = thumbnailBaseName + '.jpg';
    let thumbnailRelativePath = null;
    
    try {
      await generateThumbnail(result.localFilePath, thumbnailName);
      thumbnailRelativePath = `/uploads/thumbnails/${thumbnailName}`;
    } catch (thumbError) {
      console.log('Thumbnail generation failed (non-fatal):', thumbError.message);
    }
    
    let format = path.extname(result.filename).toLowerCase().replace('.', '');
    if (!format) format = 'mp4';
    
    const videoData = {
      title: path.basename(result.filename, path.extname(result.filename)),
      filepath: `/uploads/videos/${result.filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: result.fileSize,
      duration: videoInfo.duration || 0,
      format: format,
      resolution: resolution,
      bitrate: bitrate,
      user_id: userId,
      folder_id: folderId
    };
    
    const video = await Video.create(videoData);
    
    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: 'Video imported successfully',
      videoId: video.id
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing Google Drive import:', error.message);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import video'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}

router.post('/api/videos/import-mediafire', isAuthenticated, [
  body('mediafireUrl').notEmpty().withMessage('Mediafire URL is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { mediafireUrl } = req.body;
    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }
    const { extractFileKey } = require('../utils/mediafireService');
    try {
      const fileKey = extractFileKey(mediafireUrl);
      const jobId = uuidv4();
      processMediafireImport(jobId, fileKey, req.session.userId, folderId)
        .catch(err => console.error('Mediafire import failed:', err));
      return res.json({
        success: true,
        message: 'Video import started',
        jobId: jobId
      });
    } catch (error) {
      console.error('Mediafire URL parsing error:', error);
      return res.status(400).json({
        success: false,
        error: 'Invalid Mediafire URL format'
      });
    }
  } catch (error) {
    console.error('Error importing from Mediafire:', error);
    res.status(500).json({ success: false, error: 'Failed to import video' });
  }
});

async function processMediafireImport(jobId, fileKey, userId, folderId = null) {
  const { downloadFile } = require('../utils/mediafireService');
  const { getVideoInfo, generateThumbnail } = require('../utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');
  
  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting download...'
  };
  
  try {
    const result = await downloadFile(fileKey, (progress) => {
      importJobs[jobId] = {
        status: 'downloading',
        progress: progress.progress,
        message: `Downloading ${progress.filename}: ${progress.progress}%`
      };
    });
    
    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: 'Processing video...'
    };
    
    const videoInfo = await getVideoInfo(result.localFilePath);
    
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(result.localFilePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata);
      });
    });
    
    let resolution = '';
    let bitrate = null;
    
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (videoStream) {
      resolution = `${videoStream.width}x${videoStream.height}`;
    }
    
    if (metadata.format && metadata.format.bit_rate) {
      bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
    }
    
    const thumbnailBaseName = path.basename(result.filename, path.extname(result.filename));
    const thumbnailName = thumbnailBaseName + '.jpg';
    const thumbnailRelativePath = await generateThumbnail(result.localFilePath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);
    
    let format = path.extname(result.filename).toLowerCase().replace('.', '');
    if (!format) format = 'mp4';
    
    const videoData = {
      title: path.basename(result.filename, path.extname(result.filename)),
      filepath: `/uploads/videos/${result.filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: result.fileSize,
      duration: videoInfo.duration,
      format: format,
      resolution: resolution,
      bitrate: bitrate,
      user_id: userId,
      folder_id: folderId
    };
    
    const video = await Video.create(videoData);
    
    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: 'Video imported successfully',
      videoId: video.id
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing Mediafire import:', error);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import video'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}

router.post('/api/videos/import-dropbox', isAuthenticated, [
  body('dropboxUrl').notEmpty().withMessage('Dropbox URL is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { dropboxUrl } = req.body;
    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }
    if (!dropboxUrl.includes('dropbox.com')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Dropbox URL format'
      });
    }
    const jobId = uuidv4();
    processDropboxImport(jobId, dropboxUrl, req.session.userId, folderId)
      .catch(err => console.error('Dropbox import failed:', err));
    return res.json({
      success: true,
      message: 'Video import started',
      jobId: jobId
    });
  } catch (error) {
    console.error('Error importing from Dropbox:', error);
    res.status(500).json({ success: false, error: 'Failed to import video' });
  }
});

async function processDropboxImport(jobId, dropboxUrl, userId, folderId = null) {
  const { downloadFile } = require('../utils/dropboxService');
  const { getVideoInfo, generateThumbnail } = require('../utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');
  
  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting download...'
  };
  
  try {
    const result = await downloadFile(dropboxUrl, (progress) => {
      importJobs[jobId] = {
        status: 'downloading',
        progress: progress.progress,
        message: `Downloading ${progress.filename}: ${progress.progress}%`
      };
    });
    
    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: 'Processing video...'
    };
    
    const videoInfo = await getVideoInfo(result.localFilePath);
    
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(result.localFilePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata);
      });
    });
    
    let resolution = '';
    let bitrate = null;
    
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (videoStream) {
      resolution = `${videoStream.width}x${videoStream.height}`;
    }
    
    if (metadata.format && metadata.format.bit_rate) {
      bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
    }
    
    const thumbnailBaseName = path.basename(result.filename, path.extname(result.filename));
    const thumbnailName = thumbnailBaseName + '.jpg';
    const thumbnailRelativePath = await generateThumbnail(result.localFilePath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);
    
    let format = path.extname(result.filename).toLowerCase().replace('.', '');
    if (!format) format = 'mp4';
    
    const videoData = {
      title: path.basename(result.filename, path.extname(result.filename)),
      filepath: `/uploads/videos/${result.filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: result.fileSize,
      duration: videoInfo.duration,
      format: format,
      resolution: resolution,
      bitrate: bitrate,
      user_id: userId,
      folder_id: folderId
    };
    
    const video = await Video.create(videoData);
    
    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: 'Video imported successfully',
      videoId: video.id
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing Dropbox import:', error);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import video'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}

router.post('/api/videos/import-mega', isAuthenticated, [
  body('megaUrl').notEmpty().withMessage('MEGA URL is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { megaUrl } = req.body;
    const folderId = normalizeFolderId(req.body.folderId);
    if (folderId) {
      const folder = await MediaFolder.findById(folderId, req.session.userId);
      if (!folder) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
      }
    }
    if (!megaUrl.includes('mega.nz') && !megaUrl.includes('mega.co.nz')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid MEGA URL format'
      });
    }
    const jobId = uuidv4();
    processMegaImport(jobId, megaUrl, req.session.userId, folderId)
      .catch(err => console.error('MEGA import failed:', err));
    return res.json({
      success: true,
      message: 'Video import started',
      jobId: jobId
    });
  } catch (error) {
    console.error('Error importing from MEGA:', error);
    res.status(500).json({ success: false, error: 'Failed to import video' });
  }
});

async function processMegaImport(jobId, megaUrl, userId, folderId = null) {
  const { downloadFile } = require('../utils/megaService');
  const { getVideoInfo, generateThumbnail } = require('../utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');
  
  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting download...'
  };
  
  try {
    const result = await downloadFile(megaUrl, (progress) => {
      importJobs[jobId] = {
        status: 'downloading',
        progress: progress.progress,
        message: `Downloading ${progress.filename}: ${progress.progress}%`
      };
    });
    
    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: 'Processing video...'
    };
    
    const videoInfo = await getVideoInfo(result.localFilePath);
    
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(result.localFilePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata);
      });
    });
    
    let resolution = '';
    let bitrate = null;
    
    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (videoStream) {
      resolution = `${videoStream.width}x${videoStream.height}`;
    }
    
    if (metadata.format && metadata.format.bit_rate) {
      bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
    }
    
    const thumbnailBaseName = path.basename(result.filename, path.extname(result.filename));
    const thumbnailName = thumbnailBaseName + '.jpg';
    const thumbnailRelativePath = await generateThumbnail(result.localFilePath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);
    
    let format = path.extname(result.filename).toLowerCase().replace('.', '');
    if (!format) format = 'mp4';
    
    const videoData = {
      title: path.basename(result.filename, path.extname(result.filename)),
      filepath: `/uploads/videos/${result.filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: result.fileSize,
      duration: videoInfo.duration,
      format: format,
      resolution: resolution,
      bitrate: bitrate,
      user_id: userId,
      folder_id: folderId
    };
    
    const video = await Video.create(videoData);
    
    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: 'Video imported successfully',
      videoId: video.id
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing MEGA import:', error);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import video'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}

router.get('/api/stream/videos', isAuthenticated, async (req, res) => {
  try {
    const allVideos = await Video.findAll(req.session.userId);
    const videos = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      if (filepath.includes('/audio/')) return false;
      if (filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3')) return false;
      return true;
    });
    const formattedVideos = videos.map(video => {
      const duration = video.duration ? Math.floor(video.duration) : 0;
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      return {
        id: video.id,
        name: video.title,
        thumbnail: video.thumbnail_path,
        resolution: video.resolution || '1280x720',
        duration: formattedDuration,
        url: `/stream/${video.id}`,
        type: 'video'
      };
    });
    res.json(formattedVideos);
  } catch (error) {
    console.error('Error fetching videos for stream:', error);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

router.get('/api/stream/content', isAuthenticated, async (req, res) => {
  try {
    const allVideos = await Video.findAll(req.session.userId);
    const videos = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      if (filepath.includes('/audio/')) return false;
      if (filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3')) return false;
      return true;
    });
    const formattedVideos = videos.map(video => {
      const duration = video.duration ? Math.floor(video.duration) : 0;
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      return {
        id: video.id,
        name: video.title,
        thumbnail: video.thumbnail_path,
        resolution: video.resolution || '1280x720',
        duration: formattedDuration,
        url: `/stream/${video.id}`,
        type: 'video'
      };
    });

    const playlists = await Playlist.findAll(req.session.userId);
    const formattedPlaylists = playlists.map(playlist => {
      return {
        id: playlist.id,
        name: playlist.name,
        thumbnail: '/images/playlist-thumbnail.svg',
        resolution: 'Playlist',
        duration: `${playlist.video_count || 0} videos`,
        videoCount: playlist.video_count || 0,
        audioCount: playlist.audio_count || 0,
        url: `/playlist/${playlist.id}`,
        type: 'playlist',
        description: playlist.description,
        is_shuffle: playlist.is_shuffle
      };
    });

    const allContent = [...formattedPlaylists, ...formattedVideos];
    
    res.json(allContent);
  } catch (error) {
    console.error('Error fetching content for stream:', error);
    res.status(500).json({ error: 'Failed to load content' });
  }
});

router.get('/api/streams', isAuthenticated, async (req, res) => {
  try {
    const filter = req.query.filter;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    if (req.query.page || req.query.limit) {
      const result = await Stream.findAllPaginated(req.session.userId, {
        page,
        limit,
        filter,
        search
      });
      res.json({ success: true, ...result });
    } else {
      const streams = await Stream.findAll(req.session.userId, filter);
      res.json({ success: true, streams });
    }
  } catch (error) {
    console.error('Error fetching streams:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streams' });
  }
});
router.post('/api/streams', isAuthenticated, [
  body('streamTitle').trim().isLength({ min: 1 }).withMessage('Title is required'),
  body('rtmpUrl').trim().isLength({ min: 1 }).withMessage('RTMP URL is required'),
  body('streamKey').trim().isLength({ min: 1 }).withMessage('Stream key is required')
], async (req, res) => {
  try {
    console.log('Session userId for stream creation:', req.session.userId);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    let platform = 'Custom';
    let platform_icon = 'ti-broadcast';
    if (req.body.rtmpUrl.includes('youtube.com')) {
      platform = 'YouTube';
      platform_icon = 'ti-brand-youtube';
    } else if (req.body.rtmpUrl.includes('facebook.com')) {
      platform = 'Facebook';
      platform_icon = 'ti-brand-facebook';
    } else if (req.body.rtmpUrl.includes('twitch.tv')) {
      platform = 'Twitch';
      platform_icon = 'ti-brand-twitch';
    } else if (req.body.rtmpUrl.includes('tiktok.com')) {
      platform = 'TikTok';
      platform_icon = 'ti-brand-tiktok';
    } else if (req.body.rtmpUrl.includes('instagram.com')) {
      platform = 'Instagram';
      platform_icon = 'ti-brand-instagram';
    } else if (req.body.rtmpUrl.includes('shopee.io')) {
      platform = 'Shopee Live';
      platform_icon = 'ti-brand-shopee';
    } else if (req.body.rtmpUrl.includes('restream.io')) {
      platform = 'Restream.io';
      platform_icon = 'ti-live-photo';
    }
    const streamData = {
      title: req.body.streamTitle,
      video_id: req.body.videoId || null,
      rtmp_url: req.body.rtmpUrl,
      stream_key: req.body.streamKey,
      platform,
      platform_icon,
      bitrate: parseInt(req.body.bitrate) || 2500,
      resolution: req.body.resolution || '1280x720',
      fps: parseInt(req.body.fps) || 30,
      orientation: req.body.orientation || 'horizontal',
      loop_video: req.body.loopVideo === 'true' || req.body.loopVideo === true,
      use_advanced_settings: req.body.useAdvancedSettings === 'true' || req.body.useAdvancedSettings === true,
      user_id: req.session.userId
    };
    const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    function parseLocalDateTime(dateTimeString) {
      const [datePart, timePart] = dateTimeString.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      
      return new Date(year, month - 1, day, hours, minutes);
    }
    
    if (req.body.scheduleStartTime) {
      const scheduleStartDate = parseLocalDateTime(req.body.scheduleStartTime);
      streamData.schedule_time = scheduleStartDate.toISOString();
      streamData.status = 'scheduled';
      
      if (req.body.scheduleEndTime) {
        const scheduleEndDate = parseLocalDateTime(req.body.scheduleEndTime);
        
        if (scheduleEndDate <= scheduleStartDate) {
          return res.status(400).json({ 
            success: false, 
            error: 'End time must be after start time' 
          });
        }
        
        streamData.end_time = scheduleEndDate.toISOString();
        const durationMs = scheduleEndDate - scheduleStartDate;
        const durationMinutes = Math.round(durationMs / (1000 * 60));
        streamData.duration = durationMinutes > 0 ? durationMinutes : null;
      }
    } else if (req.body.scheduleEndTime) {
      const scheduleEndDate = parseLocalDateTime(req.body.scheduleEndTime);
      streamData.end_time = scheduleEndDate.toISOString();
    }
    
    if (!streamData.status) {
      streamData.status = 'offline';
    }
    const stream = await Stream.create(streamData);
    res.json({ success: true, stream });
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ success: false, error: 'Failed to create stream' });
  }
});

router.post('/api/streams/youtube', isAuthenticated, uploadThumbnail.single('thumbnail'), async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const YoutubeChannel = require('../models/YoutubeChannel');
    
    if (!user.youtube_client_id || !user.youtube_client_secret) {
      return res.status(400).json({ 
        success: false, 
        error: 'YouTube API credentials not configured.' 
      });
    }
    const { videoId, title, description, privacy, category, tags, loopVideo, scheduleStartTime, scheduleEndTime, repeat, ytChannelId, ytMonetization } = req.body;
    
    let selectedChannel;
    if (ytChannelId) {
      selectedChannel = await YoutubeChannel.findById(ytChannelId);
      if (!selectedChannel || selectedChannel.user_id !== req.session.userId) {
        return res.status(400).json({ success: false, error: 'Invalid channel selected' });
      }
    } else {
      selectedChannel = await YoutubeChannel.findDefault(req.session.userId);
      if (!selectedChannel) {
        const channels = await YoutubeChannel.findAll(req.session.userId);
        selectedChannel = channels[0];
      }
    }
    
    if (!selectedChannel || !selectedChannel.access_token || !selectedChannel.refresh_token) {
      return res.status(400).json({ 
        success: false, 
        error: 'YouTube account not connected. Please connect your YouTube account in Settings.' 
      });
    }
    
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'Video is required' });
    }
    
    if (!title) {
      return res.status(400).json({ success: false, error: 'Stream title is required' });
    }
    
    let localThumbnailPath = null;
    if (req.file) {
      try {
        const originalFilename = req.file.filename;
        const thumbFilename = `thumb-${path.parse(originalFilename).name}.jpg`;
        await generateImageThumbnail(req.file.path, thumbFilename);
        localThumbnailPath = `/uploads/thumbnails/${thumbFilename}`;
      } catch (thumbError) {
        console.log('Note: Could not process thumbnail:', thumbError.message);
      }
    }
    
    const streamData = {
      title: title,
      video_id: videoId,
      rtmp_url: '',
      stream_key: '',
      platform: 'YouTube',
      platform_icon: 'ti-brand-youtube',
      bitrate: 4000,
      resolution: '1920x1080',
      fps: 30,
      orientation: 'horizontal',
      loop_video: loopVideo === 'true' || loopVideo === true,
      use_advanced_settings: false,
      user_id: req.session.userId,
      youtube_broadcast_id: null,
      youtube_stream_id: null,
      youtube_description: description || '',
      youtube_privacy: privacy || 'unlisted',
      youtube_category: category || '22',
      youtube_tags: tags || '',
      youtube_thumbnail: localThumbnailPath,
      youtube_channel_id: selectedChannel.id,
      is_youtube_api: true,
      youtube_monetization: ytMonetization === 'true' || ytMonetization === true
    };
    
    if (scheduleStartTime) {
      const [datePart, timePart] = scheduleStartTime.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      const scheduleDate = new Date(year, month - 1, day, hours, minutes);
      streamData.schedule_time = scheduleDate.toISOString();
      streamData.status = 'scheduled';
    } else {
      streamData.status = 'offline';
    }
    
    if (scheduleEndTime) {
      const [datePart, timePart] = scheduleEndTime.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      const endDate = new Date(year, month - 1, day, hours, minutes);
      streamData.end_time = endDate.toISOString();
    }
    
    const stream = await Stream.create(streamData);
    
    res.json({ 
      success: true, 
      stream,
      message: 'Stream created. YouTube broadcast will be created when stream starts.'
    });
  } catch (error) {
    console.error('Error creating YouTube stream:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create YouTube stream' 
    });
  }
});

router.get('/api/streams/:id', isAuthenticated, async (req, res) => {
  try {
    const stream = await Stream.getStreamWithVideo(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to access this stream' });
    }
    
    if (stream.youtube_broadcast_id) {
      try {
        const user = await User.findById(req.session.userId);
        if (user.youtube_access_token && user.youtube_client_id && user.youtube_client_secret) {
          const clientSecret = decrypt(user.youtube_client_secret);
          const accessToken = decrypt(user.youtube_access_token);
          const refreshToken = decrypt(user.youtube_refresh_token);
          
          const protocol = req.headers['x-forwarded-proto'] || req.protocol;
          const host = req.headers['x-forwarded-host'] || req.get('host');
          const redirectUri = `${protocol}://${host}/auth/youtube/callback`;
          
          const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
          oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken
          });
          
          const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
          
          const videoResponse = await youtube.videos.list({
            part: 'snippet',
            id: stream.youtube_broadcast_id
          });
          
          if (videoResponse.data.items && videoResponse.data.items.length > 0) {
            const thumbnails = videoResponse.data.items[0].snippet.thumbnails;
            stream.youtube_thumbnail = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url;
          }
        }
      } catch (ytError) {
        console.log('Note: Could not fetch YouTube thumbnail:', ytError.message);
      }
    }
    
    res.json({ success: true, stream });
  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream' });
  }
});
router.put('/api/streams/:id', isAuthenticated, uploadThumbnail.single('thumbnail'), async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to update this stream' });
    }
    const updateData = {};
    
    function parseScheduleDateTime(dateTimeString) {
      const [datePart, timePart] = dateTimeString.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      return new Date(year, month - 1, day, hours, minutes);
    }
    
    if (req.body.streamMode === 'youtube') {
      if (req.body.title) updateData.title = req.body.title;
      if (req.body.videoId) updateData.video_id = req.body.videoId;
      if (req.body.description !== undefined) updateData.youtube_description = req.body.description;
      if (req.body.privacy) updateData.youtube_privacy = req.body.privacy;
      if (req.body.category) updateData.youtube_category = req.body.category;
      if (req.body.tags !== undefined) updateData.youtube_tags = req.body.tags;
      if (req.body.loopVideo !== undefined) {
        updateData.loop_video = req.body.loopVideo === 'true' || req.body.loopVideo === true;
      }
      if (req.body.ytMonetization !== undefined) {
        updateData.youtube_monetization = req.body.ytMonetization === 'true' || req.body.ytMonetization === true;
      }
      
      if (req.body.scheduleStartTime) {
        const scheduleStartDate = parseScheduleDateTime(req.body.scheduleStartTime);
        updateData.schedule_time = scheduleStartDate.toISOString();
        updateData.status = 'scheduled';
        
        if (req.body.scheduleEndTime) {
          const scheduleEndDate = parseScheduleDateTime(req.body.scheduleEndTime);
          updateData.end_time = scheduleEndDate.toISOString();
        } else if ('scheduleEndTime' in req.body && !req.body.scheduleEndTime) {
          updateData.end_time = null;
        }
      } else if ('scheduleStartTime' in req.body && !req.body.scheduleStartTime) {
        updateData.schedule_time = null;
        if ('scheduleEndTime' in req.body && !req.body.scheduleEndTime) {
          updateData.end_time = null;
        } else if (req.body.scheduleEndTime) {
          const scheduleEndDate = parseScheduleDateTime(req.body.scheduleEndTime);
          updateData.end_time = scheduleEndDate.toISOString();
        }
      }
      
      if (req.file) {
        try {
          const originalFilename = req.file.filename;
          const thumbFilename = `thumb-${path.parse(originalFilename).name}.jpg`;
          await generateImageThumbnail(req.file.path, thumbFilename);
          updateData.youtube_thumbnail = `/uploads/thumbnails/${thumbFilename}`;
        } catch (thumbError) {
          console.log('Note: Could not process thumbnail:', thumbError.message);
        }
      }
      
      if (stream.youtube_broadcast_id) {
        try {
          const user = await User.findById(req.session.userId);
          if (user.youtube_client_id && user.youtube_client_secret) {
            const YoutubeChannel = require('../models/YoutubeChannel');
            let selectedChannel = await YoutubeChannel.findById(stream.youtube_channel_id);
            if (!selectedChannel) {
              selectedChannel = await YoutubeChannel.findDefault(req.session.userId);
            }
            
            if (selectedChannel && selectedChannel.access_token) {
              const clientSecret = decrypt(user.youtube_client_secret);
              const accessToken = decrypt(selectedChannel.access_token);
              const refreshToken = decrypt(selectedChannel.refresh_token);
              
              const protocol = req.headers['x-forwarded-proto'] || req.protocol;
              const host = req.headers['x-forwarded-host'] || req.get('host');
              const redirectUri = `${protocol}://${host}/auth/youtube/callback`;
              
              const oauth2Client = getYouTubeOAuth2Client(user.youtube_client_id, clientSecret, redirectUri);
              oauth2Client.setCredentials({
                access_token: accessToken,
                refresh_token: refreshToken
              });
              
              const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
              
              const broadcastUpdateData = {
                id: stream.youtube_broadcast_id,
                snippet: {
                  title: req.body.title || stream.title,
                  description: req.body.description !== undefined ? req.body.description : (stream.youtube_description || ''),
                  scheduledStartTime: req.body.scheduleStartTime 
                    ? new Date(req.body.scheduleStartTime).toISOString() 
                    : (stream.schedule_time || new Date().toISOString())
                }
              };
              
              const privacyUpdateData = {
                id: stream.youtube_broadcast_id,
                status: {
                  privacyStatus: req.body.privacy || stream.youtube_privacy || 'unlisted'
                }
              };
              
              try {
                await youtube.liveBroadcasts.update({
                  part: 'snippet',
                  requestBody: broadcastUpdateData
                });
              } catch (snippetError) {
                console.log('Note: Could not update broadcast snippet:', snippetError.message);
              }
              
              try {
                await youtube.liveBroadcasts.update({
                  part: 'status',
                  requestBody: privacyUpdateData
                });
              } catch (statusError) {
                console.log('Note: Could not update broadcast status:', statusError.message);
              }

              if (req.body.ytMonetization !== undefined) {
                try {
                  const { syncBroadcastMonetization } = require('../services/youtubeService');
                  const shouldEnableMonetization = req.body.ytMonetization === 'true' || req.body.ytMonetization === true;
                  await syncBroadcastMonetization(youtube, stream.youtube_broadcast_id, shouldEnableMonetization);
                } catch (monetizationError) {
                  console.log('Note: Could not update broadcast monetization:', monetizationError.message);
                  updateData.youtube_monetization = false;
                }
              }
              
              const tagsArray = req.body.tags ? req.body.tags.split(',').map(t => t.trim()).filter(t => t) : [];
              if (tagsArray.length > 0 || req.body.category) {
                try {
                  await youtube.videos.update({
                    part: 'snippet',
                    requestBody: {
                      id: stream.youtube_broadcast_id,
                      snippet: {
                        title: req.body.title || stream.title,
                        description: req.body.description !== undefined ? req.body.description : (stream.youtube_description || ''),
                        categoryId: req.body.category || stream.youtube_category || '22',
                        tags: tagsArray.length > 0 ? tagsArray : undefined
                      }
                    }
                  });
                } catch (videoUpdateError) {
                  console.log('Note: Could not update video metadata:', videoUpdateError.message);
                }
              }
              
              if (req.file && updateData.youtube_thumbnail) {
                try {
                  const thumbnailPath = path.join(__dirname, '../../public', updateData.youtube_thumbnail);
                  if (fs.existsSync(thumbnailPath)) {
                    const thumbnailStream = fs.createReadStream(thumbnailPath);
                    await youtube.thumbnails.set({
                      videoId: stream.youtube_broadcast_id,
                      media: {
                        mimeType: 'image/jpeg',
                        body: thumbnailStream
                      }
                    });
                  }
                } catch (thumbError) {
                  console.log('Note: Could not upload thumbnail to YouTube:', thumbError.message);
                }
              }
            }
          }
        } catch (youtubeError) {
          console.log('Note: Could not update YouTube metadata:', youtubeError.message);
        }
      }
      
      await Stream.update(req.params.id, updateData);
      return res.json({ success: true, message: 'Stream updated successfully' });
    }
    
    if (req.body.streamTitle) updateData.title = req.body.streamTitle;
    if (req.body.videoId) updateData.video_id = req.body.videoId;
    
    if (req.body.rtmpUrl) {
      updateData.rtmp_url = req.body.rtmpUrl;
      
      let platform = 'Custom';
      let platform_icon = 'ti-broadcast';
      if (req.body.rtmpUrl.includes('youtube.com')) {
        platform = 'YouTube';
        platform_icon = 'ti-brand-youtube';
      } else if (req.body.rtmpUrl.includes('facebook.com')) {
        platform = 'Facebook';
        platform_icon = 'ti-brand-facebook';
      } else if (req.body.rtmpUrl.includes('twitch.tv')) {
        platform = 'Twitch';
        platform_icon = 'ti-brand-twitch';
      } else if (req.body.rtmpUrl.includes('tiktok.com')) {
        platform = 'TikTok';
        platform_icon = 'ti-brand-tiktok';
      } else if (req.body.rtmpUrl.includes('instagram.com')) {
        platform = 'Instagram';
        platform_icon = 'ti-brand-instagram';
      } else if (req.body.rtmpUrl.includes('shopee.io')) {
        platform = 'Shopee Live';
        platform_icon = 'ti-brand-shopee';
      } else if (req.body.rtmpUrl.includes('restream.io')) {
        platform = 'Restream.io';
        platform_icon = 'ti-live-photo';
      }
      updateData.platform = platform;
      updateData.platform_icon = platform_icon;
    }
    
    if (req.body.streamKey) updateData.stream_key = req.body.streamKey;
    if (req.body.bitrate) updateData.bitrate = parseInt(req.body.bitrate);
    if (req.body.resolution) updateData.resolution = req.body.resolution;
    if (req.body.fps) updateData.fps = parseInt(req.body.fps);
    if (req.body.orientation) updateData.orientation = req.body.orientation;
    if (req.body.loopVideo !== undefined) {
      updateData.loop_video = req.body.loopVideo === 'true' || req.body.loopVideo === true;
    }
    if (req.body.useAdvancedSettings !== undefined) {
      updateData.use_advanced_settings = req.body.useAdvancedSettings === 'true' || req.body.useAdvancedSettings === true;
    }
    const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    function parseLocalDateTime(dateTimeString) {
      const [datePart, timePart] = dateTimeString.split('T');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hours, minutes] = timePart.split(':').map(Number);
      
      return new Date(year, month - 1, day, hours, minutes);
    }
    
    if (req.body.scheduleStartTime) {
      const scheduleStartDate = parseLocalDateTime(req.body.scheduleStartTime);
      updateData.schedule_time = scheduleStartDate.toISOString();
      updateData.status = 'scheduled';
      
      if (req.body.scheduleEndTime) {
        const scheduleEndDate = parseLocalDateTime(req.body.scheduleEndTime);
        
        if (scheduleEndDate <= scheduleStartDate) {
          return res.status(400).json({ 
            success: false, 
            error: 'End time must be after start time' 
          });
        }
        
        updateData.end_time = scheduleEndDate.toISOString();
        const durationMs = scheduleEndDate - scheduleStartDate;
        const durationMinutes = Math.round(durationMs / (1000 * 60));
        updateData.duration = durationMinutes > 0 ? durationMinutes : null;
      } else if ('scheduleEndTime' in req.body && req.body.scheduleEndTime === '') {
        updateData.end_time = null;
        updateData.duration = null;
      }
    } else if ('scheduleStartTime' in req.body && !req.body.scheduleStartTime) {
      updateData.schedule_time = null;
      updateData.status = 'offline';
      
      if (req.body.scheduleEndTime) {
        const scheduleEndDate = parseLocalDateTime(req.body.scheduleEndTime);
        updateData.end_time = scheduleEndDate.toISOString();
      } else if ('scheduleEndTime' in req.body && req.body.scheduleEndTime === '') {
        updateData.end_time = null;
        updateData.duration = null;
      }
    } else if (req.body.scheduleEndTime) {
      const scheduleEndDate = parseLocalDateTime(req.body.scheduleEndTime);
      updateData.end_time = scheduleEndDate.toISOString();
    } else if ('scheduleEndTime' in req.body && req.body.scheduleEndTime === '') {
      updateData.end_time = null;
      updateData.duration = null;
    }
    
    const updatedStream = await Stream.update(req.params.id, updateData);
    res.json({ success: true, stream: updatedStream });
  } catch (error) {
    console.error('Error updating stream:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream' });
  }
});
router.delete('/api/streams/:id', isAuthenticated, async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this stream' });
    }
    await Stream.delete(req.params.id, req.session.userId);
    res.json({ success: true, message: 'Stream deleted successfully' });
  } catch (error) {
    console.error('Error deleting stream:', error);
    res.status(500).json({ success: false, error: 'Failed to delete stream' });
  }
});
router.post('/api/streams/:id/status', isAuthenticated, [
  body('status').isIn(['live', 'offline', 'scheduled']).withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const newStatus = req.body.status;
    if (newStatus === 'live') {
      if (stream.status === 'live') {
        return res.json({
          success: false,
          error: 'Stream is already live',
          stream
        });
      }
      if (streamingService.isStreamStarting(streamId)) {
        return res.status(409).json({
          success: false,
          error: 'Stream start is already in progress'
        });
      }
      if (!stream.video_id) {
        return res.json({
          success: false,
          error: 'No video attached to this stream',
          stream
        });
      }
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const baseUrl = `${protocol}://${host}`;
      const result = await streamingService.startStream(streamId, false, baseUrl);
      if (result.success) {
        const updatedStream = await Stream.getStreamWithVideo(streamId);
        return res.json({
          success: true,
          stream: updatedStream,
          isAdvancedMode: result.isAdvancedMode
        });
      } else {
        return res.status(500).json({
          success: false,
          error: result.error || 'Failed to start stream'
        });
      }
    } else if (newStatus === 'offline') {
      if (stream.status === 'live') {
        const result = await streamingService.stopStream(streamId);
        if (!result.success) {
          console.warn('Failed to stop FFmpeg process:', result.error);
        }
      } else if (stream.status === 'scheduled') {
        await Stream.update(streamId, {
          schedule_time: null,
          end_time: null,
          status: 'offline'
        });
      }
      const result = await Stream.updateStatus(streamId, 'offline', req.session.userId);
      if (!result.updated) {
        return res.status(404).json({
          success: false,
          error: 'Stream not found or not updated'
        });
      }
      return res.json({ success: true, stream: result });
    } else {
      const result = await Stream.updateStatus(streamId, newStatus, req.session.userId);
      if (!result.updated) {
        return res.status(404).json({
          success: false,
          error: 'Stream not found or not updated'
        });
      }
      return res.json({ success: true, stream: result });
    }
  } catch (error) {
    console.error('Error updating stream status:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream status' });
  }
});
router.get('/api/streams/check-key', isAuthenticated, async (req, res) => {
  try {
    const streamKey = req.query.key;
    const excludeId = req.query.excludeId || null;
    if (!streamKey) {
      return res.status(400).json({
        success: false,
        error: 'Stream key is required'
      });
    }
    const isInUse = await Stream.isStreamKeyInUse(streamKey, req.session.userId, excludeId);
    res.json({
      success: true,
      isInUse: isInUse,
      message: isInUse ? 'Stream key is already in use' : 'Stream key is available'
    });
  } catch (error) {
    console.error('Error checking stream key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check stream key'
    });
  }
});
router.get('/api/streams/:id/logs', isAuthenticated, async (req, res) => {
  try {
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const logs = streamingService.getStreamLogs(streamId);
    const isActive = streamingService.isStreamActive(streamId);
    res.json({
      success: true,
      logs,
      isActive,
      stream
    });
  } catch (error) {
    console.error('Error fetching stream logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream logs' });
  }
});
router.get('/playlist', isAuthenticated, async (req, res) => {
  try {
    const playlists = await Playlist.findAll(req.session.userId);
    const allVideos = await Video.findAll(req.session.userId);
    const videos = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      if (filepath.includes('/audio/')) return false;
      if (filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3')) return false;
      return true;
    });
    const audios = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      return filepath.includes('/audio/') || filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3');
    });
    res.render('playlist', {
      title: 'Playlist',
      active: 'playlist',
      user: await User.findById(req.session.userId),
      playlists: playlists,
      videos: videos,
      audios: audios
    });
  } catch (error) {
    console.error('Playlist error:', error);
    res.redirect('/dashboard');
  }
});

router.get('/api/playlists', isAuthenticated, async (req, res) => {
  try {
    const playlists = await Playlist.findAll(req.session.userId);
    
    playlists.forEach(playlist => {
      playlist.shuffle = playlist.is_shuffle;
    });
    
    res.json({ success: true, playlists });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch playlists' });
  }
});

router.post('/api/playlists', isAuthenticated, [
  body('name').trim().isLength({ min: 1 }).withMessage('Playlist name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const playlistData = {
      name: req.body.name,
      description: req.body.description || null,
      is_shuffle: req.body.shuffle === 'true' || req.body.shuffle === true,
      user_id: req.session.userId
    };

    const playlist = await Playlist.create(playlistData);
    
    if (req.body.videos && Array.isArray(req.body.videos) && req.body.videos.length > 0) {
      for (let i = 0; i < req.body.videos.length; i++) {
        await Playlist.addVideo(playlist.id, req.body.videos[i], i + 1);
      }
    }

    if (req.body.audios && Array.isArray(req.body.audios) && req.body.audios.length > 0) {
      for (let i = 0; i < req.body.audios.length; i++) {
        await Playlist.addAudio(playlist.id, req.body.audios[i], i + 1);
      }
    }
    
    res.json({ success: true, playlist });
  } catch (error) {
    console.error('Error creating playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to create playlist' });
  }
});

router.get('/api/playlists/:id', isAuthenticated, async (req, res) => {
  try {
    const playlist = await Playlist.findByIdWithVideos(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    playlist.shuffle = playlist.is_shuffle;
    
    res.json({ success: true, playlist });
  } catch (error) {
    console.error('Error fetching playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch playlist' });
  }
});

router.put('/api/playlists/:id', isAuthenticated, [
  body('name').trim().isLength({ min: 1 }).withMessage('Playlist name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const updateData = {
      name: req.body.name,
      description: req.body.description || null,
      is_shuffle: req.body.shuffle === 'true' || req.body.shuffle === true
    };

    const updatedPlaylist = await Playlist.update(req.params.id, updateData);
    
    if (req.body.videos && Array.isArray(req.body.videos)) {
      const existingVideos = await Playlist.findByIdWithVideos(req.params.id);
      if (existingVideos && existingVideos.videos) {
        for (const video of existingVideos.videos) {
          await Playlist.removeVideo(req.params.id, video.id);
        }
      }
      
      for (let i = 0; i < req.body.videos.length; i++) {
        await Playlist.addVideo(req.params.id, req.body.videos[i], i + 1);
      }
    }

    if (req.body.audios && Array.isArray(req.body.audios)) {
      await Playlist.clearAudios(req.params.id);
      for (let i = 0; i < req.body.audios.length; i++) {
        await Playlist.addAudio(req.params.id, req.body.audios[i], i + 1);
      }
    }
    
    res.json({ success: true, playlist: updatedPlaylist });
  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to update playlist' });
  }
});

router.delete('/api/playlists/:id', isAuthenticated, async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await Playlist.delete(req.params.id);
    res.json({ success: true, message: 'Playlist deleted successfully' });
  } catch (error) {
    console.error('Error deleting playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to delete playlist' });
  }
});

router.post('/api/playlists/:id/videos', isAuthenticated, [
  body('videoId').notEmpty().withMessage('Video ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const video = await Video.findById(req.body.videoId);
    if (!video || video.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    const position = await Playlist.getNextPosition(req.params.id);
    await Playlist.addVideo(req.params.id, req.body.videoId, position);
    
    res.json({ success: true, message: 'Video added to playlist' });
  } catch (error) {
    console.error('Error adding video to playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to add video to playlist' });
  }
});

router.delete('/api/playlists/:id/videos/:videoId', isAuthenticated, async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await Playlist.removeVideo(req.params.id, req.params.videoId);
    res.json({ success: true, message: 'Video removed from playlist' });
  } catch (error) {
    console.error('Error removing video from playlist:', error);
    res.status(500).json({ success: false, error: 'Failed to remove video from playlist' });
  }
});

router.put('/api/playlists/:id/videos/reorder', isAuthenticated, [
  body('videoPositions').isArray().withMessage('Video positions must be an array')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      return res.status(404).json({ success: false, error: 'Playlist not found' });
    }
    if (playlist.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await Playlist.updateVideoPositions(req.params.id, req.body.videoPositions);
    res.json({ success: true, message: 'Video order updated' });
  } catch (error) {
    console.error('Error reordering videos:', error);
    res.status(500).json({ success: false, error: 'Failed to reorder videos' });
  }
});


router.get('/api/server-time', (req, res) => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[now.getMonth()];
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const formattedTime = `${day} ${month} ${year} ${hours}:${minutes}:${seconds}`;
  const serverTimezoneOffset = now.getTimezoneOffset();
  res.json({
    serverTime: now.toISOString(),
    formattedTime: formattedTime,
    timezoneOffset: serverTimezoneOffset
  });
});

const Rotation = require('../models/Rotation');

router.get('/rotations', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const allVideos = await Video.findAll(req.session.userId);
    const videos = allVideos.filter(video => {
      const filepath = (video.filepath || '').toLowerCase();
      if (filepath.includes('/audio/')) return false;
      if (filepath.endsWith('.m4a') || filepath.endsWith('.aac') || filepath.endsWith('.mp3')) return false;
      return true;
    });
    const playlists = await Playlist.findAll(req.session.userId);
    const rotations = await Rotation.findAll(req.session.userId);
    const YoutubeChannel = require('../models/YoutubeChannel');
    const youtubeChannels = await YoutubeChannel.findAll(req.session.userId);
    const isYoutubeConnected = youtubeChannels.length > 0;
    const defaultChannel = youtubeChannels.find(c => c.is_default) || youtubeChannels[0];
    
    res.render('rotations', {
      title: 'Stream Rotations',
      active: 'rotations',
      user: user,
      videos: videos,
      playlists: playlists,
      rotations: rotations,
      youtubeConnected: isYoutubeConnected,
      youtubeChannels: youtubeChannels,
      youtubeChannelName: defaultChannel?.channel_name || '',
      youtubeChannelThumbnail: defaultChannel?.channel_thumbnail || '',
      youtubeSubscriberCount: defaultChannel?.subscriber_count || '0'
    });
  } catch (error) {
    console.error('Rotations page error:', error);
    res.redirect('/dashboard');
  }
});

router.get('/api/rotations', isAuthenticated, async (req, res) => {
  try {
    const rotations = await Rotation.findAll(req.session.userId);
    res.json({ success: true, rotations });
  } catch (error) {
    console.error('Error fetching rotations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rotations' });
  }
});

router.get('/api/rotations/:id', isAuthenticated, async (req, res) => {
  try {
    const rotation = await Rotation.findByIdWithItems(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    res.json({ success: true, rotation });
  } catch (error) {
    console.error('Error fetching rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rotation' });
  }
});

router.post('/api/rotations', isAuthenticated, uploadThumbnail.any(), async (req, res) => {
  try {
    const { name, repeat_mode, start_time, end_time, items, youtube_channel_id } = req.body;
    
    const parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
    
    if (!name || !parsedItems || parsedItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Name and at least one item are required' });
    }
    
    if (!start_time || !end_time) {
      return res.status(400).json({ success: false, error: 'Start time and end time are required' });
    }
    
    const rotation = await Rotation.create({
      user_id: req.session.userId,
      name,
      is_loop: true,
      start_time,
      end_time,
      repeat_mode: repeat_mode || 'daily',
      youtube_channel_id: youtube_channel_id || null
    });
    
    const uploadedFiles = req.files || [];
    const uploadedFileMap = new Map(
      uploadedFiles.map(file => [file.fieldname, file])
    );
    
    for (let i = 0; i < parsedItems.length; i++) {
      const item = parsedItems[i];
      const thumbnailFile = uploadedFileMap.get(`thumbnail_${item.thumbnail_upload_index}`);
      
      let thumbnailPath = null;
      let originalThumbnailPath = null;
      if (thumbnailFile && thumbnailFile.size > 0) {
        const originalFilename = thumbnailFile.filename;
        const thumbFilename = `thumb-${path.parse(originalFilename).name}.jpg`;
        
        originalThumbnailPath = originalFilename;
        
        try {
          await generateImageThumbnail(thumbnailFile.path, thumbFilename);
          thumbnailPath = thumbFilename;
        } catch (thumbErr) {
          console.error('Error generating rotation thumbnail:', thumbErr);
          thumbnailPath = originalFilename;
        }
      }
      
      await Rotation.addItem({
        rotation_id: rotation.id,
        order_index: item.order_index,
        video_id: item.video_id,
        title: item.title,
        description: item.description || '',
        tags: item.tags || '',
        thumbnail_path: thumbnailPath,
        original_thumbnail_path: originalThumbnailPath,
        privacy: item.privacy || 'unlisted',
        category: item.category || '22',
        youtube_monetization: item.youtube_monetization === true || item.youtube_monetization === 'true'
      });
    }
    
    res.json({ success: true, rotation });
  } catch (error) {
    console.error('Error creating rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to create rotation' });
  }
});

router.put('/api/rotations/:id', isAuthenticated, uploadThumbnail.any(), async (req, res) => {
  try {
    const rotation = await Rotation.findById(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    const { name, repeat_mode, start_time, end_time, items, youtube_channel_id } = req.body;
    
    const parsedItems = typeof items === 'string' ? JSON.parse(items) : items;
    
    await Rotation.update(req.params.id, {
      name,
      is_loop: true,
      start_time,
      end_time,
      repeat_mode: repeat_mode || 'daily',
      youtube_channel_id: youtube_channel_id || null
    });
    
    const existingItems = await Rotation.getItemsByRotationId(req.params.id);
    for (const item of existingItems) {
      await Rotation.deleteItem(item.id);
    }
    
    const uploadedFiles = req.files || [];
    const uploadedFileMap = new Map(
      uploadedFiles.map(file => [file.fieldname, file])
    );
    
    for (let i = 0; i < parsedItems.length; i++) {
      const item = parsedItems[i];
      const thumbnailFile = uploadedFileMap.get(`thumbnail_${item.thumbnail_upload_index}`);
      
      let thumbnailPath = item.thumbnail_path && item.thumbnail_path !== 'rotations' ? item.thumbnail_path : null;
      let originalThumbnailPath = item.original_thumbnail_path || null;
      if (thumbnailFile && thumbnailFile.size > 0) {
        const originalFilename = thumbnailFile.filename;
        const thumbFilename = `thumb-${path.parse(originalFilename).name}.jpg`;
        
        originalThumbnailPath = originalFilename;
        
        try {
          await generateImageThumbnail(thumbnailFile.path, thumbFilename);
          thumbnailPath = thumbFilename;
        } catch (thumbErr) {
          console.error('Error generating rotation thumbnail:', thumbErr);
          thumbnailPath = originalFilename;
        }
      }
      
      await Rotation.addItem({
        rotation_id: req.params.id,
        order_index: item.order_index,
        video_id: item.video_id,
        title: item.title,
        description: item.description || '',
        tags: item.tags || '',
        thumbnail_path: thumbnailPath,
        original_thumbnail_path: originalThumbnailPath,
        privacy: item.privacy || 'unlisted',
        category: item.category || '22',
        youtube_monetization: item.youtube_monetization === true || item.youtube_monetization === 'true'
      });
    }
    
    res.json({ success: true, message: 'Rotation updated' });
  } catch (error) {
    console.error('Error updating rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to update rotation' });
  }
});

router.delete('/api/rotations/:id', isAuthenticated, async (req, res) => {
  try {
    const rotation = await Rotation.findById(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    if (rotation.status === 'active') {
      await rotationService.stopRotation(req.params.id);
    }
    
    await Rotation.delete(req.params.id, req.session.userId);
    res.json({ success: true, message: 'Rotation deleted' });
  } catch (error) {
    console.error('Error deleting rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to delete rotation' });
  }
});

router.post('/api/rotations/:id/activate', isAuthenticated, async (req, res) => {
  try {
    const rotation = await Rotation.findById(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    const result = await rotationService.activateRotation(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error activating rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to activate rotation' });
  }
});

router.post('/api/rotations/:id/pause', isAuthenticated, async (req, res) => {
  try {
    const rotation = await Rotation.findById(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    const result = await rotationService.pauseRotation(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error pausing rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to pause rotation' });
  }
});

router.post('/api/rotations/:id/stop', isAuthenticated, async (req, res) => {
  try {
    const rotation = await Rotation.findById(req.params.id);
    if (!rotation) {
      return res.status(404).json({ success: false, error: 'Rotation not found' });
    }
    if (rotation.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    const result = await rotationService.stopRotation(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error stopping rotation:', error);
    res.status(500).json({ success: false, error: 'Failed to stop rotation' });
  }
});

module.exports = router;

