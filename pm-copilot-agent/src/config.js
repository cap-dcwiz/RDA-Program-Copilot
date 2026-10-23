/* Loads .env (no dependency) and exposes typed config. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const bool = (k, d) => { const v = env(k, ''); return v === '' ? d : /^(1|true|yes)$/i.test(v); };

/* Jira "Client" dropdown (customfield_10034) option ids per portfolio project, so tickets the
   agent creates carry the right client and show up in the portfolio JQL. */
const CLIENT_OPTIONS = {
  dayone: { id: '10152', label: 'DayOne NTP-E' },
  bdc:    { id: '10029', label: 'BDC MY2' },
  bdx:    { id: '10028', label: 'BDx SIN1' },
  cmide:  { id: '10083', label: 'CMI-DE1-Germany' },
  cmisg:  { id: '10031', label: 'CMI-SGDC' },
  imdc:   { id: '10085', label: 'Iron Mountain SIN1' },
};

module.exports = {
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  anthropic: { apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5') },
  granola: {
    apiKey: env('GRANOLA_API_KEY'),
    baseUrl: env('GRANOLA_BASE_URL', 'https://public-api.granola.ai'),
    folderId: env('GRANOLA_FOLDER_ID'),
    titleFilter: env('GRANOLA_TITLE_FILTER').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    lookbackDays: Number(env('GRANOLA_LOOKBACK_DAYS', '14')),
    syncMinutes: Number(env('GRANOLA_SYNC_MINUTES', '15')),
  },
  jira: {
    baseUrl: env('JIRA_BASE_URL', 'https://projects-teams.atlassian.net').replace(/\/$/, ''),
    email: env('JIRA_EMAIL'),
    token: env('JIRA_API_TOKEN'),
    projectKey: env('JIRA_PROJECT_KEY', 'BA'),
    jql: env('JIRA_JQL', 'project = BA AND "client[dropdown]" != RDA AND status NOT IN (Done, Backlog) ORDER BY cf[10019] ASC'),
    issueTypeId: env('JIRA_ISSUE_TYPE_ID', '10006'),
    clientField: env('JIRA_CLIENT_FIELD', 'customfield_10034'),
    dryRun: bool('JIRA_DRY_RUN', true),
    // Nightly read sync. Default: the end of every working day, Mon–Fri 24:00 Singapore time
    // (= 00:00 Tue–Sat). JIRA_SYNC=off disables it; the "Sync now" button still works.
    sync: env('JIRA_SYNC', 'on') !== 'off',
    syncTz: env('JIRA_SYNC_TZ_OFFSET', '+08:00'),
    dayoneJql: env('DAYONE_JQL', 'project = BA AND (parent = BA-2380 OR summary ~ "DayOne-NTPE") ORDER BY key ASC'),
  },
  CLIENT_OPTIONS,
  port: Number(env('PORT', '8790')),
  allowedOrigins: env('ALLOWED_ORIGINS', '*').split(',').map(s => s.trim()).filter(Boolean),
};
