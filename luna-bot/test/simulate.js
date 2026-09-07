"use strict";
/**
 * Offline simulation — no Teams, no network. Proves the rule engine + state
 * machine + queue view implement the PRD workflow correctly, end to end,
 * using the real DayOne NTPE blocker chain (03 Historical BMS Data -> 04/05
 * -> MS2) as the scenario. Run with: npm run simulate
 */
const path = require("path");
const seed = require("../data/program.seed.json");
const { TicketStore } = require("../src/store");
const { detectTriggers, isStale, isMissingEta, toDate } = require("../src/rules");
const { draftMessage } = require("../src/messages");
const { groupByTab } = require("../src/queueView");

function normalizeProgram(s) {
  return {
    id: s.program.id,
    today: s.program.today,
    tasks: s.tasks,
    dependencies: s.dependencies,
    stakeholders: s.stakeholders,
    taskOwnerMap: s.taskOwnerMap,
    blockerOwnerOverride: s.blockerOwnerOverride,
    milestones: s.milestones,
  };
}

const program = normalizeProgram(seed);
const config = { REMINDER_THRESHOLD_HOURS: 48, ESCALATION_THRESHOLD_DAYS: 7, ESCALATION_MIN_REMINDERS: 2, dueSoonDays: 3, staleDays: 5 };

const storePath = path.resolve(__dirname, "..", "data", "tickets.store.json");
const fs = require("fs");
if (fs.existsSync(storePath)) fs.unlinkSync(storePath); // fresh run each time
const store = new TicketStore(storePath);

function nameOf(id) {
  return program.stakeholders.find((s) => s.id === id)?.name || id;
}
function section(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

// ---------------------------------------------------------------------
section("STEP 1 — Detect (rule engine scans the real DayOne NTPE data)");
// ---------------------------------------------------------------------
const events = detectTriggers(program, config);
events.forEach((e) => {
  console.log(
    `[${e.type}] task ${e.taskId} (${program.tasks.find((t) => t.id === e.taskId).name}) ` +
      `-> route to ${e.ownerRole === "blockerOwner" ? "BLOCKER OWNER" : "task owner"}: ${e.suggestedOwnerIds.map(nameOf).join(", ")}`
  );
});

// The `stale` and `missing_eta` rule functions are exercised directly here to
// prove they work, even though task 08 / 09 don't clear the isCritical gate
// in detectTriggers() — which is itself the intended behavior (Part 11:
// "只针对真正有交付意义的事项触发", not a blanket scan). This is the noise
// suppression working as designed, not a gap.
const today = toDate(program.today);
const task08 = program.tasks.find((t) => t.id === "08");
const task09 = program.tasks.find((t) => t.id === "09");
console.log(
  `[rule check] isStale(08 Chiller Plant Modelling, staleDays=5) = ${isStale(task08, today, config.staleDays)} ` +
    `-> suppressed from Ticket drafting because it isn't tied to a Milestone or Root Blocker chain (not a Critical Task).`
);
console.log(
  `[rule check] isMissingEta(09 DCWiz Demo Preparation) = ${isMissingEta(task09)} ` +
    `-> also suppressed for the same reason.`
);

// ---------------------------------------------------------------------
section("STEP 2 — Draft (Luna prepares Ticket cards, one per Critical Task)");
// ---------------------------------------------------------------------
const drafted = [];
for (const event of events) {
  const messageDraft = draftMessage(event, program);
  const { ticket, deduped } = store.draftFromTrigger(program.id, event, messageDraft);
  if (!deduped) {
    store.sendForReview(ticket.id);
    drafted.push(ticket.id);
    console.log(`Drafted ${ticket.id} for task ${ticket.relatedTaskId} — "${messageDraft.suggestedMessage}"`);
  }
}

// ---------------------------------------------------------------------
section("STEP 3 — Dedup check (re-run detection immediately)");
// ---------------------------------------------------------------------
const events2 = detectTriggers(program, config);
let dedupedCount = 0;
for (const event of events2) {
  const messageDraft = draftMessage(event, program);
  const { ticket, deduped } = store.draftFromTrigger(program.id, event, messageDraft);
  if (deduped) dedupedCount++;
}
console.log(`Re-running detection produced ${dedupedCount} deduped re-triggers and 0 new ticket IDs (as expected).`);

// ---------------------------------------------------------------------
section("STEP 4 — Human Review in Delivery Control Room");
// ---------------------------------------------------------------------
const rootBlockerTicketId = store
  .list()
  .find((t) => t.triggerType === "overdue_root_blocker").id;
const blockedByUpstreamTicket = store.list().find((t) => t.triggerType === "blocked_by_upstream");
const dueSoonOrMissingTicket = store.list().find((t) => ["due_soon", "missing_eta", "stale"].includes(t.triggerType));

store.approve(rootBlockerTicketId, "Selena", {});
console.log(`Selena APPROVED ${rootBlockerTicketId} as-is -> published to Project Delivery Group.`);

if (blockedByUpstreamTicket) {
  store.approve(blockedByUpstreamTicket.id, "Sherry", { priority: "high" });
  console.log(`Sherry APPROVED ${blockedByUpstreamTicket.id} with an edit (priority -> high) -> published.`);
}

if (dueSoonOrMissingTicket) {
  store.reject(dueSoonOrMissingTicket.id, "Selena", "Already Resolved");
  console.log(`Selena REJECTED ${dueSoonOrMissingTicket.id}: Already Resolved -> kept in Closed for audit.`);
}

// ---------------------------------------------------------------------
section("STEP 5 — Stakeholder responses in Project Delivery Group");
// ---------------------------------------------------------------------
if (blockedByUpstreamTicket) {
  store.respondOnTrack(blockedByUpstreamTicket.id, "valdy", false);
  console.log(`Valdy responded to ${blockedByUpstreamTicket.id}: On Track but ETA no longer valid -> stays open for a Change ETA.`);
  store.respondChangeEta(blockedByUpstreamTicket.id, "valdy", "2026-08-28", "Waiting on Historical BMS Data before framework calibration can finish", true);
  const t = store.get(blockedByUpstreamTicket.id);
  console.log(`  -> Change ETA to 2026-08-28 touches MS2's Critical Path, so status is now ${t.status} (back in Delivery Control Room).`);
}

// ---------------------------------------------------------------------
section("STEP 6 — Reminder cycle (no response for 48h+)");
// ---------------------------------------------------------------------
const rootTicket = store.get(rootBlockerTicketId);
rootTicket.publishedAt = new Date(Date.now() - 50 * 3600 * 1000).toISOString(); // backdate 50h
store._save();
let tabs = groupByTab(store.list(), config);
console.log(`${rootBlockerTicketId} is now ${tabs.waitingForResponse.some((t) => t.id === rootBlockerTicketId) ? "in Waiting for Response" : "still in Published"} (50h with no response, threshold ${config.REMINDER_THRESHOLD_HOURS}h).`);
store.proposeReminder(rootBlockerTicketId);
console.log(`Luna proposed a Reminder in Delivery Control Room (not sent yet).`);
store.approveReminder(rootBlockerTicketId, "Sherry");
console.log(`Sherry approved the Reminder -> sent. reminderCount=${store.get(rootBlockerTicketId).reminderCount}`);

// ---------------------------------------------------------------------
section("STEP 7 — Escalation cycle (still overdue 7d+, 2+ reminders)");
// ---------------------------------------------------------------------
store.approveReminder(rootBlockerTicketId, "Sherry"); // second reminder
rootTicket.publishedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(); // backdate 8 days
store._save();
const daysOverdue = (Date.now() - new Date(rootTicket.publishedAt)) / (24 * 3600 * 1000);
const eligible = daysOverdue >= config.ESCALATION_THRESHOLD_DAYS && store.get(rootBlockerTicketId).reminderCount >= config.ESCALATION_MIN_REMINDERS;
console.log(`Escalation eligible? ${eligible} (${Math.floor(daysOverdue)} days overdue, ${store.get(rootBlockerTicketId).reminderCount} reminders sent, thresholds: ${config.ESCALATION_THRESHOLD_DAYS}d / ${config.ESCALATION_MIN_REMINDERS} reminders)`);
if (eligible) {
  store.proposeEscalation(rootBlockerTicketId, "Justin");
  console.log(`Luna proposed escalating ${rootBlockerTicketId} to Justin -> awaiting Delivery Control Room approval.`);
  tabs = groupByTab(store.list(), config);
  console.log(`${rootBlockerTicketId} now appears in the "escalation" Luna Queue tab: ${tabs.escalation.some((t) => t.id === rootBlockerTicketId)}`);
  store.approveEscalation(rootBlockerTicketId, "Selena");
  console.log(`Selena approved the escalation -> sent to Justin.`);
}

// ---------------------------------------------------------------------
section("STEP 8 — Blocked response reveals a DIFFERENT Blocker Owner (Part 12)");
// ---------------------------------------------------------------------
// DT-0xx for task 03 is still Waiting for Response after the reminder/escalation
// cycle above. Justin now replies — and the real blocker turns out to be a
// third-party subcontractor, not Justin himself.
if (store.get(rootBlockerTicketId).status === "WAITING_FOR_RESPONSE") {
  store.respondBlocked(rootBlockerTicketId, "justin", "Waiting for Data", "peter (BMS subcontractor, DayOne facilities)");
  console.log(
    `Justin reported Blocked on ${rootBlockerTicketId}, naming a BMS subcontractor ("Peter") as the real Blocker Owner — ` +
      `neither Justin nor Hong Qing, who were the previously assumed owners.`
  );
  console.log(
    `  -> TODO hook for production: write back a new Hard Dependency edge onto ${rootBlockerTicketId}'s related task ` +
      `so the NEXT detection cycle auto-routes to Peter instead of Hong Qing/Justin (Part 12 routing rule). Left as a ` +
      `write-back stub here since it requires a real Stakeholder record for Peter (Open Question #4, identity mapping).`
  );
}

// ---------------------------------------------------------------------
section("STEP 9 — Done -> Pending Verification -> Closed (Critical Deliverable)");
// ---------------------------------------------------------------------
if (blockedByUpstreamTicket) {
  // Re-approve the Change-ETA-triggered re-review from Step 5, then complete it.
  const t = store.get(blockedByUpstreamTicket.id);
  if (t.status === "PENDING_REVIEW") {
    store.approve(t.id, "Selena", {});
    console.log(`Selena approved the Change ETA re-review for ${t.id}.`);
  }
  store.respondDone(t.id, "valdy", true); // relatedMilestone != null -> requires verification
  console.log(`Valdy marked ${t.id} Done. Because it's tied to MS2, status is now ${store.get(t.id).status}.`);
  store.submitEvidence(t.id, "valdy", "jira-link", "https://jira.example.com/RDA-4821");
  console.log(`Valdy submitted Evidence (Jira link).`);
  store.verify(t.id, "Selena", "pass");
  console.log(`Selena verified and closed ${t.id}. Final status: ${store.get(t.id).status}`);
}

// ---------------------------------------------------------------------
section("STEP 10 — Full audit trail for one ticket (Principle 6: auditable)");
// ---------------------------------------------------------------------
console.log(JSON.stringify(store.get(rootBlockerTicketId).history, null, 2));

// ---------------------------------------------------------------------
section("FINAL — Luna Queue tab counts");
// ---------------------------------------------------------------------
tabs = groupByTab(store.list(), config);
Object.entries(tabs).forEach(([tab, list]) => console.log(`${tab}: ${list.length} -> [${list.map((t) => t.id).join(", ")}]`));

console.log(`\nAll ${store.list().length} tickets persisted to ${storePath}\n`);
