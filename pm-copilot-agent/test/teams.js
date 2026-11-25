/* Offline: Teams approval. A locally generated RSA key stands in for the Bot Framework's signing
   key; fetch is stubbed for its key set, the Entra token and the Bot Connector. Checks the token
   checks, then register → card posted → approve / reject / non-approver → card replaced. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
Object.assign(process.env, { TEAMS_APP_ID: 'app-123', TEAMS_APP_PASSWORD: 'secret', TEAMS_TENANT_ID: 'tenant-1', TEAMS_APP_TYPE: 'SingleTenant',
  TEAMS_APPROVERS: 'selena.zhang@rda.ai,sherry.liu@rda.ai', TEAMS_PROJECTS: 'dayone' });
const cfg = require('../src/config');
const FILE = path.join(cfg.DATA_DIR, 'teams.json');
const had = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
fs.rmSync(FILE, { force: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', endorsements: ['msteams'] };
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const SU = 'https://smba.trafficmanager.net/apac/';
function jwt(claims, { alg = 'RS256', kid = 'k1', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg, kid, typ: 'JWT' }), p = b64u({ iss: 'https://api.botframework.com', aud: 'app-123', exp: now + 600, nbf: now - 10, serviceUrl: SU, ...claims });
  return `Bearer ${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}

const posted = [], updated = [], replies = [];
const roster = { 'u-selena': { name: 'Selena Zhang', email: 'selena.zhang@rda.ai' }, 'u-bob': { name: 'Bob', email: 'bob@rda.ai' } };
global.fetch = async (url, o = {}) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('openidconfiguration')) return ok({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' });
  if (url.endsWith('/.well-known/keys')) return ok({ keys: [jwk] });
  if (url.includes('login.microsoftonline.com/tenant-1/')) return ok({ access_token: 'tok', expires_in: 3600 });
  assert.ok(url.startsWith(SU.replace(/\/$/, '') + '/v3/conversations/'), url);
  assert.equal(o.headers.Authorization, 'Bearer tok');
  const mm = url.match(/\/members\/([^/]+)$/); if (mm) return roster[decodeURIComponent(mm[1])] ? ok(roster[decodeURIComponent(mm[1])]) : { ok: false, status: 404, text: async () => '' };
  const body = JSON.parse(o.body || '{}');
  if (o.method === 'PUT') { updated.push(body); return ok({ id: 'x' }); }
  if (/\/activities\/[^/]+$/.test(url)) { replies.push(body.text); return ok({ id: 'r' }); }
  posted.push(body); return ok({ id: `card-${posted.length}` });
};
const teams = require('../src/teams');
teams._reset();

const conv = { id: '19:chat@thread.v2', conversationType: 'groupChat', tenantId: 'tenant-1' };
const act = (from, extra) => ({ type: 'message', id: 'a1', channelId: 'msteams', serviceUrl: SU, conversation: conv, from: { id: from }, recipient: { id: 'bot' }, ...extra });
const db = { suggestions: [
  { id: 's1', status: 'pending', kind: 'comment', jiraKey: 'BA-2447', project: 'dayone', title: 'Ground floor validated', detail: 'd', meetingId: 'm1', createdAt: '2026-11-20' },
  { id: 's2', status: 'pending', kind: 'new_ticket', project: 'dayone', title: 'Baseline plan', detail: 'd', meetingId: 'm1', createdAt: '2026-11-20' },
  { id: 's3', status: 'pending', kind: 'comment', jiraKey: 'BA-1', project: 'bdc', title: 'Other project', detail: 'd', meetingId: 'm1', createdAt: '2026-11-20' } ],
  meetings: [{ id: 'm1', title: 'DayOne NTP-E Weekly Meeting', date: '2026-11-20T09:30:00+08:00' }] };
const store = { load: () => db };
const decisions = [];
const decide = async (id, d, user, extra) => { const s = db.suggestions.find(x => x.id === id); decisions.push([id, d, user.name, user.via]);
  Object.assign(s, { status: d === 'approve' ? 'approved' : 'rejected', decidedBy: user.name, decidedAt: '2026-11-25T10:00:00Z', rejectReason: extra.reason,
    jira: d === 'approve' ? { dryRun: false, url: 'https://projects-teams.atlassian.net/browse/BA-2447' } : undefined }); return s; };
const deps = { decide, store };

(async () => {
  try {
    // 1. Token checks.
    const a = act('u-selena', { text: 'hi' });
    await teams.verify(jwt({}), a);
    for (const [why, auth] of [['no token', ''], ['wrong audience', jwt({ aud: 'other' })], ['wrong issuer', jwt({ iss: 'https://evil' })],
      ['expired', jwt({ exp: Math.floor(Date.now() / 1000) - 3600 })], ['serviceUrl', jwt({ serviceUrl: 'https://evil/' })],
      ['bad signature', jwt({}, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })], ['unknown key', jwt({}, { kid: 'nope' })]]) {
      await assert.rejects(teams.verify(auth, a), (e) => e.status === 401, why);
    }
    await assert.rejects(teams.verify(jwt({}), { ...a, channelId: 'webchat' }), (e) => e.status === 401, 'non-Teams channel');

    // 2. Only an approver can register the chat; then "pending" posts this project's to-dos only.
    await teams.handle(act('u-bob', { text: '<at>Luna</at> register' }), deps);
    assert.equal(teams.registered(), false); assert.match(replies.pop(), /只有审批人/);
    await teams.handle(act('u-selena', { text: '<at>Luna</at> register' }), deps);
    assert.equal(teams.registered(), true);
    await teams.handle(act('u-selena', { text: '<at>Luna</at> pending' }), deps);
    assert.equal(posted.length, 2);                                   // s3 is another project
    assert.match(JSON.stringify(posted[0]), /pmc-approve/);
    await teams.handle(act('u-selena', { text: 'pending' }), deps);
    assert.equal(posted.length, 2);                                   // not posted twice

    // 3. A non-approver's click does nothing.
    await teams.handle(act('u-bob', { value: { verb: 'pmc-approve', id: 's1' }, replyToId: 'card-1' }), deps);
    assert.equal(decisions.length, 0); assert.match(replies.pop(), /不在审批人名单/);

    // 4. Approve → decided as the Teams user, card replaced with the result.
    await teams.handle(act('u-selena', { value: { verb: 'pmc-approve', id: 's1' }, replyToId: 'card-1' }), deps);
    assert.deepEqual(decisions.pop(), ['s1', 'approve', 'Selena Zhang', 'teams']);
    assert.match(JSON.stringify(updated.pop()), /已批准 Approved · Selena Zhang/);

    // 5. Reject needs a reason.
    await teams.handle(act('u-selena', { value: { verb: 'pmc-reject', id: 's2' } }), deps);
    assert.equal(decisions.length, 0); assert.match(replies.pop(), /驳回需要填写原因/);
    await teams.handle(act('u-selena', { value: { verb: 'pmc-reject', id: 's2', reason: 'Duplicate' } }), deps);
    assert.deepEqual(decisions.pop(), ['s2', 'reject', 'Selena Zhang', 'teams']);
    assert.match(JSON.stringify(updated.pop()), /已驳回 Rejected[\s\S]*Duplicate/);

    // 6. Clicking an already-decided card just refreshes it.
    await teams.handle(act('u-selena', { value: { verb: 'pmc-approve', id: 's1' } }), deps);
    assert.equal(decisions.length, 0); assert.ok(updated.length === 1);
    console.log('teams approval ok');
  } finally { if (had) fs.writeFileSync(FILE, had); else fs.rmSync(FILE, { force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
