#!/usr/bin/env node
/* Decides whether a commit range may deploy unattended.
 *
 * The timer deploys whatever is on main. That is fine for ordinary changes and wrong for
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

/* Diff from the merge base, not from `prev` directly. On the timer's path main only fast-forwards,
   so the base IS prev and nothing changes. It matters when checking a branch by hand before it is
   merged: diffing straight against main counts main's own newer commits as the branch's changes,
   and the gate then holds a data-only PR for "changing the deploy mechanism" it never touched. */
let base = prev;
try { base = git('merge-base', prev, next).trim() || prev; } catch { /* unrelated histories */ }

const files = git('diff', '--name-only', base, next).split('\n').filter(Boolean);

/* Line-level rules read code, not prose. Scanning .md too made the gate quote a markdown table
   in a README as evidence of an authorisation change, which is the kind of noise that teaches
   people to stop reading the log. */
const CODE = /\.(js|json|caddy|service|timer|sh|example)$|(^|\/)\.env/;
const linesOf = (paths, keep) => {
  if (!paths.length) return [];
  const d = git('diff', '-U0', base, next, '--', ...paths);
  return d.split('\n').filter(l => keep.test(l) && !/^(\+\+\+|---)/.test(l)).map(l => l.slice(1));
};

/* A comment is not code. The first version of this gate scanned raw diff text, so it quoted a
   line of its own explanatory comment — "...whoIs() gives null without a token." — as evidence
   that a commit had changed how requests are authorised. Evidence that is prose teaches people to
   stop reading the log, which costs more than the rule is worth. The test is line-prefix based on
   purpose: a trailing comment on a real code line still counts, because the code line is real. */
const COMMENT = /^\s*(\/\/|\/\*|\*\/|\*|#)/;
const code = (lines) => lines.filter(l => l.trim() && !COMMENT.test(l));

/* This file is excluded from the line rules. Its source necessarily contains the very tokens the
   rules search for — the crypto primitives are listed in rule 2 — so any diff that touches those
   lines made the gate report its own rule definitions as a cryptography change. Nothing is lost:
   rule 6 holds for any real change here by path, which is a stronger test than a line match. */
const SELF = 'deploy/review-gate.js';
const codeFiles = files.filter(f => CODE.test(f) && f !== SELF);
const addedLines = code(linesOf(codeFiles, /^\+/));
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

// 3. New secret-shaped configuration. A new secret means a new thing that can leak — but only
//    where configuration is declared. Scanning every file made this fire on a test that sets a
//    fake JIRA_API_TOKEN, and a rule that cries wolf over test scaffolding gets ignored.
const CONFIG_FILES = /(^|\/)\.env(\.example)?$|(^|\/)config\.js$|\.(service|timer|caddy)$/;
hit('new secret-shaped config', 'introduces configuration that holds a credential',
  code(linesOf(files.filter(f => CONFIG_FILES.test(f)), /^\+/))
    .filter(l => /\b[A-Z][A-Z0-9_]*(SECRET|_TOKEN|API_KEY|CLIENT_ID|PASSWORD|ENCRYPTION_KEY|PRIVATE_KEY)\b/.test(l))
    .map(l => (l.trim().split('=')[0] || l.trim()).slice(0, 80)));

// 4. A new place the server talks to. Where data goes matters as much as what the code does.
const hostsIn = (text) => (text.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map(h => h.toLowerCase());
let knownHosts = new Set();
try { knownHosts = new Set(hostsIn(git('grep', '-h', '-I', '-E', 'https?://', base, '--', '*.js', '*.json', '*.caddy'))); } catch { /* no matches */ }
hit('new outbound host', 'the server would start talking to somewhere it has not before',
  hostsIn(added).filter(h => !knownHosts.has(h)));

// 5. The sign-in gate and the route table in server.js — where "who may call this" is enforced.
hit('request authorisation', 'changes how requests are authorised or which routes skip the sign-in gate',
  code(linesOf(files.filter(f => f === SERVER), /^[+-]/))
    .filter(l => /\b(signedIn|whoIs|Authorization|Bearer|action\(|\/api\/login)\b/.test(l))
    .map(l => l.trim().slice(0, 100)));

// 6. The deploy mechanism itself. Without this rule a commit could simply delete this gate and
//    everything after it would flow through unread, so the test stays crude: touch the privileged
//    files at all and it holds. Two things cannot change what a deploy does, and holding for them
//    only trains people to approve without looking — documentation (deploy/*.md), and a change
//    that moves nothing but comments. Deleting code still shows up as removed non-comment lines,
//    so the delete-the-gate case this rule exists for is unaffected.
hit('deploy mechanism', 'changes the privileged code that performs the deploy, this gate included',
  files.filter(f => f.startsWith('deploy/'))
       .filter(f => !/\.md$/.test(f) && code(linesOf([f], /^[+-]/)).length));

// 7. A first third-party dependency. The agent has none today, which is why it has no supply chain.
const depsAdded = addedLines.some(l => /"dependencies"\s*:/.test(l)) || files.some(f => /package-lock\.json$/.test(f));
hit('new dependency', 'adds third-party code to a service that currently has none',
  depsAdded ? files.filter(f => /package(-lock)?\.json$/.test(f)) : []);

const commits = git('log', '--oneline', `${base}..${next}`).trim().split('\n').filter(Boolean);
console.log(`${commits.length} commit(s), ${files.length} file(s) changed`);
if (!rules.length) { console.log('gate: clear — no security-sensitive change detected'); process.exit(0); }

console.log(`gate: HOLD — ${rules.length} rule(s) tripped`);
for (const r of rules) {
  console.log(`  • ${r.name}: ${r.why}`);
  for (const e of r.evidence) console.log(`      ${e}`);
}
process.exit(10);
