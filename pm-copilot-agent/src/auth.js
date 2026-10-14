/* Bearer-token users with roles. Tokens are stored only as SHA-256 hashes in data/users.json.
   admin  → can sync, import, edit, approve and reject (writes to Jira)
   viewer → can read meetings and suggestions */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'users.json');
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const users = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };

function whoIs(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const h = hash(m[1].trim());
  const u = users().find(x => x.tokenHash === h && !x.disabled);
  return u ? { name: u.name, email: u.email || null, role: u.role } : null;
}

function addUser({ name, email, role }) {
  if (!['admin', 'viewer'].includes(role)) throw new Error('role must be admin or viewer');
  const list = users().filter(u => u.name.toLowerCase() !== name.toLowerCase());
  const token = 'pmc_' + crypto.randomBytes(24).toString('base64url');
  list.push({ name, email: email || null, role, tokenHash: hash(token), createdAt: new Date().toISOString() });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  return token;
}

module.exports = { whoIs, addUser, users };
