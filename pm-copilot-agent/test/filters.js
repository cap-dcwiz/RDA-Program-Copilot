/* Offline: projects from Jira saved filters, new tasks land in their filter, comments @mention the
   assignee. fetch is stubbed with the site's real filter list (Nov 2026) plus one new private-looking one. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
Object.assign(process.env, { JIRA_EMAIL: 'bot@rda.ai', JIRA_API_TOKEN: 'x', JIRA_DRY_RUN: 'false', JIRA_FILTER_OWNERS: '' });
const cfg = require('../src/config');
const FILE = path.join(cfg.DATA_DIR, 'jira-filters.json');
const had = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;

const F = (id, name, jql, owner = 'Selena') => ({ id, name, jql, owner: { displayName: owner, accountId: 'acc-' + owner } });
let filters = [
  F('10357', 'Active work', 'project = BA ORDER BY component ASC', 'Joey Wong'),
  F('10499', 'BDC MY2', 'project = "BA" AND "client[dropdown]" = "BDC MY2" ORDER BY created DESC'),
  F('10496', 'BDx SIN1-Chiller Plant', '"client[dropdown]" = "BDx SIN1-Chiller Plant" ORDER BY created DESC'),
  F('10498', 'CMI-DE1-Germany', 'project = "BA" AND "client[dropdown]" = CMI-DE1-Germany ORDER BY created DESC'),
  F('10501', 'CMI-SGDC', 'project = "BA" AND "client[dropdown]" = CMI-SGDC ORDER BY created DESC'),
  F('10495', 'DayOne NTP-E', '"client[dropdown]" = "DayOne NTP-E" ORDER BY created DESC'),
  F('10427', 'In Progress Project Tasks', 'type = Task AND "client[dropdown]" != RDA AND status = Done', 'Zhu Zhaomeng'),
  F('10497', 'Iron Mountain', 'project = "BA" AND "client[dropdown]" = "Iron Mountain SIN1" ORDER BY created DESC'),
  F('10500', 'PCE - CFD Simulation', 'project = "BA" AND "client[dropdown]" = "PCE-CFD Simulation" ORDER BY created DESC'),
];
const calls = [];
global.fetch = async (url, o = {}) => {
  const body = o.body ? JSON.parse(o.body) : null; calls.push({ url, method: o.method, body });
  const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  if (url.includes('/filter/search')) return ok({ startAt: 0, total: filters.length, values: filters });
  if (/\/issue\/BA-2380\?fields=assignee/.test(url)) return ok({ fields: { assignee: { accountId: 'acc-valdy', displayName: 'Valdy Lionel Christian' } } });
  if (/\/issue\/BA-1\?fields=assignee/.test(url)) return ok({ fields: { assignee: null } });
  if (url.endsWith('/rest/api/3/issue')) return ok({ key: 'BA-9999' });
  if (url.includes('/user/search')) return ok([]);
  return ok({});
};
const projects = require('../src/projects');
const jira = require('../src/jira');
const m = { title: 'Project implement 1116', date: '2026-11-16T10:00:00+08:00' };
const me = { username: 'zhangzhaoning', displayName: 'zhangzhaoning', email: 'zz@gmail.com' };
const lastCreate = () => calls.filter(c => c.url.endsWith('/rest/api/3/issue')).pop().body.fields;

(async () => {
  // 1. Parsing: only plain equalities on the client field are project filters.
  assert.equal(projects.clientOf('"client[dropdown]" = "DayOne NTP-E" ORDER BY created'), 'DayOne NTP-E');
  assert.equal(projects.clientOf('project = "BA" AND "client[dropdown]" = CMI-SGDC ORDER BY x'), 'CMI-SGDC');
  assert.equal(projects.clientOf('cf[10034] = "BDC MY2"'), 'BDC MY2');
  assert.equal(projects.clientOf('"client[dropdown]" != RDA'), null);
  assert.equal(projects.clientOf('project = BA'), null);

  // 2. Refresh: 7 project filters; built-in ids kept, the new PCE filter becomes a project of its own.
  const r = await jira.refreshProjects();
  assert.equal(r.filters, 7);
  const ids = projects.list().map(p => p.id);
  for (const id of ['dayone', 'bdc', 'bdx', 'cmide', 'cmisg', 'imdc', 'pce-cfd-simulation']) assert.ok(ids.includes(id), id);
  assert.equal(projects.byId('bdx').client, 'BDx SIN1-Chiller Plant');
  assert.equal(projects.byClient('Iron Mountain SIN1').id, 'imdc');

  // 3. New task under a filter-only project: Task type, client value = the filter's, content in the description.
  let res = await jira.apply({ kind: 'new_ticket', project: 'pce-cfd-simulation', title: 'Send CFD mesh', detail: 'Mesh to PCE by Friday.' }, m, me);
  let f = lastCreate();
  assert.equal(res.createdKey, 'BA-9999'); assert.equal(f.issuetype.id, '10006');
  assert.deepEqual(f[cfg.jira.clientField], { value: 'PCE-CFD Simulation' });
  assert.match(JSON.stringify(f.description), /Mesh to PCE by Friday\./);
  // Built-in project whose filter value matches the label exactly keeps the option id.
  await jira.apply({ kind: 'new_ticket', project: 'dayone', title: 't', detail: 'd' }, m, me);
  assert.deepEqual(lastCreate()[cfg.jira.clientField], { id: '10152' });
  // Label differs from the filter ("BDx SIN1" vs "BDx SIN1-Chiller Plant") → sent by value.
  await jira.apply({ kind: 'new_ticket', project: 'bdx', title: 't', detail: 'd' }, m, me);
  assert.deepEqual(lastCreate()[cfg.jira.clientField], { value: 'BDx SIN1-Chiller Plant' });

  // 4. Existing ticket: comment starts with an @mention of the assignee.
  res = await jira.apply({ kind: 'comment', jiraKey: 'BA-2380', detail: 'Three models being merged.' }, m, me);
  const c = calls.filter(x => x.url.endsWith('/issue/BA-2380/comment')).pop().body.body.content[0].content;
  assert.deepEqual(c[0], { type: 'mention', attrs: { id: 'acc-valdy', text: '@Valdy Lionel Christian' } });
  assert.match(c[2].text, /Three models being merged\./); assert.equal(res.mentioned, 'Valdy Lionel Christian');
  // Unassigned ticket: plain comment, no mention.
  await jira.apply({ kind: 'comment', jiraKey: 'BA-1', detail: 'x' }, m, me);
  assert.equal(calls.filter(x => x.url.endsWith('/issue/BA-1/comment')).pop().body.body.content[0].content[0].type, 'text');

  // 5. A new filter Sherry shares shows up on the next refresh; JIRA_FILTER_OWNERS can restrict to PMs.
  filters.push(F('10600', 'Equinix SG5', '"client[dropdown]" = "Equinix SG5"', 'Sherry'));
  await jira.refreshProjects();
  assert.ok(projects.byId('equinix-sg5'));
  cfg.jira.filterOwners = ['Sherry'];
  await jira.refreshProjects();
  assert.deepEqual(projects.list().filter(p => p.source === 'filter').map(p => p.id), ['equinix-sg5']);
  console.log('project filters ok');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (had) fs.writeFileSync(FILE, had); else fs.rmSync(FILE, { force: true }); });
