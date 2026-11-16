/* The delivery projects, as the PMs define them in Jira: one saved filter per project, each a
   `"client[dropdown]" = "<client>"` query (DayOne NTP-E, BDC MY2, …). A new filter is a new project
   here: the analysis can file suggestions under it and a new ticket gets that client value, so it
   shows up in the filter. Nothing to change in this code or its config.

   Read with the shared JIRA_EMAIL account through /rest/api/3/filter/search, which returns every
   filter that account can see. A filter someone keeps private is invisible to it — share it with
   the BA project (or "everyone in the organisation") and it appears on the next refresh: at start-up,
   on every Jira sync (nightly and "Sync now"). JIRA_FILTER_OWNERS narrows it to filters owned by the
   named people, so a personal "my bugs on DayOne" view does not become a project.

   Without credentials, or before the first refresh, the built-in list (config CLIENT_OPTIONS) is used. */
const fs = require('fs');
const path = require('path');
const cfgAll = require('./config');
const cfg = cfgAll.jira;

const FILE = () => path.join(cfgAll.DATA_DIR, 'jira-filters.json');
const norm = (s) => String(s || '').trim().toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* The client a filter selects: `"client[dropdown]" = "X"`, `client = X`, or `cf[10034] = "X"`.
   Only a plain equality counts; `!=`, `in (…)` and queries without one are not project filters. */
function clientOf(jql) {
  const num = String(cfg.clientField).replace(/^customfield_/, '');
  const field = `(?:"client\\[dropdown\\]"|client\\[dropdown\\]|"client"|client|cf\\[${num}\\])`;
  const m = String(jql || '').match(new RegExp(`(?:^|[\\s(])${field}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s)]+))`, 'i'));
  return m ? (m[1] || m[2] || m[3]).trim() : null;
}

function builtin() {
  return Object.entries(cfgAll.CLIENT_OPTIONS).map(([id, o]) => ({ id, label: o.label, optionId: o.id, source: 'builtin' }));
}

/* Built-in ids stay stable (stored suggestions and the portfolio use them): a filter whose client
   starts with a built-in label ("BDx SIN1-Chiller Plant" ⊇ "BDx SIN1") takes that id. */
function merge(filters) {
  const base = builtin(), out = [];
  for (const f of filters) {
    const b = base.find(x => norm(f.client) === norm(x.label)) || base.find(x => norm(f.client).startsWith(norm(x.label)));
    const id = b ? b.id : slug(f.client);
    if (out.some(x => x.id === id)) continue;                 // two filters on one client: the first wins
    out.push({ id, label: f.client, client: f.client, optionId: b && norm(b.label) === norm(f.client) ? b.optionId : null,
      filterId: f.id, filterName: f.name, owner: f.owner, source: 'filter' });
  }
  for (const b of base) if (!out.some(x => x.id === b.id)) out.push(b);
  return out;
}

let state = null;
function load() {
  if (!state) { try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { state = { filters: [] }; } }
  return state;
}
const list = () => merge(load().filters || []);
const byId = (id) => list().find(p => p.id === id) || null;
const byClient = (client) => { const c = norm(client); return list().find(p => norm(p.client || p.label) === c) || list().find(p => c.startsWith(norm(p.label))) || null; };

/* `call` is jira.js's authenticated request, passed in to keep the two modules from requiring each other. */
async function refresh(call) {
  const owners = cfg.filterOwners.map(norm);
  const seen = []; let startAt = 0, total = 0, n = 0;
  do {
    const q = new URLSearchParams({ expand: 'jql,owner', maxResults: '100', startAt: String(startAt), orderBy: 'name' });
    const r = await call('GET', `/rest/api/3/filter/search?${q}`);
    for (const f of r.values || []) {
      const client = clientOf(f.jql); if (!client) continue;
      const o = f.owner || {};
      if (owners.length && !owners.includes(norm(o.accountId)) && !owners.includes(norm(o.displayName))) continue;
      seen.push({ id: f.id, name: f.name, client, owner: o.displayName || o.accountId || null, jql: f.jql });
    }
    n = (r.values || []).length; total = r.total || 0; startAt += n;
  } while (n && startAt < total);
  state = { refreshedAt: new Date().toISOString(), filters: seen };
  const t = FILE() + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1)); fs.renameSync(t, FILE());
  return { filters: seen.length, projects: list().length };
}

/* For the analysis prompt: "dayone (DayOne NTP-E), bdc (BDC MY2), …". */
const promptList = () => list().map(p => `${p.id} (${p.label})`).join(', ');

module.exports = { list, byId, byClient, refresh, promptList, clientOf, merge, refreshedAt: () => load().refreshedAt || null };
