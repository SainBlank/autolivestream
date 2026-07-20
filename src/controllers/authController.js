const bcrypt = require('bcrypt');
const db = require('../models/database');

exports.getLogin = (req, res) => {
    res.render('auth/login', { title: 'Login - StreamFire', error: null });
};

exports.postLogin = async (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) return res.render('auth/login', { title: 'Login', error: 'Database error' });
        if (!user) return res.render('auth/login', { title: 'Login', error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.userId = user.id;
            req.session.user = {
                id: user.id,
                username: user.username,
                avatar: user.avatar,
                language: user.language
            };
            req.session.language = user.language || 'id';
            return res.redirect('/');
        }

        res.render('auth/login', { title: 'Login', error: 'Invalid credentials' });
    });
};

exports.getSetup = (req, res) => {
    db.get('SELECT count(*) as count FROM users', [], (err, row) => {
        if (!err && row.count === 0) {
            return res.render('auth/setup', { title: 'Setup - StreamFire', error: null });
        }
        res.redirect('/login');
    });
};

exports.postSetup = async (req, res) => {
    const { username, password, confirmPassword } = req.body;

    if (password !== confirmPassword) {
        return res.render('auth/setup', { title: 'Setup', error: 'Passwords do not match' });
    }

    db.get('SELECT count(*) as count FROM users', [], async (err, row) => {
        if (err) return res.render('auth/setup', { title: 'Setup', error: 'Database error' });
        if (row.count > 0) return res.redirect('/login');

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
                if (err) return res.render('auth/setup', { title: 'Setup', error: 'Failed to create user' });
                res.redirect('/login');
            });
        } catch (error) {
            res.render('auth/setup', { title: 'Setup', error: 'Error processing request' });
        }
    });
};

exports.logout = (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
};
