/* Users, roles and sessions.
   · Passwords: scrypt with a per-user salt. Never stored or returned in clear.
   · Sessions: random bearer tokens, stored as SHA-256 hashes, 7-day sliding expiry.
   · Files (git-ignored): data/users.json, data/roles.json, data/sessions.json */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const P = require('./permissions');

const F = { users: path.join(DATA_DIR, 'users.json'), roles: path.join(DATA_DIR, 'roles.json'), sessions: path.join(DATA_DIR, 'sessions.json') };
const SESSION_DAYS = 7;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const err = (status, message) => Object.assign(new Error(message), { status });

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, h] = String(stored || '').split('$');
  if (!salt || !h) return false;
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const validPassword = (pw) => typeof pw === 'string' && pw.length >= 8;

/* ---------- roles ---------- */
function roles() {
  let r = read(F.roles, null);
  if (!r) { r = P.DEFAULT_ROLES; write(F.roles, r); }
  const admin = r.find(x => x.id === 'admin');
  if (!admin) r.unshift(P.DEFAULT_ROLES[0]); else Object.assign(admin, { locked: true, pages: P.PAGES.map(p => p.id), actions: P.ACTIONS.map(a => a.id), projects: ['*'] });
  return r;
}
function saveRoles(next) {
  const pages = new Set(P.PAGES.map(p => p.id)), actions = new Set(P.ACTIONS.map(a => a.id)), projects = new Set(P.PROJECTS.map(p => p.id).concat('*'));
  const seen = new Set();
  const clean = next.map(r => {
    const id = String(r.id || r.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id || seen.has(id)) throw err(400, `Role names must be unique and not empty (${r.name || r.id})`);
    seen.add(id);
    const name = String(r.name || id).trim().slice(0, 40);
    if (id === 'admin') return P.DEFAULT_ROLES[0];
    return { id, name, pages: (r.pages || []).filter(x => pages.has(x)), actions: (r.actions || []).filter(x => actions.has(x)),
      projects: (r.projects || []).filter(x => projects.has(x)) };
  });
  if (!clean.find(r => r.id === 'admin')) clean.unshift(P.DEFAULT_ROLES[0]);
  // A deleted role is removed from every user that had it.
  const ids = new Set(clean.map(r => r.id));
  const us = users(); us.forEach(u => { u.roles = (u.roles || []).filter(x => ids.has(x)); }); write(F.users, us);
  write(F.roles, clean);
  return clean;
}

/* ---------- users ---------- */
const users = () => read(F.users, []);
const publicUser = (u, rs = roles()) => ({ id: u.id, username: u.username, displayName: u.displayName || u.username, email: u.email || null,
  roles: u.roles || [], disabled: !!u.disabled, mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  perms: P.effective(rs, u.roles) });

/* Accounts created by an admin start with a temporary password the person must change at first sign-in. */
function createUser({ username, password, displayName, email, roles: r, mustChangePassword = true }) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{2,64}$/.test(username)) throw err(400, 'Username: 2–64 characters, letters, digits, . _ @ -');
  if (!validPassword(password)) throw err(400, 'Password must be at least 8 characters');
  const list = users();
  if (list.find(u => u.username === username)) throw err(409, `User ${username} already exists`);
  const ids = new Set(roles().map(x => x.id));
  const u = { id: 'usr_' + crypto.randomBytes(5).toString('hex'), username, displayName: (displayName || '').trim() || username, email: (email || '').trim() || null,
    roles: (r || []).filter(x => ids.has(x)), passwordHash: hashPassword(password), mustChangePassword: !!mustChangePassword, createdAt: new Date().toISOString() };
  list.push(u); write(F.users, list);
  return publicUser(u);
}
function updateUser(id, patch, actorId) {
  const list = users(); const u = list.find(x => x.id === id); if (!u) throw err(404, 'User not found');
  if ('roles' in patch) {
    const ids = new Set(roles().map(x => x.id));
    const next = (patch.roles || []).filter(x => ids.has(x));
    if (id === actorId && !P.effective(roles(), next).pages.includes('users')) throw err(400, 'You cannot remove your own access to Users & Roles');
    u.roles = next;
  }
  if ('displayName' in patch) u.displayName = String(patch.displayName || '').trim() || u.username;
  if ('email' in patch) u.email = String(patch.email || '').trim() || null;
  if ('disabled' in patch) { if (id === actorId) throw err(400, 'You cannot disable yourself'); u.disabled = !!patch.disabled; }
  ensureAnAdmin(list);
  write(F.users, list);
  if (u.disabled) revokeSessions(u.id);
  return publicUser(u);
}
function setPassword(id, password) {
  if (!validPassword(password)) throw err(400, 'Password must be at least 8 characters');
  const list = users(); const u = list.find(x => x.id === id); if (!u) throw err(404, 'User not found');
  u.passwordHash = hashPassword(password); u.passwordChangedAt = new Date().toISOString(); u.mustChangePassword = true;
  write(F.users, list); revokeSessions(u.id);
}
/* The signed-in person changes their own password: needs the current one; signs out every other session. */
function changeOwnPassword(id, current, password) {
  const list = users(); const u = list.find(x => x.id === id); if (!u) throw err(404, 'User not found');
  if (!checkPassword(String(current || ''), u.passwordHash)) throw err(400, 'Current password is not right');
  if (!validPassword(password)) throw err(400, 'Password must be at least 8 characters');
  if (checkPassword(password, u.passwordHash)) throw err(400, 'Choose a password different from the current one');
  u.passwordHash = hashPassword(password); u.passwordChangedAt = new Date().toISOString(); u.mustChangePassword = false;
  write(F.users, list); revokeSessions(u.id);
  return issueSession(u);
}
function deleteUser(id, actorId) {
  if (id === actorId) throw err(400, 'You cannot delete yourself');
  const list = users().filter(x => x.id !== id);
  ensureAnAdmin(list); write(F.users, list); revokeSessions(id);
}
function ensureAnAdmin(list) {
  const rs = roles();
  if (!list.some(u => !u.disabled && P.effective(rs, u.roles).pages.includes('users'))) throw err(400, 'At least one active user must keep access to Users & Roles');
}

/* ---------- sessions ---------- */
function login(username, password) {
  const list = users();
  const u = list.find(x => x.username === String(username || '').trim().toLowerCase());
  if (!u || u.disabled || !checkPassword(String(password || ''), u.passwordHash)) throw err(401, 'Wrong username or password');
  u.lastLoginAt = new Date().toISOString(); write(F.users, list);
  return issueSession(u);
}
function issueSession(u) {
  const token = 'pmc_' + crypto.randomBytes(24).toString('base64url');
  const s = read(F.sessions, []).filter(x => new Date(x.expiresAt) > new Date());
  s.push({ hash: sha(token), userId: u.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  write(F.sessions, s);
  return { token, user: publicUser(u) };
}
function logout(token) { if (token) write(F.sessions, read(F.sessions, []).filter(x => x.hash !== sha(token))); }
function revokeSessions(userId) { write(F.sessions, read(F.sessions, []).filter(x => x.userId !== userId)); }

function whoIs(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const h = sha(m[1].trim());
  const s = read(F.sessions, []).find(x => x.hash === h && new Date(x.expiresAt) > new Date());
  if (!s) return null;
  const u = users().find(x => x.id === s.userId && !x.disabled);
  if (!u) return null;
  const pu = publicUser(u);
  return { ...pu, name: pu.displayName, token: m[1].trim() };
}

/* First start (no users yet). Admin rights go to named personal accounts, not a shared login:
   SEED_ADMINS=selena.zhang@rda.ai,wenqian.yuan@rda.ai creates one Super Admin per address with a
   random temporary password (changed at first sign-in). Without SEED_ADMINS a single "admin"
   account is created instead, for setting up the named accounts and then disabling. */
function bootstrap() {
  roles();
  if (users().length) return null;
  const seeds = String(process.env.SEED_ADMINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const created = [];
  if (seeds.length) {
    for (const email of seeds) {
      const pw = crypto.randomBytes(9).toString('base64url');
      const name = email.split('@')[0].split(/[._-]/).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      createUser({ username: email, password: pw, displayName: name, email, roles: ['admin'] });
      created.push([email, pw]);
    }
  } else {
    const fixed = process.env.ADMIN_PASSWORD && validPassword(process.env.ADMIN_PASSWORD);
    const pw = fixed ? process.env.ADMIN_PASSWORD : crypto.randomBytes(9).toString('base64url');
    createUser({ username: 'admin', password: pw, displayName: 'Admin', roles: ['admin'] });
    created.push(['admin', fixed ? '(ADMIN_PASSWORD from .env)' : pw]);
  }
  const file = path.join(DATA_DIR, 'initial-passwords.txt');
  fs.writeFileSync(file, `Temporary passwords, created ${new Date().toISOString()}.\nEach person must change theirs at first sign-in. Hand them out privately, then delete this file.\n\n` +
    created.map(([u, p]) => `${u}\t${p}`).join('\n') + '\n', { mode: 0o600 });
  return { created, file };
}

module.exports = { whoIs, login, logout, changeOwnPassword, roles, saveRoles, users: () => users().map(u => publicUser(u)), createUser, updateUser, setPassword, deleteUser, bootstrap };
