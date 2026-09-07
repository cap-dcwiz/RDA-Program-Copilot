"use strict";
/**
 * Derives which of the six Luna Queue tabs (PRD Part 6) a ticket currently
 * belongs to. This is computed on read, never stored, so the state machine
 * in store.js stays the single source of truth and the two can never drift
 * out of sync with each other.
 */
const { STATUS } = require("./store");

const TABS = [
  "pendingReview",
  "published",
  "waitingForResponse",
  "escalation",
  "pendingVerification",
  "closed",
];

function tabFor(ticket, now, config) {
  if (ticket.status === STATUS.REJECTED || ticket.status === STATUS.CLOSED) return "closed";
  if (ticket.status === STATUS.PENDING_REVIEW) {
    // A Change-ETA-triggered re-review still shows here, not back in "published".
    return "pendingReview";
  }
  if (ticket.status === STATUS.PENDING_VERIFICATION) return "pendingVerification";
  if (ticket.status === STATUS.WAITING_FOR_RESPONSE) {
    if (ticket.escalation && ticket.escalation.proposedAt) return "escalation";
    const hoursSincePublish = (now - new Date(ticket.publishedAt)) / 3600000;
    if (ticket.reminderCount === 0 && hoursSincePublish < config.REMINDER_THRESHOLD_HOURS) {
      return "published";
    }
    return "waitingForResponse";
  }
  // UPDATED (e.g. a Blocked response was just recorded, or a non-critical
  // Change ETA auto-applied and is about to close) has no dedicated PRD tab —
  // it's a transient state on its way back into the loop, so it surfaces
  // under Waiting for Response until the next detection cycle or closure.
  return "waitingForResponse";
}

function groupByTab(tickets, config, now = new Date()) {
  const groups = Object.fromEntries(TABS.map((t) => [t, []]));
  for (const t of tickets) {
    groups[tabFor(t, now, config)].push(t);
  }
  return groups;
}

module.exports = { TABS, tabFor, groupByTab };
