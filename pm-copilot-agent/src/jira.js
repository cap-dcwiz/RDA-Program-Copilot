/* Jira Cloud REST v3. Reads open tickets for context; writes approved suggestions.
   With JIRA_DRY_RUN=true (default) or no credentials, writes are logged but not sent. */
const fs = require('fs');
const path = require('path');
const cfgAll = require('./config');
const cfg = cfgAll.jira;
const projects = require('./projects');

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

/* Plain text → Atlassian Document Format, one paragraph per line. `mention` ({accountId, name})
   puts an @mention of that person at the start, which Jira turns into a notification. */
const adf = (text, mention) => {
  const content = String(text).split(/\n/).map(line =>
    line.trim() ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] });
  if (mention && mention.accountId) {
    const at = { type: 'mention', attrs: { id: mention.accountId, text: `@${mention.name || ''}` } };
    content[0] = { type: 'paragraph', content: [at, { type: 'text', text: ' ' }, ...(content[0].content || [])] };
  }
  return { type: 'doc', version: 1, content };
};

/* Who a ticket is assigned to, for the @mention on a comment. null when unassigned or unreadable. */
async function assigneeOf(key) {
  if (!key || !hasCreds()) return null;
  try {
    const i = await call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=assignee`);
    const a = i.fields && i.fields.assignee;
    return a && a.accountId ? { accountId: a.accountId, name: a.displayName } : null;
  } catch (e) { console.warn('[jira] assignee lookup failed:', e.message); return null; }
}

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

/* Every write is sent with the shared JIRA_EMAIL account, which is therefore the author, creator
   and reporter. Who approved is named in the footer of every description and comment. */
const approverLabel = (u) => typeof u === 'string' ? u : `${u.displayName || u.name || u.username}${u.email ? ` (${u.email})` : ''}`;

/* Build the exact requests an approval sends, so dry-run shows what live mode would do.
   `approver` is the signed-in user (or a plain name, for older callers). */
function plan(s, meeting, approver, mention) {
  const footer = `\n— PM Copilot · from "${meeting.title}" (${String(meeting.date).slice(0, 10)}) · approved by ${approverLabel(approver)}`;
  const quote = s.evidence ? `\nMeeting note: "${s.evidence}"` : '';
  // Existing ticket: a comment that @mentions its assignee. New work: a new task, the content in its description.
  if (s.kind === 'comment') return [{ method: 'POST', path: `/rest/api/3/issue/${s.jiraKey}/comment`, body: { body: adf(s.detail + quote + footer, mention) } }];
  if (s.kind === 'due_date') return [
    { method: 'PUT', path: `/rest/api/3/issue/${s.jiraKey}`, body: { fields: { duedate: s.newDueDate } } },
    { method: 'POST', path: `/rest/api/3/issue/${s.jiraKey}/comment`, body: { body: adf(`Due date set to ${s.newDueDate}. ${s.detail || ''}${quote}${footer}`, mention) } },
  ];
  if (s.kind === 'new_ticket') {
    const fields = { project: { key: cfg.projectKey }, issuetype: { id: cfg.issueTypeId }, summary: s.title,
      description: adf(`${s.detail || ''}${s.owner ? `\nOwner named in meeting: ${s.owner}` : ''}${quote}${footer}`) };
    if (s.newDueDate) fields.duedate = s.newDueDate;
    // BA rejects a create without one ("修复版本 是必需的"). Quarter taken in Singapore time.
    const sg = new Date(Date.now() + 8 * 3600000);
    fields.fixVersions = [{ name: cfg.fixVersion || `Q${Math.floor(sg.getUTCMonth() / 3) + 1} ${sg.getUTCFullYear()}` }];
    // The client value is what the project's Jira filter selects on, so the new task lands in it.
    const p = projects.byId(s.project);
    if (p) fields[cfg.clientField] = p.optionId ? { id: p.optionId } : { value: p.client || p.label };
    if (cfg.projectEpics[s.project]) fields.parent = { key: cfg.projectEpics[s.project] };
    return [{ method: 'POST', path: '/rest/api/3/issue', body: { fields } }];
  }
  throw new Error(`Unknown suggestion kind: ${s.kind}`);
}

async function apply(s, meeting, approver) {
  const mention = s.kind === 'new_ticket' ? null : await assigneeOf(s.jiraKey);
  const steps = plan(s, meeting, approver, mention);
  const live = !cfg.dryRun && hasCreds();
  if (!live) return { dryRun: true, steps, url: s.jiraKey ? browse(s.jiraKey) : null,
    note: cfg.dryRun ? 'JIRA_DRY_RUN=true: nothing was written to Jira' : 'No Jira credentials: nothing was written to Jira' };
  const results = []; let note;
  for (const st of steps) {
    try { results.push(await call(st.method, st.path, st.body)); }
    catch (e) {
      // An epic link Jira refuses (wrong hierarchy, epic closed) is dropped; the task is still created.
      const f = st.body && st.body.fields;
      if (!(f && f.parent && /parent/i.test(e.message))) throw e;
      delete f.parent;
      note = 'Not filed under the project epic: Jira refused the parent';
      results.push(await call(st.method, st.path, st.body));
    }
  }
  const createdKey = s.kind === 'new_ticket' ? results[0].key : null;
  return { dryRun: false, steps: steps.map(x => ({ method: x.method, path: x.path })), createdKey, url: browse(createdKey || s.jiraKey),
    mentioned: mention ? mention.name : undefined,
    note };
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

const refreshProjects = () => projects.refresh(call);
module.exports = { refreshProjects, assigneeOf, searchAll, issue, lastComment, adfText, openTickets, apply, plan, hasCreds, browse, dryRun: () => cfg.dryRun || !hasCreds() };
