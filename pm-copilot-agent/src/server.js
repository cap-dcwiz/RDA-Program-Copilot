/* PM Copilot agent HTTP API. No framework; every route below is the whole surface.

   GET  /api/health                       public  — config status (no secrets)
   GET  /api/me                           user    — who the token belongs to
   GET  /api/meetings                     user    — meeting history (newest first)
   GET  /api/meetings/:id                 user    — one meeting, incl. notes and its suggestions
   GET  /api/suggestions?status=pending   user    — the to-do list
   GET  /api/audit                        user    — who approved/rejected what
   POST /api/sync                         admin   — pull new Granola notes now
   POST /api/meetings/import              admin   — analyse pasted minutes {title, date, text}
   POST /api/meetings/:id/reanalyse       admin   — run Claude again on a stored meeting
   POST /api/suggestions/:id/edit         admin   — fix a suggestion before approving
   POST /api/suggestions/:id/approve      admin   — write it to Jira (or dry-run)
   POST /api/suggestions/:id/reject       admin   — {reason} */
const http = require('http');
const cfg = require('./config');
const store = require('./store');
const agent = require('./agent');
const granola = require('./granola');
const jira = require('./jira');
const { whoIs } = require('./auth');

const err = (status, message) => Object.assign(new Error(message), { status });

function cors(req, res) {
  const origin = req.headers.origin;
  const ok = cfg.allowedOrigins.includes('*') || (origin && cfg.allowedOrigins.includes(origin));
  if (ok) res.setHeader('Access-Control-Allow-Origin', cfg.allowedOrigins.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) reject(err(413, 'Body too large')); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(err(400, 'Body must be JSON')); } });
});
const need = (user, role) => { if (!user) throw err(401, 'Sign in with a PM Copilot token'); if (role === 'admin' && user.role !== 'admin') throw err(403, 'Only an admin can do this'); };

const meetingCard = (m, db) => {
  const s = db.suggestions.filter(x => x.meetingId === m.id);
  return { id: m.id, source: m.source, title: m.title, date: m.date, url: m.url, attendees: m.attendees, summary: m.summary || [],
    projects: m.projects || [], status: m.status, error: m.error, ingestedAt: m.ingestedAt, jiraContext: m.jiraContext,
    counts: { pending: s.filter(x => x.status === 'pending').length, approved: s.filter(x => x.status === 'approved').length, rejected: s.filter(x => x.status === 'rejected').length } };
};

async function route(req, res, user) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '');
  const db = store.load();
  let m;

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, model: cfg.anthropic.model,
    claude: !!cfg.anthropic.apiKey, granola: granola.configured(), jiraCredentials: jira.hasCreds(), jiraDryRun: jira.dryRun(),
    lastGranolaSync: db.sync.lastGranolaSync, meetings: db.meetings.length, pending: db.suggestions.filter(s => s.status === 'pending').length });

  need(user);
  if (req.method === 'GET' && p === '/api/me') return send(res, 200, user);
  if (req.method === 'GET' && p === '/api/meetings') return send(res, 200, { meetings: db.meetings.map(x => meetingCard(x, db)) });
  if (req.method === 'GET' && (m = p.match(/^\/api\/meetings\/([\w-]+)$/))) {
    const mt = db.meetings.find(x => x.id === m[1]); if (!mt) throw err(404, 'Meeting not found');
    return send(res, 200, { ...meetingCard(mt, db), notesText: mt.notesText, suggestions: db.suggestions.filter(s => s.meetingId === mt.id) });
  }
  if (req.method === 'GET' && p === '/api/suggestions') {
    const st = url.searchParams.get('status');
    const list = db.suggestions.filter(s => !st || s.status === st).map(s => {
      const mt = db.meetings.find(x => x.id === s.meetingId) || {};
      return { ...s, meeting: { id: mt.id, title: mt.title, date: mt.date, url: mt.url } };
    }).sort((a, b) => String(b.meeting.date).localeCompare(String(a.meeting.date)));
    return send(res, 200, { suggestions: list, jiraDryRun: jira.dryRun() });
  }
  if (req.method === 'GET' && p === '/api/audit') return send(res, 200, { audit: db.audit.slice(0, 200) });

  if (req.method !== 'POST') throw err(404, 'Not found');
  need(user, 'admin');
  const body = await readBody(req);
  if (p === '/api/sync') return send(res, 200, await agent.syncGranola(user.name));
  if (p === '/api/meetings/import') {
    if (!body.text || body.text.trim().length < 40) throw err(400, 'Paste the meeting notes in "text"');
    const r = await agent.ingest({ source: 'manual', sourceId: null, title: body.title || 'Imported meeting', date: body.date || new Date().toISOString(),
      attendees: body.attendees || [], notesText: body.text, url: null }, user.name);
    return send(res, 200, meetingCard(r.meeting, store.load()));
  }
  if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/reanalyse$/))) {
    const mt = db.meetings.find(x => x.id === m[1]); if (!mt) throw err(404, 'Meeting not found');
    const r = await agent.ingest({ ...mt, updatedAt: `re-${Date.now()}` }, user.name);
    return send(res, 200, meetingCard(r.meeting, store.load()));
  }
  if ((m = p.match(/^\/api\/suggestions\/([\w-]+)\/(approve|reject|edit)$/))) {
    if (m[2] === 'edit') return send(res, 200, agent.edit(m[1], body, user));
    return send(res, 200, await agent.decide(m[1], m[2], user, body));
  }
  throw err(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { await route(req, res, whoIs(req)); }
  catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { error: e.message }); }
});

if (require.main === module) {
  server.listen(cfg.port, () => {
    console.log(`PM Copilot agent on :${cfg.port} · model ${cfg.anthropic.model} · Granola ${granola.configured() ? 'on' : 'off'} · Jira ${jira.dryRun() ? 'dry-run' : 'LIVE writes'}`);
    if (granola.configured() && cfg.granola.syncMinutes > 0) {
      const tick = () => agent.syncGranola('scheduler').then(r => r.notes && console.log('[sync]', r)).catch(e => console.warn('[sync]', e.message));
      setTimeout(tick, 3000); setInterval(tick, cfg.granola.syncMinutes * 60000);
    }
  });
}
module.exports = { server };
