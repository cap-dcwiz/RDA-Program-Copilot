"use strict";
/* Authorization. Authentication lives in productcenter.js.
   · Who you are: the AI-factory Product Center verifies its own JWT. No password, no user record
     and no session is stored here, so there is nothing to keep in sync and nothing to leak.
   · What you may do: this dashboard's own roles (pages / actions / projects), reached by mapping
     Product Center roles — or a named person — onto them.
   · Files (git-ignored): data/roles.json (the role matrix), data/access.json (the mapping). */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const P = require('./permissions');
const pc = require('./productcenter');

const F = { roles: path.join(DATA_DIR, 'roles.json'), access: path.join(DATA_DIR, 'access.json') };
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const err = (status, message) => Object.assign(new Error(message), { status });

/* ---------- roles (this dashboard's own matrix) ---------- */
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
  // A deleted role disappears from the mapping too, so it cannot grant anything by accident.
  const ids = new Set(clean.map(r => r.id));
  const a = access();
  for (const k of Object.keys(a.byRole)) a.byRole[k] = (a.byRole[k] || []).filter(x => ids.has(x));
  for (const k of Object.keys(a.byUser)) {
    a.byUser[k] = (a.byUser[k] || []).filter(x => ids.has(x));
    if (!a.byUser[k].length) delete a.byUser[k];
  }
  write(F.roles, clean); write(F.access, a);
  return clean;
}

/* ---------- access mapping (Product Center identity -> this dashboard's roles) ---------- */
function access() {
  let a = read(F.access, null);
  if (!a) { a = JSON.parse(JSON.stringify(P.DEFAULT_ACCESS)); write(F.access, a); }
  return { byRole: a.byRole || {}, byUser: a.byUser || {} };
}

const lower = (s) => String(s || '').trim().toLowerCase();

function saveAccess(next) {
  const ids = new Set(roles().map(r => r.id));
  const clean = { byRole: {}, byUser: {} };
  for (const [k, v] of Object.entries((next && next.byRole) || {})) {
    const role = lower(k); if (!role) continue;
    clean.byRole[role] = [...new Set(v || [])].filter(x => ids.has(x));
  }
  for (const [k, v] of Object.entries((next && next.byUser) || {})) {
    const who = lower(k); if (!who) continue;
    const list = [...new Set(v || [])].filter(x => ids.has(x));
    if (list.length) clean.byUser[who] = list;
  }
  // Locking everyone out of this page would leave no way back in except editing the file on the
  // server, so refuse it the same way the old user list refused removing the last admin.
  const rs = roles();
  const anyAdmin = [...Object.values(clean.byRole), ...Object.values(clean.byUser)]
    .some(list => P.effective(rs, list).pages.includes('users'));
  if (!anyAdmin) throw err(400, 'At least one Product Center role or person must keep access to Roles & Access');
  write(F.access, clean);
  return clean;
}

/* ---------- who is calling ---------- */
const bearer = (req) => { const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : null; };

/** Shape the rest of the server expects. `source` says where the identity came from. */
function principal(identity, token) {
  const rs = roles();
  const roleIds = P.rolesFor(access(), identity, rs);
  return {
    id: identity.username, username: identity.username, name: identity.displayName || identity.username,
    displayName: identity.displayName || identity.username, email: identity.email,
    pcRoles: identity.pcRoles, pcRoleNames: identity.pcRoleNames || null, roles: roleIds, perms: P.effective(rs, roleIds),
    source: 'product-center', token,
  };
}

/** Verify the request's bearer token with Product Center. null = not signed in. */
async function whoIs(req) {
  const token = bearer(req);
  if (!token) return null;
  const identity = await pc.verify(token);
  return identity ? principal(identity, token) : null;
}

/** Sign in with Product Center credentials and return its token plus what it grants here. */
async function login(username, password) {
  const { token, user } = await pc.login(username, password);
  const me = principal(user, token);
  if (!me.roles.length) {
    // Signing in successfully and then seeing an empty dashboard is the worst of both worlds.
    throw err(403, `Signed in as ${me.displayName}, but no access to this dashboard has been granted yet. Ask an admin to add you on Roles & Access.`);
  }
  const { token: _t, ...safe } = me;
  return { token, user: safe };
}

/** Sign out. The JWT belongs to Product Center, so all we can do is stop trusting our cache. */
const logout = (token) => pc.forget(token);

module.exports = { whoIs, login, logout, roles, saveRoles, access, saveAccess, signInWith: () => require('./config').productCenter };
