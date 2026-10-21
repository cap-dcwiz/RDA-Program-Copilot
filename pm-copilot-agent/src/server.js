/* PM Copilot agent HTTP API + dashboard host. No framework; every route below is the whole surface.

   Public
   GET  /                                   the dashboard (docs/DayOne_NTPE_Program_Kanban_EN.html)
   GET  /api/health                         config status (no secrets)
   POST /api/login {username,password}      → {token, user}
   Signed in
   POST /api/logout
   GET  /api/me                             user + effective permissions
   POST /api/me/password {current,password} change your own password (required after an admin sets one)
   GET  /api/portfolio                      portfolio data, filtered to the role's projects
   GET  /api/suggestions?status=            page: todo      (only projects the user may see)
   GET  /api/meetings, /api/meetings/:id    page: history
   GET  /api/audit                          page: history
   POST /api/suggestions/:id/approve|reject|edit     action: approve
   POST /api/sync, /api/meetings/import, /api/meetings/:id/reanalyse   action: ingest
   GET  /api/plan/:project                  plan edits (Gantt) for a project the user may see
   POST /api/plan/:project/tasks/:id        {fields, before}   action: edit_plan
   POST /api/plan/:project/tasks/:id/reset                     action: edit_plan
   POST /api/plan/:project/milestone        {date, name}       action: edit_plan
   POST /api/jira/sync                      run the Jira read sync now                    action: edit_plan
   Users & Roles (page: users)
   GET  /api/admin/catalog                  pages, actions, projects that roles can grant
   GET  /api/admin/users | POST /api/admin/users
   POST /api/admin/users/:id                {roles, displayName, email, disabled}
   POST /api/admin/users/:id/password       {password}
   POST /api/admin/users/:id/delete
   GET  /api/admin/roles | POST /api/admin/roles   {roles:[...]} replaces the matrix */
const fs = require('fs');
const path = require('path');
const http = require('http');
const cfg = require('./config');
const store = require('./store');
const agent = require('./agent');
const granola = require('./granola');
const jira = require('./jira');
const auth = require('./auth');
const P = require('./permissions');
const plan = require('./plan');
const jirasync = require('./jirasync');

const DASHBOARD = path.join(cfg.ROOT, '..', 'docs', 'DayOne_NTPE_Program_Kanban_EN.html');
const err = (status, message) => Object.assign(new Error(message), { status });

function cors(req, res) {
  const origin = req.headers.origin;
  const any = cfg.allowedOrigins.includes('*');
  if (any || (origin && cfg.allowedOrigins.includes(origin))) res.setHeader('Access-Control-Allow-Origin', any ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) reject(err(413, 'Body too large')); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(err(400, 'Body must be JSON')); } });
});
const signedIn = (u) => { if (!u) throw err(401, 'Please sign in'); };
const page = (u, id) => { signedIn(u); if (!u.perms.pages.includes(id)) throw err(403, 'Your role does not include this page'); };
const action = (u, id) => { signedIn(u); if (!u.perms.actions.includes(id)) throw err(403, 'Your role does not allow this'); };
const seesMeeting = (u, m) => u.perms.projects.includes('*') || (m.projects || []).some(p => P.canSeeProject(u.perms, p));

/* Simple login throttle: 8 failures per username+IP per 15 minutes. */
const fails = new Map();
function throttle(key) {
  const now = Date.now(), f = (fails.get(key) || []).filter(t => now - t < 15 * 60000);
  fails.set(key, f);
  if (f.length >= 8) throw err(429, 'Too many failed sign-ins. Try again in 15 minutes.');
  return () => { f.push(now); fails.set(key, f); };
}

const meetingCard = (m, db, u) => {
  const s = db.suggestions.filter(x => x.meetingId === m.id && P.canSeeProject(u.perms, x.project));
  return { id: m.id, source: m.source, title: m.title, date: m.date, url: m.url, attendees: m.attendees, summary: m.summary || [],
    projects: (m.projects || []).filter(p => P.canSeeProject(u.perms, p)), status: m.status, error: m.error, ingestedAt: m.ingestedAt, jiraContext: m.jiraContext,
    counts: { pending: s.filter(x => x.status === 'pending').length, approved: s.filter(x => x.status === 'approved').length, rejected: s.filter(x => x.status === 'rejected').length } };
};

async function route(req, res, user) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  let m;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(DASHBOARD).pipe(res);
  }
  if (req.method === 'GET' && p === '/api/health') {
    const db = store.load();
    return send(res, 200, { ok: true, model: cfg.anthropic.model, claude: !!cfg.anthropic.apiKey, granola: granola.configured(),
      jiraCredentials: jira.hasCreds(), jiraDryRun: jira.dryRun(), lastGranolaSync: db.sync.lastGranolaSync,
      lastJiraSync: db.sync.lastJiraSync ? { at: db.sync.lastJiraSync.at, ok: db.sync.lastJiraSync.ok, error: db.sync.lastJiraSync.error || null } : null,
      nextJiraSync: db.sync.nextJiraSync || null });
  }
  if (req.method === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    const fail = throttle(`${String(body.username || '').toLowerCase()}|${req.socket.remoteAddress}`);
    try { const r = auth.login(body.username, body.password); store.audit(r.user.displayName, 'login', r.user.id); store.save(); return send(res, 200, r); }
    catch (e) { fail(); throw e; }
  }

  signedIn(user);
  const db = store.load();
  if (req.method === 'POST' && p === '/api/logout') { auth.logout(user.token); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && p === '/api/me') { const { token, ...u } = user; return send(res, 200, u); }
  if (req.method === 'POST' && p === '/api/me/password') {
    const body = await readBody(req);
    const r = auth.changeOwnPassword(user.id, body.current, body.password);
    store.audit(user.name, 'password-change', user.id); store.save();
    return send(res, 200, r);
  }
  if (user.mustChangePassword) throw err(403, 'Set a new password first');

  if (req.method === 'GET' && p === '/api/portfolio') {
    // Each role receives only its projects. Without the Portfolio page you get the project list
    // (for the project switcher) and nothing else; portfolio-wide narrative needs every project.
    const all = jirasync.readPortfolio();
    const sees = (id) => P.canSeeProject(user.perms, id);
    const projects = all.projects.filter(x => sees(x.id));
    if (!user.perms.pages.includes('portfolio')) {
      return send(res, 200, { asOf: all.asOf, projects: projects.map(x => ({ id: x.id, name: x.name, client: x.client, kind: x.kind, health: x.health, drill: x.drill,
        phase: x.phase, headline: x.headline, stages: x.stages, tickets: [], risks: [], next: [] })), tickets: [], asks: [], events: [], text: {} });
    }
    const wide = user.perms.projects.includes('*');
    return send(res, 200, { asOf: all.asOf, syncedAt: all.syncedAt || null, projects, tickets: all.tickets.filter(t => sees(t.proj)),
      asks: all.asks.filter(a => wide || sees(a.proj)), events: all.events.filter(e => wide || sees(e.proj)), text: wide ? all.text : {} });
  }

  if (req.method === 'GET' && p === '/api/suggestions') {
    page(user, 'todo');
    const st = url.searchParams.get('status');
    const list = db.suggestions.filter(s => (!st || s.status === st) && P.canSeeProject(user.perms, s.project)).map(s => {
      const mt = db.meetings.find(x => x.id === s.meetingId) || {};
      return { ...s, meeting: { id: mt.id, title: mt.title, date: mt.date, url: mt.url } };
    }).sort((a, b) => String(b.meeting.date).localeCompare(String(a.meeting.date)));
    return send(res, 200, { suggestions: list, jiraDryRun: jira.dryRun() });
  }
  if (req.method === 'GET' && p === '/api/meetings') { page(user, 'history'); return send(res, 200, { meetings: db.meetings.filter(x => seesMeeting(user, x)).map(x => meetingCard(x, db, user)) }); }
  if (req.method === 'GET' && (m = p.match(/^\/api\/meetings\/([\w-]+)$/))) {
    page(user, 'history');
    const mt = db.meetings.find(x => x.id === m[1]); if (!mt || !seesMeeting(user, mt)) throw err(404, 'Meeting not found');
    // Full notes cover every project discussed, so only users who see all projects get them.
    const full = user.perms.projects.includes('*');
    return send(res, 200, { ...meetingCard(mt, db, user), notesText: full ? mt.notesText : null,
      suggestions: db.suggestions.filter(s => s.meetingId === mt.id && P.canSeeProject(user.perms, s.project)) });
  }
  if (req.method === 'GET' && p === '/api/audit') {
    page(user, 'history');
    const visible = new Set(db.suggestions.filter(s => P.canSeeProject(user.perms, s.project)).map(s => s.id));
    const all = user.perms.projects.includes('*');
    return send(res, 200, { audit: db.audit.filter(a => all || visible.has(a.target)).slice(0, 200) });
  }

  if (req.method === 'GET' && (m = p.match(/^\/api\/plan\/([a-z0-9-]+)$/))) {
    if (!P.canSeeProject(user.perms, m[1])) throw err(404, 'Project not found');
    const out = plan.get(m[1]);
    if (m[1] === 'dayone') out.jira = jirasync.readDayone();
    return send(res, 200, out);
  }
  if (req.method === 'GET' && p === '/api/admin/catalog') { page(user, 'users'); return send(res, 200, { pages: P.PAGES, actions: P.ACTIONS, projects: P.PROJECTS }); }
  if (req.method === 'GET' && p === '/api/admin/users') { page(user, 'users'); return send(res, 200, { users: auth.users() }); }
  if (req.method === 'GET' && p === '/api/admin/roles') { page(user, 'users'); return send(res, 200, { roles: auth.roles() }); }

  if (req.method !== 'POST') throw err(404, 'Not found');
  const body = await readBody(req);

  if (p.startsWith('/api/admin/')) {
    page(user, 'users');
    const log = (a, t, d) => { store.audit(user.name, a, t, d); store.save(); };
    if (p === '/api/admin/users') { const u = auth.createUser(body); log('user-create', u.id, `${u.username} · ${u.roles.join(',')}`); return send(res, 200, u); }
    if (p === '/api/admin/roles') { const r = auth.saveRoles(body.roles || []); log('roles-save', 'roles', r.map(x => x.name).join(', ')); return send(res, 200, { roles: r }); }
    if ((m = p.match(/^\/api\/admin\/users\/([\w-]+)\/password$/))) { auth.setPassword(m[1], body.password); log('user-password', m[1]); return send(res, 200, { ok: true }); }
    if ((m = p.match(/^\/api\/admin\/users\/([\w-]+)\/delete$/))) { auth.deleteUser(m[1], user.id); log('user-delete', m[1]); return send(res, 200, { ok: true }); }
    if ((m = p.match(/^\/api\/admin\/users\/([\w-]+)$/))) { const u = auth.updateUser(m[1], body, user.id); log('user-update', u.id, `${u.username} · ${u.roles.join(',')}`); return send(res, 200, u); }
    throw err(404, 'Not found');
  }

  if ((m = p.match(/^\/api\/plan\/([a-z0-9-]+)\/(tasks\/([\w-]+)(\/reset)?|milestone)$/))) {
    action(user, 'edit_plan');
    const project = m[1];
    if (!P.canSeeProject(user.perms, project)) throw err(404, 'Project not found');
    const log = (target, detail) => { store.audit(user.name, 'plan-edit', `${project}:${target}`, detail); store.save(); };
    if (m[2] === 'milestone') { const ms = plan.editMilestone(project, body, user.name); log('milestone', JSON.stringify(ms)); return send(res, 200, { milestone: ms }); }
    if (m[4]) { plan.resetTask(project, m[3], user.name); log(m[3], 'reset to original'); return send(res, 200, plan.get(project)); }
    // Status, owner and target date of a task fed by Jira are owned by Jira; change them there.
    const jd = project === 'dayone' ? jirasync.readDayone() : null;
    const linked = jd && (jd.tasks[m[3]] || (jd.extra || []).find(x => x.key === m[3]));
    if (linked) { const owned = ['status', 'owner', 'due'].filter(k => k in (body.fields || {})); if (owned.length) throw err(400, `${owned.join(', ')} come from Jira ${linked.key}; change them in Jira`); }
    const r = plan.editTask(project, m[3], body.fields, body.before, user.name);
    log(m[3], Object.keys(body.fields || {}).join(', '));
    return send(res, 200, r);
  }
  if (p === '/api/jira/sync') { action(user, 'edit_plan'); return send(res, 200, await jirasync.runAll(user.name)); }
  if (p === '/api/sync') { action(user, 'ingest'); return send(res, 200, await agent.syncGranola(user.name)); }
  if (p === '/api/meetings/import') {
    action(user, 'ingest');
    if (!body.text || body.text.trim().length < 40) throw err(400, 'Paste the meeting notes in "text"');
    const r = await agent.ingest({ source: 'manual', sourceId: null, title: body.title || 'Imported meeting', date: body.date || new Date().toISOString(),
      attendees: body.attendees || [], notesText: body.text, url: null }, user.name);
    return send(res, 200, meetingCard(r.meeting, store.load(), user));
  }
  if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/reanalyse$/))) {
    action(user, 'ingest');
    const mt = db.meetings.find(x => x.id === m[1]); if (!mt) throw err(404, 'Meeting not found');
    const r = await agent.ingest({ ...mt, updatedAt: `re-${Date.now()}` }, user.name);
    return send(res, 200, meetingCard(r.meeting, store.load(), user));
  }
  if ((m = p.match(/^\/api\/suggestions\/([\w-]+)\/(approve|reject|edit)$/))) {
    action(user, 'approve');
    const s = db.suggestions.find(x => x.id === m[1]);
    if (!s || !P.canSeeProject(user.perms, s.project)) throw err(404, 'Suggestion not found');
    if (m[2] === 'edit') { if (body.project && !P.canSeeProject(user.perms, body.project)) throw err(403, 'You cannot move a to-do to a project you cannot see'); return send(res, 200, agent.edit(m[1], body, user)); }
    return send(res, 200, await agent.decide(m[1], m[2], user, body));
  }
  throw err(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res, auth.whoIs(req)); }
  catch (e) { if (!e.status) console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.message }); }
});

if (require.main === module) {
  const first = auth.bootstrap();
  server.listen(cfg.port, () => {
    console.log(`PM Copilot agent on :${cfg.port} · dashboard at / · model ${cfg.anthropic.model} · Granola ${granola.configured() ? 'on' : 'off'} · Jira ${jira.dryRun() ? 'dry-run' : 'LIVE writes'}`);
    if (first) console.log(`\nFirst start: created ${first.created.map(c => c[0]).join(', ')}.\nTemporary passwords are in ${first.file} — hand them out privately, then delete the file.\n`);
    const nj = jirasync.schedule();
    console.log(nj ? `Jira sync: next run ${nj.toISOString()} (Mon–Fri 24:00 SGT)${jira.hasCreds() ? '' : ' — needs JIRA_EMAIL and JIRA_API_TOKEN'}` : 'Jira sync: off');
    if (granola.configured() && cfg.granola.syncMinutes > 0) {
      const tick = () => agent.syncGranola('scheduler').then(r => r.notes && console.log('[sync]', r)).catch(e => console.warn('[sync]', e.message));
      setTimeout(tick, 3000); setInterval(tick, cfg.granola.syncMinutes * 60000);
    }
  });
}
module.exports = { server };
