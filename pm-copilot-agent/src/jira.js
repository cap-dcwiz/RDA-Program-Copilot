/* Jira Cloud REST v3. Reads open tickets for context; writes approved suggestions.
   With JIRA_DRY_RUN=true (default) or no credentials, writes are logged but not sent. */
const fs = require('fs');
const path = require('path');
const cfgAll = require('./config');
const cfg = cfgAll.jira;

const hasCreds = () => !!(cfg.email && cfg.token);
const auth = () => 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
const browse = (key) => `${cfg.baseUrl}/browse/${key}`;

async function call(method, pathname, body) {
  const res = await fetch(cfg.baseUrl + pathname, {
    method, headers: { Authorization: auth(), Accept: 'application/json', 'Content-Type': 'application/json' },
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
  if (hasCreds()) {
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

/* Build the exact requests an approval sends, so dry-run shows what live mode would do. */
function plan(s, meeting, approver) {
  const footer = `\n— PM Copilot · from "${meeting.title}" (${String(meeting.date).slice(0, 10)}) · approved by ${approver}`;
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
    const opt = cfgAll.CLIENT_OPTIONS[s.project];
    if (opt) fields[cfg.clientField] = { id: opt.id };
    return [{ method: 'POST', path: '/rest/api/3/issue', body: { fields } }];
  }
  throw new Error(`Unknown suggestion kind: ${s.kind}`);
}

async function apply(s, meeting, approver) {
  const steps = plan(s, meeting, approver);
  const live = !cfg.dryRun && hasCreds();
  if (!live) return { dryRun: true, steps, url: s.jiraKey ? browse(s.jiraKey) : null,
    note: cfg.dryRun ? 'JIRA_DRY_RUN=true: nothing was written to Jira' : 'No Jira credentials: nothing was written to Jira' };
  const results = [];
  for (const st of steps) results.push(await call(st.method, st.path, st.body));
  const createdKey = s.kind === 'new_ticket' ? results[0].key : null;
  return { dryRun: false, steps: steps.map(x => ({ method: x.method, path: x.path })), createdKey, url: browse(createdKey || s.jiraKey) };
}

module.exports = { openTickets, apply, plan, hasCreds, browse, dryRun: () => cfg.dryRun || !hasCreds() };
