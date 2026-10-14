/* Permission catalog — the single list the server enforces and the Users & Roles page renders.
   A role grants: pages (what shows in the menu), actions (what it may change), projects (whose
   data it may see; '*' = all). A user with several roles gets the union. */
const PAGES = [
  { id: 'portfolio',  group: 'all',    en: 'Portfolio',            zh: '项目组合' },
  { id: 'todo',       group: 'all',    en: 'Meeting To-dos',       zh: '会议待办' },
  { id: 'history',    group: 'all',    en: 'Meeting History',      zh: '会议记录' },
  { id: 'overview',   group: 'dayone', en: 'DayOne / Overview',           zh: 'DayOne / 总览' },
  { id: 'blocker',    group: 'dayone', en: 'DayOne / Blocker Impact Map', zh: 'DayOne / 阻塞影响图' },
  { id: 'dependency', group: 'dayone', en: 'DayOne / Dependency View',    zh: 'DayOne / 依赖关系图' },
  { id: 'roadmap',    group: 'dayone', en: 'DayOne / Roadmap View',       zh: 'DayOne / 路线图' },
  { id: 'meetings',   group: 'dayone', en: 'DayOne / Meetings',           zh: 'DayOne / 会议' },
  { id: 'luna',       group: 'dayone', en: 'DayOne / Luna Queue',         zh: 'DayOne / Luna 队列' },
  { id: 'users',      group: 'admin',  en: 'Users & Roles',        zh: '用户与角色' },
];
const ACTIONS = [
  { id: 'approve', en: 'Approve, edit and reject to-dos (writes to Jira)', zh: '审批、编辑、驳回待办(写入 Jira)' },
  { id: 'ingest',  en: 'Sync Granola, import and re-analyse meetings',     zh: '同步 Granola、导入与重新分析会议' },
];
const PROJECTS = [
  { id: 'dayone', en: 'DayOne NTP-E' }, { id: 'bdc', en: 'BDC MY2' }, { id: 'bdx', en: 'BDx SIN1' },
  { id: 'cmide', en: 'CMI-DE1' }, { id: 'cmisg', en: 'CMI-SG' }, { id: 'imdc', en: 'Iron Mountain SIN1' },
  { id: 'internal', en: 'Internal (RDA)', zh: '内部(RDA)' },
];
const ALL = { pages: PAGES.map(p => p.id), actions: ACTIONS.map(a => a.id), projects: ['*'] };

/* First-run roles. Admin is locked: it always keeps every permission and cannot be deleted. */
const RDA_PAGES = PAGES.map(p => p.id).filter(p => p !== 'users');
const DEFAULT_ROLES = [
  // Opens accounts and edits roles. Locked: always every permission, cannot be deleted.
  { id: 'admin', name: 'Super Admin', locked: true, ...ALL },
  // RDA managers: see everything, may approve to-dos into Jira.
  { id: 'rda-manager', name: 'RDA Manager', pages: RDA_PAGES, actions: ['approve', 'ingest'], projects: ['*'] },
  // RDA staff: see everything, can bring meetings in, cannot approve.
  { id: 'rda-member', name: 'RDA Member', pages: RDA_PAGES, actions: ['ingest'], projects: ['*'] },
  // Customers: only their own project, read-only.
  { id: 'customer-dayone', name: 'Customer · DayOne', pages: ['overview', 'roadmap'], actions: [], projects: ['dayone'] },
];

function effective(roles, roleIds) {
  const mine = roles.filter(r => (roleIds || []).includes(r.id));
  const out = { pages: new Set(), actions: new Set(), projects: new Set() };
  for (const r of mine) {
    const src = r.locked ? ALL : r;
    src.pages.forEach(x => out.pages.add(x)); src.actions.forEach(x => out.actions.add(x)); src.projects.forEach(x => out.projects.add(x));
  }
  const projects = out.projects.has('*') ? ['*'] : [...out.projects];
  return { pages: PAGES.map(p => p.id).filter(p => out.pages.has(p)), actions: [...out.actions], projects, roles: mine.map(r => r.name) };
}

const canSeeProject = (perms, project) => perms.projects.includes('*') || perms.projects.includes(project);

module.exports = { PAGES, ACTIONS, PROJECTS, DEFAULT_ROLES, effective, canSeeProject };
