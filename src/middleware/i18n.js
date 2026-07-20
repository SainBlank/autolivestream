const fs = require('fs');
const path = require('path');

const locales = {
    id: JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/id.json'), 'utf8')),
    en: JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/en.json'), 'utf8'))
};

function i18n(req, res, next) {
    let lang = req.query.lang || (req.session && req.session.language) || 'id';
    if (!locales[lang]) lang = 'id';
    if (req.session) {
        req.session.language = lang;
    }

    if (req.user && req.user.language && !req.query.lang) {
    }

    res.locals.lang = lang;
    res.locals.t = locales[lang];
    next();
}

module.exports = i18n;
