/* JSON-file store: meetings, suggestions, audit log, sync cursor. Atomic writes; swap for a DB
   later without touching the agent or the routes. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'store.json');
const EMPTY = () => ({ v: 1, meetings: [], suggestions: [], audit: [], sync: { lastGranolaSync: null } });
let db = null;

function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = EMPTY(); }
  db = Object.assign(EMPTY(), db);
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

function audit(by, action, target, detail) {
  load().audit.unshift({ at: new Date().toISOString(), by: by || 'system', action, target, detail: detail || null });
  db.audit = db.audit.slice(0, 2000);
}

module.exports = { load, save, id, audit, FILE };
