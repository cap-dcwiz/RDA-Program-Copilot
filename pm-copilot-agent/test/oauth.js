/* Offline: per-person Jira sign-in. Atlassian is stubbed; tokens go to a temp file. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-')), 'jira-oauth.json');
Object.assign(process.env, { JIRA_OAUTH_FILE: FILE, ATLASSIAN_CLIENT_ID: 'cid', ATLASSIAN_CLIENT_SECRET: 'csecret',
  PUBLIC_URL: 'https://example.test/DeliveryCopilot', JIRA_DRY_RUN: 'false', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });

const calls = []; let n = 0; let refreshFails = false;
const json = (status, j) => ({ ok: status < 400, status, json: async () => j, text: async () => JSON.stringify(j) });
global.fetch = async (url, o = {}) => {
  const body = o.body ? JSON.parse(o.body) : null; calls.push({ url, method: o.method || 'GET', body, auth: o.headers && o.headers.Authorization });
  if (url === 'https://auth.atlassian.com/oauth/token') {
    if (body.grant_type === 'refresh_token' && refreshFails) return json(403, { error: 'invalid_grant' });
    n++; return json(200, { access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 3600, scope: 'x' });
  }
  if (url.endsWith('/oauth/token/accessible-resources')) return json(200, [
    { id: 'other-cloud', url: 'https://someone-else.atlassian.net' }, { id: 'cloud-1', url: 'https://projects-teams.atlassian.net' }]);
  if (url === 'https://api.atlassian.com/me') return json(200, { account_id: 'acc-zz', name: 'Zhaoning Zhang', email: 'zz@rda.ai' });
  if (url.endsWith('/rest/api/3/issue')) return json(201, { key: 'BA-7777' });
  return json(200, {});
};
const oauth = require('../src/jiraoauth');
const jira = require('../src/jira');
const user = { username: 'zhangzhaoning', displayName: 'zhangzhaoning', email: 'zz@gmail.com' };
const meeting = { title: 'Weekly', date: '2026-11-13T09:30:00+08:00' };

(async () => {
  assert.equal(jira.mode(), 'per-person'); assert.equal(jira.dryRun(), false);
  // Not connected yet → the approval is refused with a code the dashboard acts on.
  await assert.rejects(jira.apply({ kind: 'comment', jiraKey: 'BA-1', detail: 'd' }, meeting, user), e => e.status === 428 && e.code === 'jira_connect_required');

  // Connect URL carries the right client, callback, scopes and a signed state.
  const u = new URL(oauth.connectUrl(user));
  assert.equal(u.origin + u.pathname, 'https://auth.atlassian.com/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.test/DeliveryCopilot/api/jira/oauth/callback');
  assert.match(u.searchParams.get('scope'), /write:jira-work/); assert.match(u.searchParams.get('scope'), /offline_access/);
  const state = u.searchParams.get('state');

  // A tampered state is rejected; the real one connects, picking this dashboard's Jira site.
  await assert.rejects(oauth.callback('code', state.replace(/.$/, c => c === 'A' ? 'B' : 'A')), /not valid/);
  const r = await oauth.callback('code-1', state);
  assert.equal(r.user, 'zhangzhaoning');
  const st = oauth.status(user); assert.equal(st.connected, true); assert.equal(st.account.name, 'Zhaoning Zhang');
  const raw = fs.readFileSync(FILE, 'utf8'); assert.ok(!raw.includes('AT1') && !raw.includes('RT1'), 'tokens must be stored encrypted');
  assert.equal(JSON.parse(raw).byUser.zhangzhaoning.cloudId, 'cloud-1');
  assert.equal((fs.statSync(FILE).mode & 0o777).toString(8), '600');

  // Approve → written through Atlassian's gateway with the approver's own token.
  let res = await jira.apply({ kind: 'new_ticket', project: 'dayone', title: 't', detail: 'd' }, meeting, user);
  assert.equal(res.dryRun, false); assert.equal(res.createdKey, 'BA-7777'); assert.equal(res.as, 'Zhaoning Zhang');
  let w = calls.filter(c => c.url.includes('/ex/jira/')).pop();
  assert.equal(w.url, 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue'); assert.equal(w.auth, 'Bearer AT1');
  assert.equal(w.body.fields.reporter, undefined, 'no reporter override needed: the creator is the approver');

  // Expired access token → refreshed once (rotating refresh token kept), even with parallel calls.
  const db = JSON.parse(fs.readFileSync(FILE, 'utf8')); db.byUser.zhangzhaoning.expiresAt = Date.now() - 1; fs.writeFileSync(FILE, JSON.stringify(db));
  const before = calls.filter(c => c.body && c.body.grant_type === 'refresh_token').length;
  const [a, b] = await Promise.all([oauth.tokenFor(user), oauth.tokenFor(user)]);
  assert.equal(calls.filter(c => c.body && c.body.grant_type === 'refresh_token').length - before, 1, 'one refresh in flight');
  assert.equal(a.accessToken, 'AT2'); assert.equal(b.accessToken, 'AT2');
  assert.equal(calls.filter(c => c.body && c.body.grant_type === 'refresh_token').pop().body.refresh_token, 'RT1');
  assert.equal(oauth._open(JSON.parse(fs.readFileSync(FILE, 'utf8')).byUser.zhangzhaoning.refresh), 'RT2');

  // Background reads borrow a connected person's access when there is no shared account.
  assert.equal(jira.canRead(), true);

  // Revoked consent → connection dropped, approver asked to connect again.
  const db2 = JSON.parse(fs.readFileSync(FILE, 'utf8')); db2.byUser.zhangzhaoning.expiresAt = Date.now() - 1; fs.writeFileSync(FILE, JSON.stringify(db2));
  refreshFails = true;
  await assert.rejects(oauth.tokenFor(user), e => e.status === 428);
  assert.equal(oauth.status(user).connected, false);

  // Disconnect is idempotent.
  assert.equal(oauth.disconnect(user), false);
  console.log('per-person jira sign-in ok');
})().catch((e) => { console.error(e); process.exit(1); });
