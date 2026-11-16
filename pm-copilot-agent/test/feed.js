/* Offline: a Granola meeting about DayOne updates the project view (meetings, change proposals,
   change log, brief), and the new DayOne Jira task is filed under the epic. Claude and Jira are stubbed. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
Object.assign(process.env, { ANTHROPIC_API_KEY: 'x', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
const cfg = require('../src/config');
const keep = ['program-feed.json', 'plan.json', 'dayone-jira.json'].map(n => { const f = path.join(cfg.DATA_DIR, n); return [f, fs.existsSync(f) ? fs.readFileSync(f) : null]; });
const restore = () => keep.forEach(([f, b]) => b ? fs.writeFileSync(f, b) : fs.rmSync(f, { force: true }));
for (const [f] of keep) fs.rmSync(f, { force: true });
// Jira sync state: 04 is linked to BA-2387, so Jira owns its status, owner and date.
fs.writeFileSync(path.join(cfg.DATA_DIR, 'dayone-jira.json'), JSON.stringify({ tasks: { '04': { key: 'BA-2387', status: 'inprogress', owner: 'Valdy', due: '2026-11-27' } } }));

let answer;
global.fetch = async (url) => {
  assert.match(url, /api\.anthropic\.com/);
  return { ok: true, status: 200, json: async () => ({ model: 'stub', content: [{ type: 'tool_use', name: 'record_plan_update', input: answer }] }) };
};
const feed = require('../src/programfeed');
const plan = require('../src/plan');
const jira = require('../src/jira');

(async () => {
  try {
    answer = {
      relevant: true, summary: 'Level 1 data arrived; ground-floor model validated.',
      changelog: { en: '<b>03 Historical BMS Data</b>: Level 1 data received.', zh: '<b>03 历史 BMS 数据</b>:Level 1 数据已到。' },
      brief: { en: 'Level 1 data is in; live API still pending.', zh: 'Level 1 数据已到;实时 API 仍未交付。' },
      focus: [{ en: 'Validate Level 1 twins', zh: '验证 Level 1 孪生', warn: false }],
      proposals: [
        { taskId: '03', field: 'progress', newValue: 90, confidence: 'confirmed', evidence: 'Level 1 data has been uploaded', reason: 'Most data now in.' },
        { taskId: '03', field: 'due', newValue: '2026-11-25', confidence: 'confirmed', evidence: 'by 25 Nov', reason: 'Date stated.' },
        { taskId: '04', field: 'status', newValue: 'done', confidence: 'confirmed', evidence: 'x', reason: 'Jira owns this' },
        { taskId: '04', field: 'health', newValue: 'good', confidence: 'confirmed', evidence: 'validated', reason: 'Validated.' },
        { taskId: '05', field: 'progress', newValue: 90, confidence: 'confirmed', evidence: 'x', reason: 'Same as now' },
        { taskId: '99', field: 'progress', newValue: 10, confidence: 'confirmed', evidence: 'x', reason: 'No such task' },
        { taskId: '12', field: 'progress', newValue: 140, confidence: 'confirmed', evidence: 'x', reason: 'Out of range' },
      ],
    };
    const m = { id: 'mtg_a1', title: 'DayOne Weekly Meeting', date: '2026-11-20T10:00:00+08:00', notesText: 'notes', url: 'https://notes.granola.ai/d/a1' };
    const r = await feed.analyse('dayone', m);
    assert.equal(r.proposals, 3);                                   // 03 progress, 03 due, 04 health

    const d = feed.merged('dayone');
    assert.equal(d.asOf, '2026-11-20');
    assert.equal(d.MEETINGS[0].title, 'DayOne Weekly Meeting'); assert.equal(d.MEETINGS[0].date, '2026-11-20');
    const mine = d.PROPOSALS.filter(p => p.source === 'granola');
    assert.deepEqual(mine.map(p => `${p.entityId}.${p.field}=${p.newValue}`), ['03.progress=90', '03.due=11/25', '04.health=good']);
    assert.equal(mine[0].oldValue, 75); assert.equal(mine[0].meetingId, d.MEETINGS[0].id);
    assert.match(d.CHANGELOG[0].text, /Level 1 data received\. \(source: DayOne Weekly Meeting, Granola\)/);
    assert.equal(d.OVERVIEW.brief.en, 'Level 1 data is in; live API still pending.'); assert.equal(d.OVERVIEW.phaseMonths[0], 3);

    // Approving on the Meetings page stores a plan edit, health included.
    plan.decide('dayone', { sig: 's1', decision: 'approved', proposal: { meetingTitle: m.title, meetingDate: '2026-11-20' }, taskId: '04', field: 'health', value: 'good' }, 'zhangzhaoning');
    assert.equal(plan.get('dayone').tasks['04'].health, 'good');
    // …and the next meeting is compared against the plan as it now stands.
    assert.equal(feed.currentTasks('dayone').find(t => t.id === '04').health, 'good');

    // Re-analysing replaces that meeting's contribution instead of adding to it.
    await feed.analyse('dayone', m);
    assert.equal(feed.merged('dayone').PROPOSALS.filter(p => p.source === 'granola').length, 2);   // 04 health now equals the plan

    // A meeting already in the shipped plan (same date + title) is not listed twice; proposals point at it.
    await feed.analyse('dayone', { id: 'mtg_b2', title: 'DayOne Weekly Meeting', date: '2026-11-13T10:00:00+08:00', notesText: 'n' });
    const d2 = feed.merged('dayone');
    assert.equal(d2.MEETINGS.filter(x => x.date === '2026-11-13').length, 1);
    assert.ok(d2.PROPOSALS.some(p => p.source === 'granola' && p.meetingId === 'm13'));
    assert.equal(d2.OVERVIEW.from.date, '2026-11-20');                       // older meeting does not replace a newer brief

    // Not about DayOne: nothing added.
    answer = { relevant: false, summary: '', proposals: [] };
    await feed.analyse('dayone', { id: 'mtg_c3', title: 'Engineering Standup', date: '2026-11-21', notesText: 'n' });
    assert.ok(!feed.merged('dayone').MEETINGS.some(x => x.title === 'Engineering Standup'));

    // Jira: a new DayOne task is filed under the epic so the DayOne sync picks it up.
    const p = jira.plan({ kind: 'new_ticket', project: 'dayone', title: 't', detail: 'd' }, m, 'zhangzhaoning');
    assert.deepEqual(p[0].body.fields.parent, { key: 'BA-2380' });
    const { planMonth } = require('../src/jirasync');
    assert.equal(planMonth('2026-11-16', '2026-07-01'), 5); assert.equal(planMonth('2025-12-01', '2026-07-01'), null);
    console.log('plan feed ok');
  } finally { restore(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
