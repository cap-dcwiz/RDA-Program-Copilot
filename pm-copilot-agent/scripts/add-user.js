/* Usage: npm run add-user -- <username> <password> [role,role] ["Display name"] [email]
   e.g.   npm run add-user -- sherry.liu 'S3cure-pass' pm "Sherry Liu" sherry.liu@rda.ai
   Normally you add users on the dashboard's Users & Roles page; this is for scripts and recovery. */
const auth = require('../src/auth');
const [username, password, roleList = '', displayName, email] = process.argv.slice(2);
if (!username || !password) { console.error('Usage: npm run add-user -- <username> <password> [role,role] ["Display name"] [email]'); process.exit(1); }
auth.roles();
try {
  const u = auth.createUser({ username, password, displayName, email, roles: roleList.split(',').map(s => s.trim()).filter(Boolean) });
  console.log(`Added ${u.username} with roles: ${u.roles.join(', ') || '(none)'}`);
} catch (e) { console.error(e.message); process.exit(1); }
