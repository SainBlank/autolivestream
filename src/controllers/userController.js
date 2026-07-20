const db = require('../models/database');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

exports.getProfile = (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err || !row) {
            return res.redirect('/');
        }
        res.render('profile', {
            title: 'Profile',
            user: row,
            path: '/profile',
            query: req.query
        });
    });
};

exports.updateProfile = async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { username, password, new_password, language } = req.body;
    const currentUserId = req.session.userId;
    const currentUser = req.session.user.username;

    if (!username || typeof username !== 'string') {
        return res.redirect('/profile?error=Invalid username');
    }

    db.get('SELECT * FROM users WHERE id = ?', [currentUserId], async (err, row) => {
        if (err || !row) return res.redirect('/profile?error=User not found');

        if (!req.session.user) {
            req.session.user = {
                id: row.id,
                username: row.username,
                avatar: row.avatar,
                language: row.language
            };
        }

        const updates = [];
        const params = [];

        if (language && language !== row.language) {
            updates.push('language = ?');
            params.push(language);
            req.session.language = language;
            req.session.user.language = language;
        }

        if (req.file) {
            updates.push('avatar = ?');
            params.push(req.file.filename);
            req.session.user.avatar = req.file.filename;
        }

        if (new_password) {
            if (row.password) {
                const match = await bcrypt.compare(password, row.password);
                if (!match) return res.redirect('/profile?error=Incorrect current password');
            }
            const hashedPassword = await bcrypt.hash(new_password, 10);
            updates.push('password = ?');
            params.push(hashedPassword);
        }

        if (username && username !== currentUser) {
            const existingUser = await new Promise((resolve, reject) => {
                db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });

            if (existingUser) {
                return res.redirect('/profile?error=Username already taken');
            }

            updates.push('username = ?');
            params.push(username);
            req.session.user.username = username;
            req.session.username = username;
        }

        if (updates.length > 0) {
            params.push(currentUserId);
            db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err) => {
                if (err) return res.redirect('/profile?error=Update failed');
                res.redirect('/profile?success=Profile updated');
            });
        } else {
            res.redirect('/profile');
        }
    });
};
