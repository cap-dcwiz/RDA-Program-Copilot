/* Per-person Jira access through Atlassian OAuth 2.0 (3LO), so an approval is written to Jira as
   the person who approved it — their name on the comment, them as the ticket's reporter — instead
   of one shared account.

   Flow: the dashboard asks POST /api/jira/connect for a URL, the browser goes to Atlassian, the
   person consents once, and Atlassian redirects to GET /api/jira/oauth/callback. That request
   carries no dashboard token (it is a browser redirect), so the signed `state` is what ties it to
   the person who started it. Access tokens last an hour; the refresh token is rotating, so every
   refresh returns a new one that must replace the old, and two refreshes racing would burn it —
   hence one refresh in flight per person.

   Tokens are stored AES-256-GCM encrypted in data/jira-oauth.json (git-ignored, mode 600). The
   key comes from TOKEN_ENCRYPTION_KEY, or the client secret when that is unset. Reading the
   file alone does not give anyone Jira access. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfgAll = require('./config');
const cfg = cfgAll.atlassian;

const AUTH = 'https://auth.atlassian.com';
const API = 'https://api.atlassian.com';
const SCOPES = 'read:jira-work write:jira-work read:jira-user read:me offline_access';
const FILE = () => process.env.JIRA_OAUTH_FILE || path.join(cfgAll.DATA_DIR, 'jira-oauth.json');
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

const configured = () => !!(cfg.clientId && cfg.clientSecret);
const redirectUri = () => `${cfg.publicUrl.replace(/\/$/, '')}/api/jira/oauth/callback`;
const key = () => crypto.createHash('sha256').update(cfg.tokenKey || cfg.clientSecret || '').digest();

function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = String(sealed).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function load() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { byUser: {} }; } }
function save(db) {
  const f = FILE(), tmp = f + '.tmp';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const who = (user) => String(user && (user.username || user.id) || '').toLowerCase();

/* ---- state: who started the flow, signed so the callback can trust it ---- */
const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');
function makeState(user) {
  const body = b64u(JSON.stringify({ u: who(user), n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60000 }));
  return `${body}.${sign(body)}`;
}
function readState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac || mac.length !== sign(body).length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw err(400, 'This Jira sign-in link is not valid. Start again from the dashboard.');
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() > s.exp) throw err(400, 'This Jira sign-in link has expired. Start again from the dashboard.');
  return s;
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(err(502, `Atlassian ${res.status}: ${j.error_description || j.error || 'request failed'}`), { oauthError: j.error });
  return j;
}
async function get(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) throw err(502, `Atlassian ${res.status} on ${url.replace(API, '')}`);
  return res.json();
}

/* ---- the flow ---- */
function connectUrl(user) {
  if (!configured()) throw err(400, 'Per-person Jira sign-in is not set up on this server (ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET)');
  const q = new URLSearchParams({ audience: 'api.atlassian.com', client_id: cfg.clientId, scope: SCOPES, redirect_uri: redirectUri(),
    state: makeState(user), response_type: 'code', prompt: 'consent' });
  return `${AUTH}/authorize?${q}`;
}

async function callback(code, state) {
  const s = readState(state);
  if (!code) throw err(400, 'Atlassian did not return an authorisation code');
  const t = await post(`${AUTH}/oauth/token`, { grant_type: 'authorization_code', client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri() });
  // The person may have access to several Atlassian sites; use the one this dashboard writes to.
  const sites = await get(`${API}/oauth/token/accessible-resources`, t.access_token);
  const host = new URL(cfgAll.jira.baseUrl).host;
  const site = sites.find(x => { try { return new URL(x.url).host === host; } catch { return false; } });
  if (!site) throw err(403, `Your Atlassian account has no access to ${host}. Ask a Jira admin to add you, then connect again.`);
  const me = await get(`${API}/me`, t.access_token);
  const db = load();
  db.byUser[s.u] = { accountId: me.account_id, name: me.name || me.nickname, email: me.email || null, cloudId: site.id, siteUrl: site.url,
    access: seal(t.access_token), refresh: seal(t.refresh_token), expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    scope: t.scope, connectedAt: new Date().toISOString() };
  save(db);
  return { user: s.u, name: db.byUser[s.u].name };
}

const refreshing = new Map();
/** A usable access token for this person, refreshed if close to expiry. Throws 428 if they
    have not connected, or their consent was revoked / the refresh token expired. */
async function tokenFor(user) {
  const u = typeof user === 'string' ? user.toLowerCase() : who(user);
  const rec = load().byUser[u];
  if (!rec) throw err(428, 'Connect your Jira account first, so this is written to Jira as you.', 'jira_connect_required');
  if (rec.expiresAt - 60000 > Date.now()) return { accessToken: open(rec.access), cloudId: rec.cloudId, accountId: rec.accountId, name: rec.name };
  if (!refreshing.has(u)) refreshing.set(u, (async () => {
    try {
      const t = await post(`${AUTH}/oauth/token`, { grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: open(rec.refresh) });
      const db = load(); const cur = db.byUser[u]; if (!cur) throw err(428, 'Connect your Jira account first.', 'jira_connect_required');
      cur.access = seal(t.access_token); if (t.refresh_token) cur.refresh = seal(t.refresh_token);
      cur.expiresAt = Date.now() + (t.expires_in || 3600) * 1000; save(db);
    } catch (e) {
      if (e.oauthError === 'invalid_grant' || e.oauthError === 'unauthorized_client') {
        const db = load(); delete db.byUser[u]; save(db);
        throw err(428, 'Your Jira connection has expired or was revoked. Connect again.', 'jira_connect_required');
      }
      throw e;
    } finally { refreshing.delete(u); }
  })());
  await refreshing.get(u);
  const rec2 = load().byUser[u];
  return { accessToken: open(rec2.access), cloudId: rec2.cloudId, accountId: rec2.accountId, name: rec2.name };
}

function status(user) {
  const rec = load().byUser[who(user)];
  return { configured: configured(), connected: !!rec, account: rec ? { name: rec.name, email: rec.email, site: rec.siteUrl, connectedAt: rec.connectedAt } : null };
}
function disconnect(user) { const db = load(); const had = !!db.byUser[who(user)]; delete db.byUser[who(user)]; save(db); return had; }

/* Background reads (nightly Jira sync, open-ticket context for analysis) have no approver. With
   no shared JIRA_EMAIL account they borrow a connected person's access: JIRA_SYNC_AS, or else
   whoever connected most recently. */
function backgroundUser() {
  const all = load().byUser;
  if (cfgAll.jira.syncAs && all[cfgAll.jira.syncAs.toLowerCase()]) return cfgAll.jira.syncAs.toLowerCase();
  return Object.entries(all).sort((a, b) => String(b[1].connectedAt).localeCompare(String(a[1].connectedAt))).map(([k]) => k)[0] || null;
}

module.exports = { configured, connectUrl, callback, tokenFor, status, disconnect, backgroundUser, redirectUri, SCOPES, _seal: seal, _open: open };
