/*
 * ============================================================================
 *  Unified database module  (FIXED)
 * ============================================================================
 *
 *  ROOT-CAUSE FIX for the /login <-> /setup-account redirect loop.
 *
 *  Previously this file created a SEPARATE SQLite database
 *  (./db/streamfire.db) with a legacy "StreamFire" schema:
 *    - videos.filename / videos.thumbnail  (INTEGER ids)
 *    - a minimal users table (id INTEGER AUTOINCREMENT, avatar, ...)
 *
 *  But the ENTIRE rest of the application code expects the OTHER schema,
 *  defined in db/database.js (./db/autolivestream.db):
 *    - videos.filepath / videos.thumbnail_path  (TEXT uuid ids)
 *    - a full users table (id TEXT, avatar_path, user_role, status,
 *      disk_limit, welcome_shown, updated_at, youtube_*, ...)
 *
 *  This "split-brain" caused the login loop:
 *    - middleware checkSetup counted users in streamfire.db  -> 0 users
 *    - User.create / findByUsername wrote/read autolivestream.db
 *    - checkIfUsersExist was imported from THIS module where it did not
 *      exist (undefined) -> threw -> /setup-account redirected to /login
 *      while checkSetup redirected /login -> /setup-account. Infinite loop.
 *
 *  FIX: delegate to the single canonical database (db/database.js). Every
 *  existing consumer keeps working unchanged because we export the raw
 *  sqlite3 handle (identical db.run / db.get / db.all / db.serialize calling
 *  convention as the old wrapper) plus a `.db` self-reference and
 *  `checkIfUsersExist`, which a few routes/middleware import from here.
 * ============================================================================
 */

const core = require('../../db/database');

// db/database.js auto-initializes its tables on require, so simply requiring
// it above guarantees the schema exists. `core.db` is the raw sqlite3 handle.
const db = core.db;

// Some routes use `require('../models/database').db` (raw handle).
db.db = db;
// auth.js / authRoutes.js use `require('../models/database').checkIfUsersExist`.
db.checkIfUsersExist = core.checkIfUsersExist;
db.initializeDatabase = core.initializeDatabase;

module.exports = db;
