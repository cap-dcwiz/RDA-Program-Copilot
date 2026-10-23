/* Grant this dashboard's roles to a Product Center person or role, from the command line.
   Accounts themselves live in the Product Center — this only decides what they may do here.

   Usage: npm run grant -- <email|username|role:NAME> <role,role>
   e.g.   npm run grant -- sherry.liu@rda.ai customer-dayone
          npm run grant -- role:operator rda-manager,rda-member
          npm run grant -- sherry.liu@rda.ai -        (removes her override)

   Normally you do this on the dashboard's Roles & Access page; this is for scripts and recovery
   (for example when the mapping has locked everyone out of that page). */
const auth = require('../src/auth');
const [who, roleList] = process.argv.slice(2);
if (!who || !roleList) {
  console.error('Usage: npm run grant -- <email|username|role:NAME> <role,role>   (use "-" to remove)');
  console.error('Known roles here:', auth.roles().map(r => r.id).join(', '));
  process.exit(1);
}
const wanted = roleList === '-' ? [] : roleList.split(',').map(s => s.trim()).filter(Boolean);
const unknown = wanted.filter(r => !auth.roles().some(x => x.id === r));
if (unknown.length) { console.error(`Unknown role(s): ${unknown.join(', ')}\nKnown: ${auth.roles().map(r => r.id).join(', ')}`); process.exit(1); }

const a = auth.access();
const isRole = who.toLowerCase().startsWith('role:');
const key = isRole ? who.slice(5).trim().toLowerCase() : who.trim().toLowerCase();
if (isRole) a.byRole[key] = wanted; else if (wanted.length) a.byUser[key] = wanted; else delete a.byUser[key];

try {
  auth.saveAccess(a);
  const what = wanted.length ? wanted.join(', ') : '(nothing — removed)';
  console.log(`${isRole ? `Product Center role "${key}"` : key} now grants: ${what}`);
} catch (e) { console.error(e.message); process.exit(1); }
