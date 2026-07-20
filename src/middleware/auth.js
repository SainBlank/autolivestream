const db = require('../models/database');

const checkAuth = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/login');
};

const checkSetup = (req, res, next) => {
    db.get('SELECT count(*) as count FROM users', [], (err, row) => {
        if (err) {
            console.error("Database error in checkSetup:", err);
            return next(err);
        }

        if (row.count === 0) {
            if (req.path === '/setup-account' || req.path.startsWith('/public') || req.path.startsWith('/api/auth')) {
                return next();
            }
            return res.redirect('/setup-account');
        }

        if (req.path === '/setup-account') {
            return res.redirect('/login');
        }

        next();
    });
};

const isAuthenticated = checkAuth;

const isAdmin = (req, res, next) => {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) return res.redirect('/login');
    if (user.user_role !== 'admin') {
        return res.redirect('/');
    }
    req.user = user;
    next();
  });
};

module.exports = { checkAuth, checkSetup, isAuthenticated, isAdmin };
