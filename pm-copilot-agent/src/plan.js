/* Project-plan edits (the DayOne Gantt). The plan's baseline ships with the dashboard; this
   stores only what people changed, per task, plus who changed what. data/plan.json (git-ignored). */
const fs = require('fs');
const path = require('path');
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
  status: (v) => { if (!STATUSES.includes(v)) throw err(400, 'Unknown status'); return v; },
  progress: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 100) throw err(400, 'Progress is a whole number from 0 to 100'); return n; },
};
const TASK_ID = /^[A-Za-z0-9_-]{1,12}$/;

function get(project) { const p = read()[project] || {}; return { tasks: p.tasks || {}, milestone: p.milestone || null, history: (p.history || []).slice(0, 100) }; }

function editTask(project, taskId, fields, before, by) {
  if (!TASK_ID.test(taskId)) throw err(400, 'Bad task id');
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) { if (!FIELDS[k]) throw err(400, `Field ${k} cannot be edited`); clean[k] = FIELDS[k](v); }
  if (!Object.keys(clean).length) throw err(400, 'Nothing to change');
  const all = read(); const p = all[project] = all[project] || { tasks: {}, history: [] };
  const cur = p.tasks[taskId] = Object.assign({}, p.tasks[taskId], clean);
  const gs = cur.gs || (before && before.gs), ge = cur.ge || (before && before.ge);
  if (gs && ge && gs > ge) throw err(400, 'The end date is before the start date');
  const changes = {}; Object.keys(clean).forEach(k => { changes[k] = [before ? before[k] ?? null : null, clean[k]]; });
  p.history = [{ at: new Date().toISOString(), by, taskId, changes }].concat(p.history || []).slice(0, 500);
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
module.exports = { get, editTask, resetTask, editMilestone };
