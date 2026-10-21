/* Nightly Jira → Delivery Copilot sync (read-only on the Jira side).

   DayOne: every ticket under the DayOne epic. Tickets mapped to a plan task (data/dayone-jira-map.json)
   own that task's status, owner and target date, plus the latest comment; other tickets become their
   own plan tasks, placed by the month in their "[x.y]" code. Output: data/dayone-jira.json.

   Portfolio: the open-ticket JQL behind the Portfolio page. Refreshes status, assignee, due and
   last-updated in data/portfolio.json, adds new tickets with their latest comment as the signal, and
   drops tickets that left the query. The PM's analysis (health, risks, asks) is left untouched. */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const jira = require('./jira');
const store = require('./store');

const F = (n) => path.join(cfg.DATA_DIR, n);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const FIELDS = ['summary', 'status', 'assignee', 'duedate', 'created', 'updated', 'resolutiondate', 'parent', cfg.jira.clientField];

/* Jira status → plan status. Uses the status category so localized names (已完成, 正在进行) work. */
function planStatus(st) {
  const name = String((st && st.name) || '').toLowerCase(), cat = st && st.statusCategory && st.statusCategory.key;
  if (cat === 'done') return 'done';
  if (/block/.test(name)) return 'blocked';
  if (cat === 'indeterminate') return 'inprogress';
  if (/backlog/.test(name)) return 'planned';
  return 'notstarted';
}
const code = (summary) => { const m = String(summary).match(/\[DayOne-NTPE\]\[(\d+)(?:\.(\d+))*\]/i); return m ? Number(m[1]) : null; };
const cleanTitle = (summary) => String(summary).replace(/^\s*(\[[^\]]+\]\s*)+/, '').trim() || summary;
const day = (iso) => iso ? String(iso).slice(0, 10) : null;

function ticketRow(i) {
  const f = i.fields || {};
  return { key: i.key, url: `${cfg.jira.baseUrl}/browse/${i.key}`, summary: f.summary, title: cleanTitle(f.summary),
    statusName: f.status && f.status.name, status: planStatus(f.status), owner: f.assignee ? f.assignee.displayName : null,
    due: f.duedate || null, created: day(f.created), updated: day(f.updated), resolved: day(f.resolutiondate), parent: f.parent ? f.parent.key : null };
}

async function syncDayone() {
  const map = readJson(F('dayone-jira-map.json'), { tasks: {}, ignore: [] });
  const byKey = Object.fromEntries(Object.entries(map.tasks || {}).map(([task, key]) => [key, task]));
  const ignore = new Set(map.ignore || []);
  const issues = await jira.searchAll(cfg.jira.dayoneJql, FIELDS);
  const rows = issues.map(ticketRow);
  const tasks = {}, extra = [];
  for (const r of rows) {
    if (byKey[r.key]) {
      r.lastComment = await jira.lastComment(r.key).catch(() => null);
      tasks[byKey[r.key]] = r;
    } else if (!ignore.has(r.key) && !byKey[r.parent] && !(r.parent && r.parent !== map.epic && rows.some(x => x.key === r.parent))) {
      const month = code(r.summary);
      if (!month) continue;            // not part of the numbered DayOne plan (old 2025 tickets, other epics)
      r.month = month;
      r.lastComment = await jira.lastComment(r.key).catch(() => null);
      extra.push(r);
    }
  }
  const missing = Object.entries(map.tasks || {}).filter(([, key]) => !rows.find(r => r.key === key)).map(([task, key]) => `${task}→${key}`);
  const out = { syncedAt: new Date().toISOString(), jql: cfg.jira.dayoneJql, tickets: rows.length, tasks, extra, missing };
  writeJson(F('dayone-jira.json'), out);
  return { tickets: rows.length, mapped: Object.keys(tasks).length, extra: extra.length, missing };
}

async function syncPortfolio() {
  // data/portfolio.json is the committed seed; the sync writes portfolio.live.json (git-ignored) so a
  // `git pull` on the server never conflicts with synced data.
  const pf = readJson(F('portfolio.live.json'), null) || readJson(F('portfolio.json'), null); if (!pf) return { skipped: 'no portfolio data' };
  const clientToProj = Object.fromEntries(Object.entries(cfg.CLIENT_OPTIONS).map(([proj, o]) => [o.label.toLowerCase(), proj]));
  clientToProj['dayone'] = 'dayone'; clientToProj['bdx sin1-chiller plant'] = 'bdx';
  const issues = await jira.searchAll(cfg.jira.jql, FIELDS);
  const old = Object.fromEntries((pf.tickets || []).map(t => [t.key, t]));
  const ST = { done: 'todo', inprogress: 'inprogress', blocked: 'blocked', planned: 'todo', notstarted: 'todo' };
  const fresh = [];
  for (const i of issues) {
    const r = ticketRow(i), f = i.fields || {};
    const client = f[cfg.jira.clientField] && f[cfg.jira.clientField].value;
    const proj = (old[r.key] && old[r.key].proj) || clientToProj[String(client || '').toLowerCase()] || null;
    if (!proj) continue;
    const name = String(r.statusName || '').toLowerCase();
    const status = /review|审查/.test(name) ? 'review' : ST[r.status] || 'inprogress';
    const prev = old[r.key];
    let signal = prev && prev.signal;
    if (!prev || prev.updated !== r.updated) { const c = await jira.lastComment(r.key).catch(() => null); if (c) signal = `${day(c.at)}: ${c.text.split('\n')[0].slice(0, 280)}`; }
    fresh.push({ key: r.key, proj, summary: r.summary, status, assignee: r.owner || '—', created: r.created, updated: r.updated, due: r.due, signal: signal || 'No comments yet.' });
  }
  const context = (pf.tickets || []).filter(t => t.inQuery === false);
  const removed = (pf.tickets || []).filter(t => t.inQuery !== false && !fresh.find(x => x.key === t.key)).map(t => t.key);
  pf.tickets = fresh.concat(context);
  pf.asOf = day(new Date().toISOString()); pf.syncedAt = new Date().toISOString();
  writeJson(F('portfolio.live.json'), pf);
  return { open: fresh.length, added: fresh.filter(t => !old[t.key]).length, removed };
}

let running = null;
async function runAll(by) {
  if (running) return running;
  running = (async () => {
    const db = store.load();
    const res = { at: new Date().toISOString(), by: by || 'scheduler' };
    if (!jira.hasCreds()) { res.ok = false; res.error = 'JIRA_EMAIL / JIRA_API_TOKEN are not set'; }
    else {
      try { res.dayone = await syncDayone(); res.portfolio = await syncPortfolio(); res.ok = true; }
      catch (e) { res.ok = false; res.error = e.message; }
    }
    db.sync.lastJiraSync = res;
    store.audit(res.by, 'jira-sync', 'jira', res.ok ? `DayOne ${res.dayone.tickets} tickets, portfolio ${res.portfolio.open} open` : res.error);
    store.save();
    return res;
  })();
  try { return await running; } finally { running = null; }
}

/* Next run: 00:00 local (JIRA_SYNC_TZ_OFFSET) on Tue–Sat, i.e. right after 24:00 Mon–Fri. */
function nextRun(now = new Date()) {
  const off = cfg.jira.syncTz.match(/^([+-])(\d{2}):(\d{2})$/); const sign = off && off[1] === '-' ? -1 : 1;
  const offMs = off ? sign * (Number(off[2]) * 60 + Number(off[3])) * 60000 : 8 * 3600000;
  const local = new Date(now.getTime() + offMs);
  for (let i = 1; i <= 8; i++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, 0, 0, 0));
    if ([2, 3, 4, 5, 6].includes(d.getUTCDay())) return new Date(d.getTime() - offMs);
  }
}
function schedule() {
  if (!cfg.jira.sync) return null;
  const at = nextRun();
  setTimeout(() => { runAll('scheduler').then(r => console.log('[jira-sync]', r.ok ? 'ok' : r.error)).finally(schedule); }, at - Date.now());
  store.load().sync.nextJiraSync = at.toISOString(); store.save();
  return at;
}

const readPortfolio = () => readJson(F('portfolio.live.json'), null) || readJson(F('portfolio.json'), null);
module.exports = { readPortfolio, runAll, schedule, nextRun, syncDayone, syncPortfolio, planStatus, readDayone: () => readJson(F('dayone-jira.json'), null) };
