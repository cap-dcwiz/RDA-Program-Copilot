/* Offline: approver attribution on live Jira writes. fetch is stubbed; nothing leaves the machine. */
const assert = require('assert');
Object.assign(process.env, { JIRA_EMAIL: 'bot@rda.ai', JIRA_API_TOKEN: 'x', JIRA_DRY_RUN: 'false',
  JIRA_USER_MAP: 'zhangzhaoning=selena.zhang@rda.ai, mapped@gmail.com=712020:direct' });
const calls = [];
let rejectParent = false;
global.fetch = async (url, o = {}) => {
  const body = o.body ? JSON.parse(o.body) : null; calls.push({ url, method: o.method, body });
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (url.includes('/user/search')) {
    const q = decodeURIComponent(url.split('query=')[1].split('&')[0]);
    return ok(q === 'selena.zhang@rda.ai' ? [{ accountId: 'acc-selena', active: true, accountType: 'atlassian', emailAddress: 'selena.zhang@rda.ai' }] : []);
  }
  if (url.endsWith('/rest/api/3/issue') && body.fields.parent && rejectParent)
    return { ok: false, status: 400, text: async () => '{"errors":{"parent":"parent cannot be set."}}' };
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
  // 1. New ticket: reporter left to Jira (the shared account); the footer names who approved.
  let r = await jira.apply(ticket, m, user({ username: 'zhangzhaoning', displayName: 'zhangzhaoning', email: 'zz@gmail.com' }));
  assert.equal(r.createdKey, 'BA-9999'); assert.equal(lastCreate().reporter, undefined);
  assert.match(text(lastCreate()), /approved by zhangzhaoning \(zz@gmail\.com\)/);
  assert.ok(!calls.some(c => c.url.includes('/user/search')));               // no per-person lookup
  // 2. Jira refuses the epic link → retried without it, task still created.
  rejectParent = true;
  r = await jira.apply(ticket, m, user({}));
  assert.equal(r.createdKey, 'BA-9999'); assert.equal(lastCreate().parent, undefined); assert.match(r.note, /project epic/);
  // 3. Comments carry the approver's name too.
  await jira.apply({ kind: 'comment', jiraKey: 'BA-1', detail: 'd' }, m, user({ displayName: 'Sherry', email: 'sherry.liu@rda.ai' }));
  assert.match(JSON.stringify(calls.pop().body), /approved by Sherry \(sherry\.liu@rda\.ai\)/);
  console.log('approver attribution ok');
})().catch((e) => { console.error(e); process.exit(1); });
