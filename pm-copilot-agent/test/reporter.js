/* Offline: approver attribution on live Jira writes. fetch is stubbed; nothing leaves the machine. */
const assert = require('assert');
Object.assign(process.env, { JIRA_EMAIL: 'bot@rda.ai', JIRA_API_TOKEN: 'x', JIRA_DRY_RUN: 'false',
  JIRA_USER_MAP: 'zhangzhaoning=selena.zhang@rda.ai, mapped@gmail.com=712020:direct' });
const calls = [];
let rejectReporter = false;
global.fetch = async (url, o = {}) => {
  const body = o.body ? JSON.parse(o.body) : null; calls.push({ url, method: o.method, body });
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (url.includes('/user/search')) {
    const q = decodeURIComponent(url.split('query=')[1].split('&')[0]);
    return ok(q === 'selena.zhang@rda.ai' ? [{ accountId: 'acc-selena', active: true, accountType: 'atlassian', emailAddress: 'selena.zhang@rda.ai' }] : []);
  }
  if (url.endsWith('/rest/api/3/issue') && body.fields.reporter && rejectReporter)
    return { ok: false, status: 400, text: async () => '{"errors":{"reporter":"Field \'reporter\' cannot be set."}}' };
  if (url.endsWith('/rest/api/3/issue')) return ok({ key: 'BA-9999' });
  return ok({});
};
const jira = require('../src/jira');
const m = { title: 'Weekly', date: '2026-11-06T09:30:00+08:00' };
const user = (o) => ({ username: 'u', displayName: 'U', ...o });
const ticket = { kind: 'new_ticket', project: 'dayone', title: 't', detail: 'd' };
const lastCreate = () => calls.filter(c => c.url.endsWith('/rest/api/3/issue')).pop().body.fields;
const text = (f) => JSON.stringify(f.description);

(async () => {
  // 1. Username mapped to a Jira email → looked up → set as reporter; footer names the approver.
  let r = await jira.apply(ticket, m, user({ username: 'zhangzhaoning', displayName: 'zhangzhaoning', email: 'zz@gmail.com' }));
  assert.equal(r.createdKey, 'BA-9999'); assert.equal(r.reporter, 'acc-selena');
  assert.deepEqual(lastCreate().reporter, { id: 'acc-selena' }); assert.match(text(lastCreate()), /approved by zhangzhaoning \(zz@gmail\.com\)/);
  // 2. Mapped straight to an accountId → no lookup needed.
  const before = calls.length;
  r = await jira.apply(ticket, m, user({ email: 'mapped@gmail.com' }));
  assert.equal(r.reporter, '712020:direct'); assert.ok(!calls.slice(before).some(c => c.url.includes('/user/search')));
  // 3. No Jira account found → ticket still created, no reporter, note explains.
  r = await jira.apply(ticket, m, user({ email: 'nobody@x.com' }));
  assert.equal(r.createdKey, 'BA-9999'); assert.equal(lastCreate().reporter, undefined); assert.match(r.note, /no Jira account found/);
  // 4. Jira refuses the reporter field (no "Modify Reporter") → retried without it.
  rejectReporter = true;
  r = await jira.apply(ticket, m, user({ username: 'zhangzhaoning', email: 'zz@gmail.com' }));
  assert.equal(r.createdKey, 'BA-9999'); assert.equal(lastCreate().reporter, undefined); assert.match(r.note, /Modify Reporter/);
  // 5. Comments carry the approver's name and email (comment author is always the shared account).
  await jira.apply({ kind: 'comment', jiraKey: 'BA-1', detail: 'd' }, m, user({ displayName: 'Sherry', email: 'sherry.liu@rda.ai' }));
  assert.match(JSON.stringify(calls.pop().body), /approved by Sherry \(sherry\.liu@rda\.ai\)/);
  console.log('reporter attribution ok');
})().catch((e) => { console.error(e); process.exit(1); });
