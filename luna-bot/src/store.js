"use strict";
/**
 * Ticket store + state machine.
 * V1 persistence is a single JSON file — deliberately simple; swap loadState/
 * saveState for a real DB later without touching any business logic below.
 *
 * State machine (PRD Part 5 / Part 6), exactly:
 *   DETECTED -> DRAFTED -> PENDING_REVIEW -> (APPROVED | REJECTED)
 *   APPROVED -> WAITING_FOR_RESPONSE (i.e. "Published", tracked via publishedAt)
 *   WAITING_FOR_RESPONSE -> ACKNOWLEDGED | (loops via reminder/escalation) | UPDATED
 *   UPDATED -> PENDING_VERIFICATION -> CLOSED
 *   UPDATED -> CLOSED (non-critical Action, no verification needed)
 *   REJECTED -> CLOSED (terminal, kept for audit)
 */

const fs = require("fs");
const path = require("path");

const STATUS = Object.freeze({
  DRAFTED: "DRAFTED",
  PENDING_REVIEW: "PENDING_REVIEW",
  REJECTED: "REJECTED",
  WAITING_FOR_RESPONSE: "WAITING_FOR_RESPONSE",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  CLOSED: "CLOSED",
});

const REJECT_REASONS = [
  "Wrong Owner",
  "Not Worth Following Up",
  "Information Outdated",
  "Already Resolved",
  "Wrong Dependency",
  "Bad Timing",
  "Duplicate Ticket",
  "Other",
];

const BLOCKED_REASONS = [
  "Waiting for Data",
  "Waiting for Customer",
  "Waiting for API",
  "Waiting for Approval",
  "Technical Issue",
  "Resource Issue",
  "Other",
];

class TicketStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this._load();
  }

  _load() {
    if (fs.existsSync(this.filePath)) {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    }
    return { seq: 0, tickets: {} };
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  _nextId() {
    this.state.seq += 1;
    return `DT-${String(20 + this.state.seq).padStart(3, "0")}`;
  }

  _log(ticket, event, detail = {}) {
    ticket.history.push({ event, at: new Date().toISOString(), ...detail });
  }

  /** Dedup key intentionally ignores trigger type (Part 7): one open Ticket
   *  per Program+relatedTask, regardless of which rule re-fires on it. */
  dedupeKey(programId, taskId) {
    return `${programId}:${taskId}`;
  }

  /** Returns an existing non-terminal ticket for this task, if any. */
  findActive(programId, taskId) {
    const key = this.dedupeKey(programId, taskId);
    return Object.values(this.state.tickets).find(
      (t) => t.dedupeKey === key && ![STATUS.REJECTED, STATUS.CLOSED].includes(t.status)
    );
  }

  /**
   * Turn a rule-engine trigger event into a Drafted ticket, OR — if an active
   * ticket already tracks this task — append a re-trigger history entry and
   * return the existing ticket untouched (Ticket Deduplication, Part 7).
   */
  draftFromTrigger(programId, event, messageDraft) {
    const existing = this.findActive(programId, event.taskId);
    if (existing) {
      this._log(existing, "RETRIGGER_DEDUPED", { triggerType: event.type, reason: event.reason });
      this._save();
      return { ticket: existing, deduped: true };
    }

    const id = this._nextId();
    const ticket = {
      id,
      programId,
      relatedTaskId: event.taskId,
      dedupeKey: this.dedupeKey(programId, event.taskId),
      triggerType: event.type,
      triggerReason: event.reason,
      ownerRole: event.ownerRole,
      rootBlockerId: event.rootBlockerId,
      relatedMilestone: event.relatedMilestone,
      impactChain: event.impactChain,
      status: STATUS.DRAFTED,
      draft: {
        recipientIds: event.suggestedOwnerIds,
        message: messageDraft,
        priority: event.relatedMilestone ? "high" : "medium",
        dueDate: null,
      },
      final: null, // set once a reviewer approves (may equal draft, or an edited version)
      approval: null,
      rejection: null,
      publishedAt: null,
      responses: [],
      reminderCount: 0,
      escalation: null, // { proposedAt, approvedAt, executedAt, to }
      evidence: [],
      verification: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
    };
    this._log(ticket, "DETECTED", { triggerType: event.type, reason: event.reason });
    this._log(ticket, "DRAFTED", {});
    this.state.tickets[id] = ticket;
    this._save();
    return { ticket, deduped: false };
  }

  /** Draft -> Pending Review: the card is posted in the Delivery Control Room. */
  sendForReview(id) {
    const t = this._require(id);
    t.status = STATUS.PENDING_REVIEW;
    this._log(t, "PENDING_REVIEW", {});
    this._touch(t);
    return t;
  }

  /** Approve, with optional edits captured separately from the original draft
   *  so both are retained for future Routing/wording optimization (Part 15). */
  approve(id, reviewerName, edits = {}) {
    const t = this._require(id);
    if (t.status !== STATUS.PENDING_REVIEW) throw new Error(`Ticket ${id} is not Pending Review`);
    t.final = { ...t.draft, ...edits };
    t.approval = { approvedBy: reviewerName, approvedAt: new Date().toISOString(), edits };
    t.status = STATUS.WAITING_FOR_RESPONSE; // Published, tracked via publishedAt below
    t.publishedAt = new Date().toISOString();
    this._log(t, "APPROVED", { reviewerName, edited: Object.keys(edits).length > 0 });
    this._log(t, "PUBLISHED", { channel: "Project Delivery Group" });
    this._touch(t);
    return t;
  }

  reject(id, reviewerName, reason) {
    const t = this._require(id);
    if (!REJECT_REASONS.includes(reason)) throw new Error(`Invalid reject reason: ${reason}`);
    t.status = STATUS.REJECTED;
    t.rejection = { by: reviewerName, reason, at: new Date().toISOString() };
    this._log(t, "REJECTED", { reviewerName, reason });
    this._touch(t);
    return t;
  }

  /** On Track response: confirm ETA validity, no Program-state change. */
  respondOnTrack(id, byStakeholderId, etaStillValid) {
    const t = this._require(id);
    this._assertWaiting(t);
    t.responses.push({ type: "on-track", by: byStakeholderId, at: new Date().toISOString(), etaStillValid });
    this._log(t, "RESPONSE_ON_TRACK", { byStakeholderId, etaStillValid });
    if (etaStillValid) {
      // Acknowledged — stays in WAITING_FOR_RESPONSE bucket conceptually "resolved
      // for this cycle"; V1 closes lightweight on-track pings, keeps critical ones open
      // for the next natural check-in rather than modelling a separate ACKNOWLEDGED state.
      t.status = STATUS.CLOSED;
      this._log(t, "CLOSED", { reason: "Acknowledged on-track, ETA confirmed valid" });
    }
    this._touch(t);
    return t;
  }

  /** Blocked response: capture reason + blocker owner; if the blocker owner
   *  differs from the current task owner, record it so the NEXT trigger cycle
   *  routes correctly (Part 19 of the source brief / Part 7 Blocker Owner rule). */
  respondBlocked(id, byStakeholderId, blockedReason, blockerOwnerId) {
    const t = this._require(id);
    if (!BLOCKED_REASONS.includes(blockedReason)) throw new Error(`Invalid blocked reason: ${blockedReason}`);
    this._assertWaiting(t);
    t.responses.push({
      type: "blocked",
      by: byStakeholderId,
      at: new Date().toISOString(),
      blockedReason,
      blockerOwnerId,
    });
    t.status = STATUS.UPDATED;
    this._log(t, "RESPONSE_BLOCKED", { byStakeholderId, blockedReason, blockerOwnerId });
    this._touch(t);
    return t;
  }

  /** Done response. Caller decides requiresVerification based on whether the
   *  related object is a Critical Deliverable (Part 20 rule; kept outside the
   *  store so the classification logic stays in one place — rules.js/index.js). */
  respondDone(id, byStakeholderId, requiresVerification) {
    const t = this._require(id);
    this._assertWaiting(t);
    t.responses.push({ type: "done", by: byStakeholderId, at: new Date().toISOString() });
    if (requiresVerification) {
      t.status = STATUS.PENDING_VERIFICATION;
      this._log(t, "RESPONSE_DONE_PENDING_VERIFICATION", { byStakeholderId });
    } else {
      t.status = STATUS.CLOSED;
      this._log(t, "RESPONSE_DONE_CLOSED", { byStakeholderId });
    }
    this._touch(t);
    return t;
  }

  /** Change ETA response. impactsCriticalPath decides whether it auto-applies
   *  or must go back to Delivery Control Room as Pending Approval. */
  respondChangeEta(id, byStakeholderId, newEta, reason, impactsCriticalPath) {
    const t = this._require(id);
    this._assertWaiting(t);
    t.responses.push({
      type: "change-eta",
      by: byStakeholderId,
      at: new Date().toISOString(),
      newEta,
      reason,
      impactsCriticalPath,
      etaApprovalStatus: impactsCriticalPath ? "pending" : "auto-applied",
    });
    t.status = impactsCriticalPath ? STATUS.PENDING_REVIEW : STATUS.UPDATED;
    this._log(t, impactsCriticalPath ? "CHANGE_ETA_PENDING_APPROVAL" : "CHANGE_ETA_AUTO_APPLIED", {
      byStakeholderId,
      newEta,
      reason,
    });
    if (!impactsCriticalPath) {
      t.status = STATUS.CLOSED;
      this._log(t, "CLOSED", { reason: "ETA change auto-applied, ticket resolved" });
    }
    this._touch(t);
    return t;
  }

  submitEvidence(id, submittedBy, evidenceType, ref) {
    const t = this._require(id);
    if (t.status !== STATUS.PENDING_VERIFICATION) throw new Error(`Ticket ${id} is not Pending Verification`);
    t.evidence.push({ type: evidenceType, ref, submittedBy, at: new Date().toISOString() });
    this._log(t, "EVIDENCE_SUBMITTED", { submittedBy, evidenceType, ref });
    this._touch(t);
    return t;
  }

  verify(id, verifiedBy, outcome /* 'pass' | 'fail' */) {
    const t = this._require(id);
    if (t.status !== STATUS.PENDING_VERIFICATION) throw new Error(`Ticket ${id} is not Pending Verification`);
    t.verification = { verifiedBy, outcome, at: new Date().toISOString() };
    if (outcome === "pass") {
      t.status = STATUS.CLOSED;
      this._log(t, "VERIFIED_CLOSED", { verifiedBy });
    } else {
      t.status = STATUS.WAITING_FOR_RESPONSE;
      this._log(t, "VERIFICATION_FAILED_REOPENED", { verifiedBy });
    }
    this._touch(t);
    return t;
  }

  /** Reminder must be proposed then approved — Luna never sends it unilaterally. */
  proposeReminder(id) {
    const t = this._require(id);
    this._assertWaiting(t);
    this._log(t, "REMINDER_PROPOSED", {});
    this._touch(t);
    return t;
  }

  approveReminder(id, reviewerName) {
    const t = this._require(id);
    t.reminderCount += 1;
    this._log(t, "REMINDER_APPROVED_AND_SENT", { reviewerName, reminderCount: t.reminderCount });
    this._touch(t);
    return t;
  }

  skipReminder(id, reviewerName) {
    const t = this._require(id);
    this._log(t, "REMINDER_SKIPPED", { reviewerName });
    this._touch(t);
    return t;
  }

  proposeEscalation(id, toStakeholderId) {
    const t = this._require(id);
    this._assertWaiting(t);
    t.escalation = { proposedAt: new Date().toISOString(), to: toStakeholderId, approvedAt: null, executedAt: null };
    this._log(t, "ESCALATION_PROPOSED", { to: toStakeholderId });
    this._touch(t);
    return t;
  }

  approveEscalation(id, reviewerName) {
    const t = this._require(id);
    if (!t.escalation) throw new Error(`No escalation proposed for ${id}`);
    t.escalation.approvedAt = new Date().toISOString();
    t.escalation.executedAt = new Date().toISOString();
    this._log(t, "ESCALATION_APPROVED_AND_SENT", { reviewerName, to: t.escalation.to });
    this._touch(t);
    return t;
  }

  get(id) {
    return this._require(id);
  }

  /**
   * Discard a ticket outright. Used when its review card could not be delivered to the Control
   * Room: a ticket nobody can see must not stay in the store, because dedupe would then suppress
   * every future re-trigger for that task and the ticket would be invisible forever.
   */
  remove(id) {
    delete this.state.tickets[id];
    this._save();
  }

  list() {
    return Object.values(this.state.tickets);
  }

  _require(id) {
    const t = this.state.tickets[id];
    if (!t) throw new Error(`Unknown ticket ${id}`);
    return t;
  }

  _assertWaiting(t) {
    if (t.status !== STATUS.WAITING_FOR_RESPONSE) {
      throw new Error(`Ticket ${t.id} is not Waiting for Response (current: ${t.status})`);
    }
  }

  _touch(t) {
    t.updatedAt = new Date().toISOString();
    this._save();
  }
}

module.exports = { TicketStore, STATUS, REJECT_REASONS, BLOCKED_REASONS };
