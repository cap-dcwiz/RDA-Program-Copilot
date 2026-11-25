/* Approve meeting to-dos from a Microsoft Teams group chat, as Luna.

   Every new suggestion from a meeting is posted to one registered Teams chat as an Adaptive Card
   with Approve / Reject. A click comes back here as a Bot Framework activity; if the person who
   clicked is on TEAMS_APPROVERS, the suggestion is decided exactly as the web page would decide it
   (agent.decide → Jira write) and the card is replaced by the result. Deciding on the web page
   updates the card too, so the chat never shows a stale Approve button.

   No SDK: two Bot Framework calls are all this needs.
     inbound  — POST /api/teams/messages. The bearer token is a JWT signed by the Bot Framework;
                it is verified here (RS256 against the published keys, issuer, audience = our App
                ID, expiry, serviceUrl claim, channel endorsement) before anything is read.
     outbound — an app token from Microsoft Entra (client credentials), then the Bot Connector
                REST API at the serviceUrl captured from a verified activity.

   Setup (once): an Azure Bot whose messaging endpoint is <dashboard URL>/api/teams/messages,
   TEAMS_APP_ID / TEAMS_APP_PASSWORD / TEAMS_TENANT_ID / TEAMS_APPROVERS in .env, the Teams app
   (teams/manifest.json) added to the chat, then an approver sends "@Luna register" in it. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfgAll = require('./config');
const cfg = cfgAll.teams;

const FILE = () => path.join(cfgAll.DATA_DIR, 'teams.json');
const OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const ISSUER = 'https://api.botframework.com';
const SKEW = 300;   // seconds of clock skew tolerated on nbf/exp

const configured = () => !!(cfg.appId && cfg.password);
let state = null;
const load = () => { if (!state) { try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { state = { conversation: null, cards: {} }; } } return state; };
const save = () => { const t = FILE() + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1)); fs.renameSync(t, FILE()); };
const registered = () => !!load().conversation;

/* ---------- inbound: verify the Bot Framework token ---------- */
let keyCache = { keys: [], at: 0 };
async function signingKeys(force) {
  if (!force && keyCache.keys.length && Date.now() - keyCache.at < 12 * 3600e3) return keyCache.keys;
  const oc = await (await fetch(OPENID)).json();
  const j = await (await fetch(oc.jwks_uri)).json();
  keyCache = { keys: j.keys || [], at: Date.now() };
  return keyCache.keys;
}
const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const deny = (why) => Object.assign(new Error(`Teams request rejected: ${why}`), { status: 401 });

async function verify(authorization, activity) {
  if (!configured()) throw deny('Teams is not configured');
  const tok = String(authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!tok) throw deny('no bearer token');
  const parts = tok[1].split('.');
  if (parts.length !== 3) throw deny('malformed token');
  let head, claims;
  try { head = JSON.parse(b64u(parts[0])); claims = JSON.parse(b64u(parts[1])); } catch { throw deny('malformed token'); }
  if (head.alg !== 'RS256') throw deny('unexpected algorithm');
  let key = (await signingKeys()).find(k => k.kid === head.kid);
  if (!key) key = (await signingKeys(true)).find(k => k.kid === head.kid);   // keys rotate
  if (!key) throw deny('unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: 'jwk' }), b64u(parts[2]));
  if (!ok) throw deny('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw deny('wrong issuer');
  if (claims.aud !== cfg.appId) throw deny('wrong audience');
  if (!claims.exp || now > claims.exp + SKEW) throw deny('expired');
  if (claims.nbf && now < claims.nbf - SKEW) throw deny('not yet valid');
  if (activity.serviceUrl && claims.serviceUrl && claims.serviceUrl !== activity.serviceUrl) throw deny('serviceUrl mismatch');
  if (Array.isArray(key.endorsements) && activity.channelId && !key.endorsements.includes(activity.channelId)) throw deny('channel not endorsed');
  if (activity.channelId !== 'msteams') throw deny('not a Teams activity');
}

/* ---------- outbound: app token + Bot Connector ---------- */
let appToken = { value: null, exp: 0 };
async function token() {
  if (appToken.value && Date.now() < appToken.exp - 60e3) return appToken.value;
  const tenant = /single/i.test(cfg.appType) ? cfg.tenantId : 'botframework.com';
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.appId, client_secret: cfg.password, scope: 'https://api.botframework.com/.default' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Teams sign-in failed: ${j.error_description || j.error || r.status}`);
  appToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return appToken.value;
}
async function connector(method, conv, suffix, body) {
  const base = conv.serviceUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/v3/conversations/${encodeURIComponent(conv.id)}${suffix}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Teams ${method} ${suffix || '/'} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const cardActivity = (card) => ({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] });
const textActivity = (text) => ({ type: 'message', text });

/* ---------- cards ---------- */
const KIND = { comment: '评论到 Comment on', new_ticket: '新建任务 New task', due_date: '改截止日期 Due date', status: '改状态 Status' };
const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function pendingCard(s, m) {
  const facts = [
    { title: '项目 Project', value: s.project || '—' },
    ...(s.owner ? [{ title: '负责人 Owner', value: s.owner }] : []),
    ...(s.newDueDate ? [{ title: '截止 Due', value: s.newDueDate }] : []),
    { title: '会议 Meeting', value: `${m.title || ''} · ${String(m.date || '').slice(0, 10)}` },
  ];
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [
      { type: 'TextBlock', text: `${KIND[s.kind] || s.kind}${s.jiraKey ? ` ${s.jiraKey}` : ''}`, isSubtle: true, size: 'Small', wrap: true },
      { type: 'TextBlock', text: short(s.title, 200), weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: short(s.detail, 900), wrap: true },
      { type: 'FactSet', facts },
      ...(s.evidence ? [{ type: 'TextBlock', text: `纪要原文：“${short(s.evidence, 300)}”`, isSubtle: true, wrap: true, size: 'Small' }] : []),
      { type: 'Input.Text', id: 'reason', placeholder: '驳回原因（驳回时必填）Reason, required to reject', isMultiline: true },
    ],
    actions: [
      { type: 'Action.Submit', title: '批准 Approve', style: 'positive', data: { verb: 'pmc-approve', id: s.id } },
      { type: 'Action.Submit', title: '驳回 Reject', style: 'destructive', data: { verb: 'pmc-reject', id: s.id } },
      ...(cfg.dashboardUrl ? [{ type: 'Action.OpenUrl', title: '在 Copilot 查看', url: cfg.dashboardUrl }] : []),
    ],
  };
}
function decidedCard(s) {
  const when = String(s.decidedAt || '').replace('T', ' ').slice(0, 16);
  const ok = s.status === 'approved';
  const where = ok && s.jira ? (s.jira.dryRun ? '演练模式，未写入 Jira (dry run)' : `已写入 Jira ${s.jira.createdKey || s.jiraKey || ''}`) : '';
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [
      { type: 'TextBlock', text: `${KIND[s.kind] || s.kind}${s.jiraKey ? ` ${s.jiraKey}` : ''}`, isSubtle: true, size: 'Small', wrap: true },
      { type: 'TextBlock', text: short(s.title, 200), weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: `${ok ? '✅ 已批准 Approved' : '❌ 已驳回 Rejected'} · ${s.decidedBy || ''} · ${when} UTC`, color: ok ? 'Good' : 'Attention', wrap: true },
      ...(where ? [{ type: 'TextBlock', text: where, isSubtle: true, wrap: true }] : []),
      ...(!ok && s.rejectReason ? [{ type: 'TextBlock', text: `原因 Reason: ${short(s.rejectReason, 300)}`, isSubtle: true, wrap: true }] : []),
    ],
    actions: ok && s.jira && s.jira.url ? [{ type: 'Action.OpenUrl', title: '打开 Jira', url: s.jira.url }] : [],
  };
}

/* ---------- posting ---------- */
const wanted = (s) => s.status === 'pending' && (!cfg.projects.length || cfg.projects.includes(s.project));

/* New suggestions from a meeting → one card each. Failures are logged, never thrown: Teams being
   down must not fail a Granola sync. */
async function postSuggestions(list, meeting) {
  if (!configured() || !registered()) return { posted: 0 };
  const st = load(); let posted = 0;
  for (const s of list.filter(wanted)) {
    if (st.cards[s.id]) continue;
    try { const r = await connector('POST', st.conversation, '/activities', cardActivity(pendingCard(s, meeting))); st.cards[s.id] = r.id; posted++; }
    catch (e) { console.warn('[teams] post failed:', e.message); break; }
  }
  if (posted) save();
  return { posted };
}

/* A suggestion was decided (here or on the web page): replace its card with the result. */
async function cardDecided(s) {
  if (!configured() || !registered()) return;
  const st = load(), activityId = st.cards[s.id];
  if (!activityId) return;
  try { await connector('PUT', st.conversation, `/activities/${encodeURIComponent(activityId)}`, { ...cardActivity(decidedCard(s)), id: activityId }); }
  catch (e) { console.warn('[teams] card update failed:', e.message); }
}

/* ---------- handling a verified activity ---------- */
const lower = (x) => String(x || '').trim().toLowerCase();
async function member(conv, userId) {
  try { return await connector('GET', conv, `/members/${encodeURIComponent(userId)}`); } catch { return null; }
}
const reply = (conv, a, text) => connector('POST', conv, `/activities/${encodeURIComponent(a.id)}`, { ...textActivity(text), replyToId: a.id }).catch(e => console.warn('[teams] reply failed:', e.message));
const convOf = (a) => ({ serviceUrl: a.serviceUrl, id: a.conversation && a.conversation.id, tenantId: a.conversation && a.conversation.tenantId, type: a.conversation && a.conversation.conversationType });

/* `deps` = { decide, store } from the server, so this module never requires agent.js. */
async function handle(a, deps) {
  const conv = convOf(a);
  if (a.type === 'conversationUpdate' && (a.membersAdded || []).some(m => m.id === (a.recipient && a.recipient.id))) {
    return reply(conv, a, 'Luna 已加入。审批人请发送「@Luna register」，之后会议待办会发到这里，可直接批准或驳回。');
  }
  if (a.type !== 'message') return;

  // Who is acting: the roster gives their email / UPN, which is what TEAMS_APPROVERS lists.
  const who = await member(conv, a.from && a.from.id) || {};
  const email = lower(who.email || who.userPrincipalName);
  const isApprover = !!email && cfg.approvers.includes(email);
  const name = who.name || (a.from && a.from.name) || email || 'Teams user';

  const v = a.value || {};
  if (v.verb === 'pmc-approve' || v.verb === 'pmc-reject') {
    const db = deps.store.load(), s = db.suggestions.find(x => x.id === v.id);
    if (!registered() || lower(conv.id) !== lower(load().conversation.id)) return reply(conv, a, '这个聊天还没有登记为审批群。');
    if (!isApprover) return reply(conv, a, `${name}：你不在审批人名单里，这次操作没有执行。`);
    if (!s) return reply(conv, a, '找不到这条待办，可能已被重新分析替换。');
    if (s.status !== 'pending') { await cardDecided(s); return; }
    const reason = String(v.reason || '').trim();
    if (v.verb === 'pmc-reject' && !reason) return reply(conv, a, `${name}：驳回需要填写原因。`);
    const user = { name, displayName: name, email, via: 'teams' };
    try {
      const out = await deps.decide(s.id, v.verb === 'pmc-approve' ? 'approve' : 'reject', user, { reason });
      await cardDecided(out);   // decide() also calls this; doing it here keeps the click responsive
    } catch (e) {
      if (e.status === 409) { await cardDecided(deps.store.load().suggestions.find(x => x.id === s.id)); return; }
      return reply(conv, a, `执行失败：${short(e.message, 300)}`);
    }
    return;
  }

  const text = lower(String(a.text || '').replace(/<at>[^<]*<\/at>/gi, ''));
  if (/^register\b/.test(text)) {
    if (!isApprover) return reply(conv, a, `${name}：只有审批人可以登记审批群。`);
    load().conversation = { ...conv, registeredBy: name, registeredAt: new Date().toISOString() }; save();
    return reply(conv, a, '已登记：之后的会议待办会发到这个群。发送「@Luna pending」可补发当前待审批的事项。');
  }
  if (/^pending\b/.test(text)) {
    if (!isApprover) return reply(conv, a, `${name}：只有审批人可以补发待办。`);
    if (!registered() || lower(conv.id) !== lower(load().conversation.id)) return reply(conv, a, '请先在这个群发送「@Luna register」。');
    const db = deps.store.load();
    const list = db.suggestions.filter(wanted).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, cfg.backlogLimit);
    let n = 0;
    for (const s of list) { const m = db.meetings.find(x => x.id === s.meetingId) || {}; n += (await postSuggestions([s], m)).posted; }
    return reply(conv, a, n ? `已补发 ${n} 条待审批事项。` : '没有需要补发的待审批事项。');
  }
  return reply(conv, a, '可用命令：「@Luna register」登记本群为审批群；「@Luna pending」补发待审批事项。');
}

module.exports = { configured, registered, verify, handle, postSuggestions, cardDecided, pendingCard, decidedCard, _reset: () => { state = null; keyCache = { keys: [], at: 0 }; appToken = { value: null, exp: 0 }; } };
