/* Usage: npm run add-user -- "Sherry Liu" admin sherry.liu@rda.ai
   Prints the sign-in token once. Re-running for the same name replaces the token. */
const { addUser } = require('../src/auth');
const [name, role = 'viewer', email] = process.argv.slice(2);
if (!name) { console.error('Usage: npm run add-user -- "<name>" <admin|viewer> [email]'); process.exit(1); }
const token = addUser({ name, role, email });
console.log(`\n${name} (${role}) added. Sign-in token, shown once:\n\n  ${token}\n\nPaste it into the dashboard's "Sign in" box. Keep it private.\n`);
