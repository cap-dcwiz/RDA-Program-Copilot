/* Jira Cloud REST v3. Reads open tickets for context; writes approved suggestions.
   With JIRA_DRY_RUN=true (default) or no credentials, writes are logged but not sent. */
const fs = require('fs');
const path = require('path');
const cfgAll = require('./config');
const cfg = cfgAll.jira;

const oauth = require('./jiraoauth');

const hasCreds = () => !!(cfg.email && cfg.token);                 // the shared JIRA_EMAIL account
const canRead = () => hasCreds() || (oauth.configured() && !!oauth.backgroundUser());
const auth = () => 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
const browse = (key) => `${cfg.baseUrl}/browse/${key}`;

/* `as` = a person's OAuth access ({accessToken, cloudId}); those calls go through Atlassian's API
   gateway. Without it: the shared account, or for reads with no shared account, a connected
   person's access (see jiraoauth.backgroundUser). */
async function call(method, pathname, body, as) {
  if (!as && !hasCreds() && oauth.configured() && oauth.backgroundUser()) as = await oauth.tokenFor(oauth.backgroundUser());
  const base = as ? `https://api.atlassian.com/ex/jira/${as.cloudId}` : cfg.baseUrl;
  const res = await fetch(base + pathname, {
    method, headers: { Authorization: as ? `Bearer ${as.accessToken}` : auth(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/* Plain text → Atlassian Document Format, one paragraph per line. */
const adf = (text) => ({ type: 'doc', version: 1, content: String(text).split(/\n/).map(line =>
  line.trim() ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] }) });

/* Open tickets the model may map suggestions onto. Live when credentials exist, else the snapshot. */
async function openTickets() {
  if (canRead()) {
    try {
      const q = new URLSearchParams({ jql: cfg.jql, maxResults: '100', fields: `summary,status,assignee,duedate,updated,${cfg.clientField}` });
      const r = await call('GET', `/rest/api/3/search/jql?${q}`);
      return { live: true, tickets: (r.issues || []).map(i => ({
        key: i.key, summary: i.fields.summary, status: i.fields.status && i.fields.status.name,
        assignee: i.fields.assignee ? i.fields.assignee.displayName : null, due: i.fields.duedate || null,
        client: i.fields[cfg.clientField] ? i.fields[cfg.clientField].value : null, updated: i.fields.updated })) };
    } catch (e) { console.warn('[jira] live read failed, using snapshot:', e.message); }
  }
  const snap = JSON.parse(fs.readFileSync(path.join(cfgAll.DATA_DIR, 'jira.snapshot.json'), 'utf8'));
  return { live: false, takenAt: snap.takenAt, tickets: snap.tickets };
}

/* Who approved, as Jira knows them. Every write is sent with the shared JIRA_EMAIL account, so the
   approver can't author it; instead a new ticket's reporter is set to them, and every comment and
   description carries their name and email. Lookup order: JIRA_USER_MAP by username, then by
   email, then the sign-in email itself. A miss returns null and the write goes ahead without it. */
const accountCache = new Map();
async function accountIdFor(user) {
  if (!user || !hasCreds()) return null;
  const keys = [user.username, user.email].filter(Boolean).map(k => String(k).toLowerCase());
  const target = keys.map(k => cfg.userMap[k]).find(Boolean) || user.email;
  if (!target) return null;
  if (!target.includes('@')) return target;                                   // already an accountId
  if (accountCache.has(target)) return accountCache.get(target);
  let id = null;
  try {
    const r = await call('GET', `/rest/api/3/user/search?query=${encodeURIComponent(target)}&maxResults=5`);
    const hit = (r || []).find(u => u.active && u.accountType === 'atlassian' && (!u.emailAddress || u.emailAddress.toLowerCase() === target.toLowerCase()));
    id = hit ? hit.accountId : null;
  } catch (e) { console.warn('[jira] user lookup failed:', e.message); }
  accountCache.set(target, id);
  return id;
}
const approverLabel = (u) => typeof u === 'string' ? u : `${u.displayName || u.name || u.username}${u.email ? ` (${u.email})` : ''}`;

/* Build the exact requests an approval sends, so dry-run shows what live mode would do.
   `approver` is the signed-in user (or a plain name, for older callers). */
function plan(s, meeting, approver, reporterId) {
  const footer = `\n— PM Copilot · from "${meeting.title}" (${String(meeting.date).slice(0, 10)}) · approved by ${approverLabel(approver)}`;
  const quote = s.evidence ? `\nMeeting note: "${s.evidence}"` : '';
  if (s.kind === 'comment') return [{ method: 'POST', path: `/rest/api/3/issue/${s.jiraKey}/comment`, body: { body: adf(s.detail + quote + footer) } }];
  if (s.kind === 'due_date') return [
    { method: 'PUT', path: `/rest/api/3/issue/${s.jiraKey}`, body: { fields: { duedate: s.newDueDate } } },
    { method: 'POST', path: `/rest/api/3/issue/${s.jiraKey}/comment`, body: { body: adf(`Due date set to ${s.newDueDate}. ${s.detail || ''}${quote}${footer}`) } },
  ];
  if (s.kind === 'new_ticket') {
    const fields = { project: { key: cfg.projectKey }, issuetype: { id: cfg.issueTypeId }, summary: s.title,
      description: adf(`${s.detail || ''}${s.owner ? `\nOwner named in meeting: ${s.owner}` : ''}${quote}${footer}`) };
    if (s.newDueDate) fields.duedate = s.newDueDate;
    // BA rejects a create without one ("修复版本 是必需的"). Quarter taken in Singapore time.
    const sg = new Date(Date.now() + 8 * 3600000);
    fields.fixVersions = [{ name: cfg.fixVersion || `Q${Math.floor(sg.getUTCMonth() / 3) + 1} ${sg.getUTCFullYear()}` }];
    const opt = cfgAll.CLIENT_OPTIONS[s.project];
    if (opt) fields[cfg.clientField] = { id: opt.id };
    if (reporterId) fields.reporter = { id: reporterId };
    return [{ method: 'POST', path: '/rest/api/3/issue', body: { fields } }];
  }
  throw new Error(`Unknown suggestion kind: ${s.kind}`);
}

async function apply(s, meeting, approver) {
  // Per-person sign-in: the write is made with the approver's own Jira access, so Jira shows them
  // as the comment author and the ticket's reporter. Nothing to look up, nothing to impersonate.
  if (oauth.configured()) {
    if (cfg.dryRun) return { dryRun: true, steps: plan(s, meeting, approver), url: s.jiraKey ? browse(s.jiraKey) : null,
      note: 'JIRA_DRY_RUN=true: nothing was written to Jira' };
    const as = await oauth.tokenFor(approver);                  // 428 when they have not connected
    const steps = plan(s, meeting, approver);
    const results = [];
    for (const st of steps) results.push(await call(st.method, st.path, st.body, as));
    const createdKey = s.kind === 'new_ticket' ? results[0].key : null;
    return { dryRun: false, as: as.name, steps: steps.map(x => ({ method: x.method, path: x.path })), createdKey, url: browse(createdKey || s.jiraKey) };
  }
  const reporterId = s.kind === 'new_ticket' ? await accountIdFor(approver) : null;
  const steps = plan(s, meeting, approver, reporterId);
  const live = !cfg.dryRun && hasCreds();
  if (!live) return { dryRun: true, steps, url: s.jiraKey ? browse(s.jiraKey) : null,
    note: cfg.dryRun ? 'JIRA_DRY_RUN=true: nothing was written to Jira' : 'No Jira credentials: nothing was written to Jira' };
  const results = []; let reporterNote = null;
  for (const st of steps) {
    try { results.push(await call(st.method, st.path, st.body)); }
    catch (e) {
      // Setting the reporter needs "Modify Reporter" for the JIRA_EMAIL account. Without it, still
      // create the ticket — the approver stays named in the description — and say why.
      if (!(st.body && st.body.fields && st.body.fields.reporter && /reporter/i.test(e.message))) throw e;
      delete st.body.fields.reporter;
      reporterNote = 'Reporter not set: the Jira account needs the "Modify Reporter" permission in this project';
      results.push(await call(st.method, st.path, st.body));
    }
  }
  const createdKey = s.kind === 'new_ticket' ? results[0].key : null;
  return { dryRun: false, steps: steps.map(x => ({ method: x.method, path: x.path })), createdKey, url: browse(createdKey || s.jiraKey),
    reporter: s.kind === 'new_ticket' ? (reporterNote ? null : reporterId) : undefined,
    note: reporterNote || (s.kind === 'new_ticket' && !reporterId ? 'Reporter not set: no Jira account found for the approver (see JIRA_USER_MAP)' : undefined) };
}

/* ---------- read helpers for the nightly sync ---------- */
async function searchAll(jql, fields) {
  const out = []; let token = null;
  do {
    const q = new URLSearchParams({ jql, maxResults: '100', fields: fields.join(',') });
    if (token) q.set('nextPageToken', token);
    const r = await call('GET', `/rest/api/3/search/jql?${q}`);
    out.push(...(r.issues || []));
    token = r.isLast === false ? r.nextPageToken : null;
  } while (token);
  return out;
}
/* ADF → plain text, enough for a one-line "latest update". */
function adfText(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text || '';
  if (n.type === 'mention') return (n.attrs && n.attrs.text) || '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content || []).map(adfText).join(n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList' ? '\n' : '');
  return ['paragraph', 'listItem', 'heading'].includes(n.type) ? inner + '\n' : inner;
}
async function issue(key, fields) {
  return call('GET', `/rest/api/3/issue/${key}?fields=${encodeURIComponent(fields.join(','))}`);
}
async function lastComment(key) {
  const r = await call('GET', `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=1`);
  const c = (r.comments || [])[0];
  if (!c) return null;
  const text = adfText(c.body).replace(/\n{2,}/g, '\n').trim();
  return { at: c.created, by: c.author ? c.author.displayName : null, text: text.slice(0, 600) };
}

const mode = () => oauth.configured() ? 'per-person' : (hasCreds() ? 'shared' : 'none');
module.exports = { searchAll, issue, lastComment, adfText, openTickets, apply, plan, accountIdFor, hasCreds, canRead, browse, mode,
  dryRun: () => cfg.dryRun || mode() === 'none' };
