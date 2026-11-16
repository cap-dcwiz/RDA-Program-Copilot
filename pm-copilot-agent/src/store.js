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
  migrate(db);
  return db;
}

/* One-off data fixes, each applied once and recorded in db.migrations.

   reopen-dry-run-2026-11-16: six suggestions were approved on 16 Nov while JIRA_DRY_RUN was still
   true, so nothing reached Jira (checked against the tickets). Put them back in the pending list
   so they can be approved for real. Dry-run approvals from 11 Nov stay approved: those were
   written to Jira by hand at the time, and reopening them would post duplicates. */
function migrate(d) {
  d.migrations = d.migrations || {};
  if (!d.migrations['reopen-dry-run-2026-11-16']) {
    const hit = d.suggestions.filter(s => s.status === 'approved' && s.jira && s.jira.dryRun === true && String(s.decidedAt || '') >= '2026-11-16');
    for (const s of hit) {
      d.audit.unshift({ at: new Date().toISOString(), by: 'system', action: 'reopen', target: s.id, detail: `dry-run approval by ${s.decidedBy || '?'} at ${s.decidedAt} returned to pending: ${s.title}` });
      s.status = 'pending';
      for (const k of ['jira', 'decidedBy', 'decidedAt']) delete s[k];
    }
    d.migrations['reopen-dry-run-2026-11-16'] = { at: new Date().toISOString(), reopened: hit.map(s => s.id) };
    if (hit.length) { db = d; save(); }
  }
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
