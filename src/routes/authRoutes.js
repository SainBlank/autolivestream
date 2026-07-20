const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { checkIfUsersExist } = require('../models/database');
const { upload } = require('../middleware/uploadMiddleware');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('login', {
      title: 'Login',
      error: 'Too many login attempts. Please try again in 15 minutes.'
    });
  },
  requestWasSuccessful: (request, response) => {
    return response.statusCode < 400;
  }
});
const loginDelayMiddleware = async (req, res, next) => {
  await new Promise(resolve => setTimeout(resolve, 1000));
  next();
};
router.get('/login', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  try {
    const usersExist = await checkIfUsersExist();
    if (!usersExist) {
      return res.redirect('/setup-account');
    }
    
    const AppSettings = require('../models/AppSettings');
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    res.render('login', {
      title: 'Login',
      error: null,
      recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
    });
  } catch (error) {
    console.error('Error checking for users:', error);
    res.render('login', {
      title: 'Login',
      error: 'System error. Please try again.',
      recaptchaSiteKey: null
    });
  }
});
router.post('/login', loginDelayMiddleware, loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const recaptchaResponse = req.body['g-recaptcha-response'];
  
  try {
    const AppSettings = require('../models/AppSettings');
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    if (recaptchaSettings.hasKeys && recaptchaSettings.enabled) {
      if (!recaptchaResponse) {
        return res.render('login', {
          title: 'Login',
          error: 'Please complete the reCAPTCHA verification',
          recaptchaSiteKey: recaptchaSettings.siteKey
        });
      }
      
      const { decrypt } = require('../utils/encryption');
      const secretKey = decrypt(recaptchaSettings.secretKey);
      
      const axios = require('axios');
      const verifyResponse = await axios.post(
        'https://www.google.com/recaptcha/api/siteverify',
        `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(recaptchaResponse)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      if (!verifyResponse.data.success) {
        return res.render('login', {
          title: 'Login',
          error: 'reCAPTCHA verification failed. Please try again.',
          recaptchaSiteKey: recaptchaSettings.siteKey
        });
      }
    }
    
    const user = await User.findByUsername(username);
    if (!user) {
      return res.render('login', {
        title: 'Login',
        error: 'Invalid username or password',
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }
    const passwordMatch = await User.verifyPassword(password, user.password);
    if (!passwordMatch) {
      return res.render('login', {
        title: 'Login',
        error: 'Invalid username or password',
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }
    
    if (user.status !== 'active') {
      return res.render('login', {
        title: 'Login',
        error: 'Your account is not active. Please contact administrator for activation.',
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.avatar_path = user.avatar_path;
    req.session.user_role = user.user_role;
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', {
      title: 'Login',
      error: 'An error occurred during login. Please try again.',
      recaptchaSiteKey: null
    });
  }
});
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

router.get('/signup', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  try {
    const usersExist = await checkIfUsersExist();
    if (!usersExist) {
      return res.redirect('/setup-account');
    }
    
    const AppSettings = require('../models/AppSettings');
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    res.render('signup', {
      title: 'Sign Up',
      error: null,
      success: null,
      recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
    });
  } catch (error) {
    console.error('Error loading signup page:', error);
    res.render('signup', {
      title: 'Sign Up',
      error: 'System error. Please try again.',
      success: null,
      recaptchaSiteKey: null
    });
  }
});

router.post('/signup', upload.single('avatar'), async (req, res) => {
  const { username, password, confirmPassword, user_role, status } = req.body;
  const recaptchaResponse = req.body['g-recaptcha-response'];
  
  try {
    const AppSettings = require('../models/AppSettings');
    const recaptchaSettings = await AppSettings.getRecaptchaSettings();
    
    if (recaptchaSettings.hasKeys && recaptchaSettings.enabled) {
      if (!recaptchaResponse) {
        return res.render('signup', {
          title: 'Sign Up',
          error: 'Please complete the reCAPTCHA verification',
          success: null,
          recaptchaSiteKey: recaptchaSettings.siteKey
        });
      }
      
      const { decrypt } = require('../utils/encryption');
      const secretKey = decrypt(recaptchaSettings.secretKey);
      
      const axios = require('axios');
      const verifyResponse = await axios.post(
        'https://www.google.com/recaptcha/api/siteverify',
        `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(recaptchaResponse)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      
      if (!verifyResponse.data.success) {
        return res.render('signup', {
          title: 'Sign Up',
          error: 'reCAPTCHA verification failed. Please try again.',
          success: null,
          recaptchaSiteKey: recaptchaSettings.siteKey
        });
      }
    }
    
    if (!username || !password) {
      return res.render('signup', {
        title: 'Sign Up',
        error: 'Username and password are required',
        success: null,
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }

    if (password !== confirmPassword) {
      return res.render('signup', {
        title: 'Sign Up',
        error: 'Passwords do not match',
        success: null,
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }

    if (password.length < 6) {
      return res.render('signup', {
        title: 'Sign Up',
        error: 'Password must be at least 6 characters long',
        success: null,
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }

    const existingUser = await User.findByUsername(username);
    if (existingUser) {
      return res.render('signup', {
        title: 'Sign Up',
        error: 'Username already exists',
        success: null,
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }

    let avatarPath = null;
    if (req.file) {
      avatarPath = `/uploads/avatars/${req.file.filename}`;
    }

    const newUser = await User.create({
      username,
      password,
      avatar_path: avatarPath,
      user_role: user_role || 'member',
      status: status || 'inactive'
    });

    if (newUser) {
      return res.render('signup', {
        title: 'Sign Up',
        error: null,
        success: 'Account created successfully! Please wait for admin approval to activate your account.',
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    } else {
      return res.render('signup', {
        title: 'Sign Up',
        error: 'Failed to create account. Please try again.',
        success: null,
        recaptchaSiteKey: recaptchaSettings.hasKeys && recaptchaSettings.enabled ? recaptchaSettings.siteKey : null
      });
    }
  } catch (error) {
    console.error('Signup error:', error);
    return res.render('signup', {
      title: 'Sign Up',
      error: 'An error occurred during registration. Please try again.',
      success: null,
      recaptchaSiteKey: null
    });
  }
});

router.get('/setup-account', async (req, res) => {
  try {
    const usersExist = await checkIfUsersExist();
    if (usersExist && !req.session.userId) {
      return res.redirect('/login');
    }
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && user.username) {
        return res.redirect('/dashboard');
      }
    }
    res.render('setup-account', {
      title: 'Complete Your Account',
      user: req.session.userId ? await User.findById(req.session.userId) : {},
      error: null
    });
  } catch (error) {
    console.error('Setup account error:', error);
    res.redirect('/login');
  }
});
router.post('/setup-account', upload.single('avatar'), [
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.render('setup-account', {
        title: 'Complete Your Account',
        user: { username: req.body.username || '' },
        error: errors.array()[0].msg
      });
    }
    const existingUsername = await User.findByUsername(req.body.username);
    if (existingUsername) {
      return res.render('setup-account', {
        title: 'Complete Your Account',
        user: { email: req.body.email || '' },
        error: 'Username is already taken'
      });
    }
    const avatarPath = req.file ? `/uploads/avatars/${req.file.filename}` : null;
    const usersExist = await checkIfUsersExist();
    if (!usersExist) {
      try {
        const user = await User.create({
          username: req.body.username,
          password: req.body.password,
          avatar_path: avatarPath,
          user_role: 'admin',
          status: 'active'
        });
        req.session.userId = user.id;
        req.session.username = req.body.username;
        req.session.user_role = user.user_role;
        if (avatarPath) {
          req.session.avatar_path = avatarPath;
        }
        console.log('Setup account - Using user ID from database:', user.id);
        console.log('Setup account - Session userId set to:', req.session.userId);
        return res.redirect('/welcome');
      } catch (error) {
        console.error('User creation error:', error);
        return res.render('setup-account', {
          title: 'Complete Your Account',
          user: {},
          error: 'Failed to create user. Please try again.'
        });
      }
    } else {
      await User.update(req.session.userId, {
        username: req.body.username,
        password: req.body.password,
        avatar_path: avatarPath,
      });
      req.session.username = req.body.username;
      if (avatarPath) {
        req.session.avatar_path = avatarPath;
      }
      res.redirect('/dashboard');
    }
  } catch (error) {
    console.error('Account setup error:', error);
    res.render('setup-account', {
      title: 'Complete Your Account',
      user: { email: req.body.email || '' },
      error: 'An error occurred. Please try again.'
    });
  }
});
module.exports = router;

