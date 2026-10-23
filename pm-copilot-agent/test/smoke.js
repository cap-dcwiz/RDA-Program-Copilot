/* Offline checks: Jira request plans and auth. No network. */
const assert = require('assert');
const jira = require('../src/jira');
const m = { title: 'Weekly', date: '2026-10-12T10:00:00+08:00' };
let p = jira.plan({ kind: 'due_date', jiraKey: 'BA-1864', newDueDate: '2026-10-31', detail: 'x', evidence: 'q' }, m, 'Sherry');
assert.equal(p[0].method, 'PUT'); assert.equal(p[0].body.fields.duedate, '2026-10-31'); assert.equal(p.length, 2);
p = jira.plan({ kind: 'new_ticket', project: 'bdc', title: 'Send list', detail: 'd', newDueDate: '2026-10-16' }, m, 'Sherry');
assert.equal(p[0].body.fields.customfield_10034.id, '10029'); assert.equal(p[0].body.fields.issuetype.id, '10006');
p = jira.plan({ kind: 'comment', jiraKey: 'BA-2034', detail: 'd' }, m, 'Sherry');
assert.match(p[0].path, /BA-2034\/comment$/);
console.log('smoke ok');
const g = require('../src/granola');
const mt = g.toMeeting({ id: 'not_1d3tmYTlCICgjy', title: ' Weekly ', owner: { name: 'Valdy', email: 'v@rda.ai' }, created_at: '2026-10-12T02:00:00Z', updated_at: '2026-10-12T03:00:00Z',
  web_url: 'https://notes.granola.ai/d/x', attendees: [{ name: 'Sherry', email: 's@rda.ai' }], summary_markdown: '# Summary\n- a',
  transcript: [{ speaker: { source: 'microphone' }, text: 'hello' }] });
assert.equal(mt.title, 'Weekly'); assert.equal(mt.sourceId, 'not_1d3tmYTlCICgjy'); assert.match(mt.notesText, /Granola summary/); assert.match(mt.notesText, /microphone: hello/);
console.log('granola mapping ok');
const P = require('../src/permissions');
const roles = P.DEFAULT_ROLES;
let e = P.effective(roles, ['customer-dayone']);
assert.deepEqual(e.projects, ['dayone']); assert.ok(!e.actions.includes('approve')); assert.ok(!e.pages.includes('portfolio'));
e = P.effective(roles, ['rda-member']);
assert.ok(!e.actions.includes('edit_plan'));
assert.deepEqual(e.projects, ['*']); assert.ok(e.pages.includes('portfolio') && !e.pages.includes('users') && !e.actions.includes('approve'));
e = P.effective(roles, ['rda-manager']);
assert.ok(e.actions.includes('approve') && e.actions.includes('edit_plan') && !e.pages.includes('users'));
e = P.effective(roles, ['rda-member', 'customer-dayone']); assert.deepEqual(e.projects, ['*']);
e = P.effective(roles, ['admin']); assert.ok(e.pages.includes('users') && e.actions.includes('approve'));
console.log('permissions ok');

/* ---- Product Center identity -> this dashboard's roles ---- */
const acc = P.DEFAULT_ACCESS;
const map = (id) => P.rolesFor(acc, id, roles);
assert.deepEqual(map({ username: 'a', email: 'a@rda.ai', pcRoles: ['admin'] }), ['admin']);
assert.deepEqual(map({ username: 'b', email: 'b@rda.ai', pcRoles: ['operator'] }), ['rda-manager']);
assert.deepEqual(map({ username: 'c', email: 'c@rda.ai', pcRoles: ['viewer'] }), ['rda-member']);
// A Product Center role nobody has mapped grants nothing here — never a default to all projects.
assert.deepEqual(map({ username: 'd', email: 'd@client.com', pcRoles: ['customer'] }), []);
assert.deepEqual(map({ username: 'e', email: 'e@rda.ai', pcRoles: ['nonexistent'] }), []);
// Several Product Center roles union, as roles do everywhere else.
assert.deepEqual(map({ username: 'f', email: 'f@rda.ai', pcRoles: ['operator', 'viewer'] }).sort(), ['rda-manager', 'rda-member']);
// Naming a person overrides their role, and is matched case-insensitively on email or username.
const pinned = { byRole: acc.byRole, byUser: { 'd@client.com': ['customer-dayone'] } };
assert.deepEqual(P.rolesFor(pinned, { username: 'd', email: 'D@Client.com', pcRoles: ['customer'] }, roles), ['customer-dayone']);
// An override naming a role this dashboard does not have must not leak through.
assert.deepEqual(P.rolesFor({ byRole: {}, byUser: { 'x@rda.ai': ['no-such-role'] } }, { username: 'x', email: 'x@rda.ai', pcRoles: [] }, roles), []);
// A customer pinned to one project stays confined to it.
assert.deepEqual(P.effective(roles, map({ username: 'g', email: 'g@rda.ai', pcRoles: ['viewer'] })).projects, ['*']);
assert.deepEqual(P.effective(roles, ['customer-dayone']).projects, ['dayone']);
console.log('product-center role mapping ok');
