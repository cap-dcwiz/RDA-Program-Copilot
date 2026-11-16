/* The pipeline: notes in → Claude → pending suggestions → (admin approves) → Jira. */
const store = require('./store');
const granola = require('./granola');
const jira = require('./jira');
const { analyseMeeting } = require('./claude');
const cfg = require('./config');
const feed = require('./programfeed');

let syncing = null;

async function ingest(meeting, by) {
  const db = store.load();
  let m = meeting.sourceId ? db.meetings.find(x => x.source === meeting.source && x.sourceId === meeting.sourceId) : null;
  if (m && m.updatedAt === meeting.updatedAt && m.status === 'analysed') return { meeting: m, skipped: true };
  if (!m) { m = { id: store.id('mtg'), ...meeting }; db.meetings.unshift(m); }
  else Object.assign(m, meeting);
  m.status = 'analysing'; m.error = null; m.ingestedAt = new Date().toISOString(); m.ingestedBy = by || 'system';
  store.save();
  try {
    const { tickets, live } = await jira.openTickets();
    const a = await analyseMeeting(m, tickets);
    m.summary = a.summary || []; m.projects = a.projects || []; m.model = a.model; m.usage = a.usage; m.jiraContext = live ? 'live' : 'snapshot';
    // Re-analysing a meeting replaces its still-pending suggestions; decided ones are history and stay.
    db.suggestions = db.suggestions.filter(s => !(s.meetingId === m.id && s.status === 'pending'));
    const now = new Date().toISOString();
    for (const s of a.suggestions) db.suggestions.push({ id: store.id('sug'), meetingId: m.id, status: 'pending', createdAt: now, ...s });
    m.status = 'analysed'; m.suggestionCount = a.suggestions.length;
    store.audit(by, 'analyse', m.id, `${a.suggestions.length} suggestions from "${m.title}"`);
    // A meeting about a project with a plan view also updates that view (meetings, change proposals,
    // change log, brief). A failure here leaves the Jira suggestions in place.
    const planProjects = (m.projects || []).includes('dayone') || /day\s*one/i.test(m.title || '') ? ['dayone'] : [];
    for (const project of planProjects) {
      try { const r = await feed.analyse(project, m); m.planFeed = { [project]: r }; store.audit(by, 'plan-feed', m.id, `${project}: ${r.relevant === false ? 'not relevant' : `${r.proposals} plan proposals`}`); }
      catch (e) { m.planFeed = { [project]: { error: e.message } }; store.audit(by, 'plan-feed-failed', m.id, e.message); }
    }
  } catch (e) {
    m.status = 'failed'; m.error = e.message;
    store.audit(by, 'analyse-failed', m.id, e.message);
  }
  store.save();
  return { meeting: m };
}

async function syncGranola(by) {
  if (!granola.configured()) throw new Error('GRANOLA_API_KEY is not set');
  if (syncing) return syncing;
  syncing = (async () => {
    const db = store.load();
    // Re-list the whole lookback window every time, not just "updated since the last sync".
    // A note can become visible to the API key later than its last edit — moved into a shared
    // folder, or shared to the workspace — and keep its old updated_at, so an
    // updated_after=<last sync> cursor would never return it. Notes we already analysed at the
    // same updated_at are skipped before the per-note fetch, so the wider window only costs list calls.
    const since = new Date(Date.now() - cfg.granola.lookbackDays * 86400000).toISOString();
    const startedAt = new Date().toISOString();
    const list = (await granola.listNotes(since)).filter(n => granola.wanted(n.title));
    const known = (n) => db.meetings.some(x => x.source === 'granola' && x.sourceId === n.id && x.status === 'analysed' && n.updated_at && x.updatedAt === n.updated_at);
    const fresh = list.filter(n => !known(n));
    const results = [];
    for (const n of fresh) {
      const full = await granola.getNote(n.id);
      results.push(await ingest(granola.toMeeting(full), by));
    }
    db.sync.lastGranolaSync = startedAt;
    store.audit(by, 'sync', 'granola', `${list.length} notes visible since ${since}, ${fresh.length} new or changed`);
    store.save();
    return { since, listed: list.length, notes: fresh.length, analysed: results.filter(r => !r.skipped).length };
  })();
  try { return await syncing; } finally { syncing = null; }
}

async function decide(id, decision, user, extra = {}) {
  const db = store.load();
  const s = db.suggestions.find(x => x.id === id);
  if (!s) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
  if (s.status !== 'pending') throw Object.assign(new Error(`Already ${s.status}`), { status: 409 });
  const m = db.meetings.find(x => x.id === s.meetingId) || { title: 'Unknown meeting', date: '' };
  if (decision === 'approve') {
    s.jira = await jira.apply(s, m, user);
    s.status = 'approved';
  } else {
    s.status = 'rejected'; s.rejectReason = extra.reason || null;
  }
  s.decidedBy = user.name; s.decidedAt = new Date().toISOString();
  store.audit(user.name, decision, s.id, `${s.kind} ${s.jiraKey || ''} ${s.title}${s.jira && s.jira.dryRun ? ' (dry run)' : ''}`.trim());
  store.save();
  return s;
}

const EDITABLE = ['title', 'detail', 'newDueDate', 'owner', 'jiraKey', 'kind', 'project'];
function edit(id, patch, user) {
  const db = store.load();
  const s = db.suggestions.find(x => x.id === id);
  if (!s) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
  if (s.status !== 'pending') throw Object.assign(new Error(`Already ${s.status}`), { status: 409 });
  const changed = {};
  for (const k of EDITABLE) if (k in patch && patch[k] !== s[k]) { changed[k] = [s[k], patch[k]]; s[k] = patch[k]; }
  s.editedBy = user.name; s.editedAt = new Date().toISOString();
  store.audit(user.name, 'edit', s.id, JSON.stringify(changed));
  store.save();
  return s;
}

/* Meetings analysed before the plan feed existed (or while it failed): give them the plan pass
   once, newest last so the latest brief wins. Only meetings after the shipped plan's asOf. */
async function backfillPlanFeed(by = 'backfill') {
  const db = store.load();
  const asOf = (feed.baselineAsOf && feed.baselineAsOf('dayone')) || '';
  const todo = db.meetings.filter(m => m.status === 'analysed' && m.notesText && String(m.date || '').slice(0, 10) > asOf
    && ((m.projects || []).includes('dayone') || /day\s*one/i.test(m.title || '')) && !(m.planFeed && m.planFeed.dayone && !m.planFeed.dayone.error))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const m of todo) {
    try { m.planFeed = { dayone: await feed.analyse('dayone', m) }; store.audit(by, 'plan-feed', m.id, `dayone: ${m.planFeed.dayone.proposals || 0} plan proposals`); }
    catch (e) { m.planFeed = { dayone: { error: e.message } }; }
    store.save();
  }
  return { meetings: todo.length };
}

module.exports = { ingest, syncGranola, decide, edit, backfillPlanFeed };
