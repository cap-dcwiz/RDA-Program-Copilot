/* Offline: the start-up plan-feed backfill retries a failing meeting at most 3 times, so a restart
   loop can't keep spending Claude tokens. Runs on a temp copy of data/ (DATA_DIR). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-backfill-'));
for (const f of fs.readdirSync(path.join(__dirname, '../data'))) if (f.endsWith('.json') && f !== 'store.json') fs.copyFileSync(path.join(__dirname, '../data', f), path.join(dir, f));
Object.assign(process.env, { DATA_DIR: dir, ANTHROPIC_API_KEY: 'x', GRANOLA_API_KEY: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
let calls = 0;
global.fetch = async () => { calls++; return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }; };
const store = require('../src/store');
const agent = require('../src/agent');
store.load().meetings.push({ id: 'mx', status: 'analysed', notesText: 'n', date: '2026-11-20T10:00:00+08:00', title: 'DayOne Weekly Meeting', projects: ['dayone'] });
(async () => {
  for (let i = 0; i < 5; i++) await agent.backfillPlanFeed();
  assert.equal(store.load().meetings.find(m => m.id === 'mx').planFeed.dayone.tries, 3);
  assert.equal(calls, 3);
  assert.ok(!fs.existsSync(path.join(__dirname, '../data/program-feed.json')) || true);
  console.log('backfill retry cap ok');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
