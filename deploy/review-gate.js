#!/usr/bin/env node
/* Decides whether a commit range may deploy unattended.
 *
 * The daily timer deploys whatever is on main. That is fine for ordinary changes and wrong for
 * changes that move credentials, identity or access around: those want a person to have read them
 * first. This script is the difference between the two. It never deploys and never blocks a human
 * — it only answers "may the timer do this on its own tonight".
 *
 * Usage: review-gate.js <repo-dir> <prev-sha> <next-sha>
 * Exit 0  = clear, the timer may deploy.
 * Exit 10 = hold, a person should read it. Reasons are printed.
 * Exit 1  = the gate itself could not run; the caller treats that as a hold.
 *
 * A held commit is deployed by a person, either by running deploy/deploy-vm.sh or by approving
 * exactly that sha — see deploy/README.md. Being held is not a judgement about the code; several
 * of these rules fire on changes that turn out to be perfectly good.
 */
'use strict';
const { execFileSync } = require('child_process');

const [repo, prev, next] = process.argv.slice(2);
if (!repo || !prev || !next) { console.error('usage: review-gate.js <repo-dir> <prev-sha> <next-sha>'); process.exit(1); }
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });

const files = git('diff', '--name-only', prev, next).split('\n').filter(Boolean);

/* Line-level rules read code, not prose. Scanning .md too made the gate quote a markdown table
   in a README as evidence of an authorisation change, which is the kind of noise that teaches
   people to stop reading the log. */
const CODE = /\.(js|json|caddy|service|timer|sh|example)$|(^|\/)\.env/;
const linesOf = (paths, keep) => {
  if (!paths.length) return [];
  const d = git('diff', '-U0', prev, next, '--', ...paths);
  return d.split('\n').filter(l => keep.test(l) && !/^(\+\+\+|---)/.test(l)).map(l => l.slice(1));
};
const codeFiles = files.filter(f => CODE.test(f));
const addedLines = linesOf(codeFiles, /^\+/);
const added = addedLines.join('\n');
const SERVER = 'pm-copilot-agent/src/server.js';

/* Each rule: a name, why it matters, and the evidence it found. Evidence is what makes the log
   worth reading — "crypto primitives" alone tells a tired person nothing. */
const rules = [];
const hit = (name, why, evidence) => { if (evidence.length) rules.push({ name, why, evidence: [...new Set(evidence)].slice(0, 8) }); };

// 1. The files whose whole job is deciding who someone is and what they may do.
hit('identity & access code', 'these files decide who a request is and what it may do',
  files.filter(f => /(^|\/)(auth|productcenter|permissions)\.js$/.test(f)
                 || /oauth|jwt|session|token|secret|credential|passwd|password|crypt/i.test(f)));

// 2. New cryptography. Correct crypto is easy to get subtly wrong and impossible to spot at a glance.
hit('cryptography', 'new cryptographic code — key handling and modes need reading, not a health check',
  addedLines.filter(l => /\b(createCipheriv|createDecipheriv|createHmac|createSign|createVerify|privateDecrypt|publicEncrypt|generateKeyPair|randomBytes|timingSafeEqual|scrypt|pbkdf2)\b/.test(l))
    .map(l => l.trim().slice(0, 100)));

// 3. New secret-shaped configuration. A new secret means a new thing that can leak.
hit('new secret-shaped config', 'introduces configuration that holds a credential',
  addedLines.filter(l => /\b[A-Z][A-Z0-9_]*(SECRET|_TOKEN|API_KEY|CLIENT_ID|PASSWORD|ENCRYPTION_KEY|PRIVATE_KEY)\b/.test(l))
    .map(l => (l.trim().split('=')[0] || l.trim()).slice(0, 80)));

// 4. A new place the server talks to. Where data goes matters as much as what the code does.
const hostsIn = (text) => (text.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map(h => h.toLowerCase());
let knownHosts = new Set();
try { knownHosts = new Set(hostsIn(git('grep', '-h', '-I', '-E', 'https?://', prev, '--', '*.js', '*.json', '*.caddy'))); } catch { /* no matches */ }
hit('new outbound host', 'the server would start talking to somewhere it has not before',
  hostsIn(added).filter(h => !knownHosts.has(h)));

// 5. The sign-in gate and the route table in server.js — where "who may call this" is enforced.
hit('request authorisation', 'changes how requests are authorised or which routes skip the sign-in gate',
  linesOf(files.filter(f => f === SERVER), /^[+-]/)
    .filter(l => /\b(signedIn|whoIs|Authorization|Bearer|action\(|\/api\/login)\b/.test(l))
    .map(l => l.trim().slice(0, 100)));

// 6. The deploy mechanism itself. Without this rule a commit could simply delete this gate and
//    everything after it would flow through unread.
hit('deploy mechanism', 'changes the privileged code that performs the deploy, this gate included',
  files.filter(f => f.startsWith('deploy/')));

// 7. A first third-party dependency. The agent has none today, which is why it has no supply chain.
const depsAdded = addedLines.some(l => /"dependencies"\s*:/.test(l)) || files.some(f => /package-lock\.json$/.test(f));
hit('new dependency', 'adds third-party code to a service that currently has none',
  depsAdded ? files.filter(f => /package(-lock)?\.json$/.test(f)) : []);

const commits = git('log', '--oneline', `${prev}..${next}`).trim().split('\n').filter(Boolean);
console.log(`${commits.length} commit(s), ${files.length} file(s) changed`);
if (!rules.length) { console.log('gate: clear — no security-sensitive change detected'); process.exit(0); }

console.log(`gate: HOLD — ${rules.length} rule(s) tripped`);
for (const r of rules) {
  console.log(`  • ${r.name}: ${r.why}`);
  for (const e of r.evidence) console.log(`      ${e}`);
}
process.exit(10);
