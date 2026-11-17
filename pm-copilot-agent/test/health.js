/* GET /api/health is the one route before the sign-in gate, because the sign-in screen itself
   reads it. This asserts that what it hands an anonymous caller is operational status and nothing
   about who we work for. It starts the real server on a free port with no credentials configured,
   so projects.list() falls back to the built-in client list — the names this test looks for are
   therefore present in the process and genuinely withheld, not merely absent. */
const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const AGENT = path.join(__dirname, '..');
const CLIENTS = require(path.join(AGENT, 'src/config')).CLIENT_OPTIONS;
const names = Object.values(CLIENTS).map(o => o.label).filter(Boolean);
assert.ok(names.length >= 3, 'expected built-in client labels to assert against');

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const get = (port, p, headers = {}) => new Promise((res, rej) => {
  const r = http.get({ host: '127.0.0.1', port, path: p, headers }, (x) => {
    let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej); r.setTimeout(5000, () => { r.destroy(new Error('timeout')); });
});

(async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-health-'));
  for (const f of fs.readdirSync(path.join(AGENT, 'data'))) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(AGENT, 'data', f), path.join(dir, f));
  }
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir,
    // No outbound credentials: nothing in this test reaches the network.
    ANTHROPIC_API_KEY: '', GRANOLA_API_KEY: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' };
  const srv = spawn(process.execPath, [path.join(AGENT, 'src/server.js')], { env, stdio: 'ignore' });
  const stop = () => { try { srv.kill(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  process.on('exit', stop);

  let r = null;
  for (let i = 0; i < 40 && !r; i++) {
    try { r = await get(port, '/api/health'); } catch { await new Promise(s => setTimeout(s, 150)); }
  }
  assert.ok(r, 'the agent never answered /api/health');
  assert.equal(r.status, 200, 'anonymous /api/health must stay reachable: the sign-in screen needs it');

  const h = JSON.parse(r.body);
  // Status the sign-in screen and a monitor legitimately need.
  for (const k of ['ok', 'model', 'signIn', 'jiraCredentials', 'jiraDryRun']) {
    assert.ok(k in h, `anonymous /api/health should still report ${k}`);
  }
  // Nothing identifying who we work for.
  for (const k of ['jiraProjects', 'jiraFiltersRefreshedAt', 'dayonePlanFeed']) {
    assert.ok(!(k in h), `anonymous /api/health must not expose ${k}`);
  }
  for (const n of names) {
    assert.ok(!r.body.includes(n), `anonymous /api/health leaked the client name "${n}"`);
  }
  // And the gate behind it is still a gate.
  for (const p of ['/api/me', '/api/program/dayone', '/api/admin/catalog']) {
    assert.equal((await get(port, p)).status, 401, `${p} must require sign-in`);
  }

  stop();
  console.log('health exposure ok');
})().catch(e => { console.error(e.message); process.exit(1); });
