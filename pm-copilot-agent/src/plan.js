/* Project-plan edits (the DayOne Gantt). The plan's baseline ships with the dashboard; this
   stores only what people changed, per task, plus who changed what. data/plan.json (git-ignored). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'plan.json');
const err = (status, message) => Object.assign(new Error(message), { status });
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const write = (v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, FILE); };

const STATUSES = ['done', 'inprogress', 'blocked', 'overdue', 'notstarted', 'planned', 'unconfirmed'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v) => DATE.test(v) && !isNaN(new Date(v + 'T00:00:00Z'));
const str = (max) => (v) => { if (typeof v !== 'string') throw err(400, 'Expected text'); const t = v.trim(); if (!t) throw err(400, 'Text cannot be empty'); if (t.length > max) throw err(400, `Keep it under ${max} characters`); return t; };
const FIELDS = {
  name: str(120), nameZh: str(120), owner: str(80), next: str(300),
  gs: (v) => { if (!validDate(v)) throw err(400, 'Start date must be YYYY-MM-DD'); return v; },
  ge: (v) => { if (!validDate(v)) throw err(400, 'End date must be YYYY-MM-DD'); return v; },
  due: (v) => { if (!validDate(v)) throw err(400, 'Target date must be YYYY-MM-DD'); return v; },
  targetOriginal: (v) => { if (!validDate(v)) throw err(400, 'Original target date must be YYYY-MM-DD'); return v; },
  status: (v) => { if (!STATUSES.includes(v)) throw err(400, 'Unknown status'); return v; },
  progress: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 100) throw err(400, 'Progress is a whole number from 0 to 100'); return n; },
};
const TASK_ID = /^[A-Za-z0-9_-]{1,12}$/;

function get(project) { const p = read()[project] || {}; return { tasks: p.tasks || {}, milestone: p.milestone || null, history: (p.history || []).slice(0, 100), decisions: Object.values(p.decisions || {}) }; }

function editTask(project, taskId, fields, before, by, source) {
  if (!TASK_ID.test(taskId)) throw err(400, 'Bad task id');
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) { if (!FIELDS[k]) throw err(400, `Field ${k} cannot be edited`); clean[k] = FIELDS[k](v); }
  if (!Object.keys(clean).length) throw err(400, 'Nothing to change');
  const all = read(); const p = all[project] = all[project] || { tasks: {}, history: [] };
  const cur = p.tasks[taskId] = Object.assign({}, p.tasks[taskId], clean);
  const gs = cur.gs || (before && before.gs), ge = cur.ge || (before && before.ge);
  if (gs && ge && gs > ge) throw err(400, 'The end date is before the start date');
  const changes = {}; Object.keys(clean).forEach(k => { changes[k] = [before ? before[k] ?? null : null, clean[k]]; });
  p.history = [Object.assign({ at: new Date().toISOString(), by, taskId, changes }, source ? { source } : {})].concat(p.history || []).slice(0, 500);
  write(all);
  return { task: cur, history: p.history.slice(0, 100) };
}
function resetTask(project, taskId, by) {
  const all = read(); const p = all[project]; if (!p || !p.tasks || !p.tasks[taskId]) throw err(404, 'This task has no edits');
  delete p.tasks[taskId];
  p.history = [{ at: new Date().toISOString(), by, taskId, changes: { reset: [null, 'back to the original plan'] } }].concat(p.history || []).slice(0, 500);
  write(all);
}
function editMilestone(project, { date, name }, by) {
  const m = {};
  if (date !== undefined) { if (!validDate(date)) throw err(400, 'Milestone date must be YYYY-MM-DD'); m.date = date; }
  if (name !== undefined) m.name = str(120)(name);
  if (!Object.keys(m).length) throw err(400, 'Nothing to change');
  const all = read(); const p = all[project] = all[project] || { tasks: {}, history: [] };
  p.milestone = Object.assign({}, p.milestone, m);
  p.history = [{ at: new Date().toISOString(), by, taskId: 'milestone', changes: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [null, v]])) }].concat(p.history || []).slice(0, 500);
  write(all);
  return p.milestone;
}

/* Meeting-minutes proposals reviewed on the Meetings page. A decision is keyed by the proposal's
   content (meeting date + title + what it changes), so the same proposal matches in every browser.
   Approving a task change writes it as a plan edit tagged with the meeting; withdrawing puts the
   field back to what it was before, unless someone has changed it since. */
const sigKey = (sig) => crypto.createHash('sha1').update(String(sig)).digest('hex').slice(0, 16);
const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) : v);
function decide(project, { sig, decision, proposal, taskId, field, value, before } = {}, by) {
  if (typeof sig !== 'string' || !sig || sig.length > 2000) throw err(400, 'Missing proposal signature');
  if (!['approved', 'rejected'].includes(decision)) throw err(400, 'Decision must be approved or rejected');
  const key = sigKey(sig);
  let all = read(); let p = all[project] = all[project] || { tasks: {}, history: [] };
  const had = (p.decisions || {})[key];
  if (had) { if (had.status === decision) return had; throw err(409, `Already ${had.status} by ${had.by}; withdraw it first`); }
  let write_ = null;
  if (decision === 'approved' && taskId && field && value !== undefined && value !== null) {
    if (!FIELDS[field]) throw err(400, `Field ${field} cannot be changed from a meeting`);
    const prevTask = (p.tasks || {})[taskId] || {};
    write_ = { taskId, field, value: FIELDS[field](value), hadPrev: field in prevTask, prev: prevTask[field] ?? null };
    const pr = proposal || {};
    editTask(project, taskId, { [field]: value }, before, by, { kind: 'meeting', title: clip(pr.meetingTitle, 120), date: clip(pr.meetingDate, 20), key });
    all = read(); p = all[project];
  }
  const pr = proposal || {};
  const snap = { meetingTitle: clip(pr.meetingTitle, 120), meetingDate: clip(pr.meetingDate, 20), meetingSummary: clip(pr.meetingSummary, 600),
    entityType: pr.entityType, entityId: clip(pr.entityId, 20), field: clip(pr.field, 40), oldValue: pr.oldValue, newValue: pr.newValue,
    confidence: pr.confidence, evidence: clip(pr.evidence, 800), reason: clip(pr.reason, 600), followupTitle: clip(pr.followupTitle, 200), followupOwner: clip(pr.followupOwner, 80) };
  p.decisions = p.decisions || {};
  p.decisions[key] = { key, sig, status: decision, by, at: new Date().toISOString(), proposal: snap, write: write_ };
  write(all);
  return p.decisions[key];
}
function withdraw(project, sig, by) {
  const key = sigKey(sig);
  const all = read(); const p = all[project];
  const d = p && p.decisions && p.decisions[key];
  if (!d) throw err(404, 'No decision recorded for this proposal');
  if (d.write) {
    const w = d.write, cur = (p.tasks || {})[w.taskId];
    if (cur && String(cur[w.field]) === String(w.value)) {
      if (w.hadPrev) cur[w.field] = w.prev; else delete cur[w.field];
      if (!Object.keys(cur).length) delete p.tasks[w.taskId];
      p.history = [{ at: new Date().toISOString(), by, taskId: w.taskId, changes: { [w.field]: [w.value, w.hadPrev ? w.prev : 'original plan'] }, source: { kind: 'meeting-withdrawn', title: d.proposal.meetingTitle, date: d.proposal.meetingDate, key } }].concat(p.history || []).slice(0, 500);
    }
  }
  delete p.decisions[key];
  write(all);
  return { ok: true };
}
module.exports = { get, editTask, resetTask, editMilestone, decide, withdraw, sigKey };
