"use strict";
/**
 * Adaptive Card builders. Every Action.Submit carries a `verb` in its data
 * payload — bot.js dispatches on that single field, so adding a new card
 * never means touching the routing logic in more than one place.
 */

const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

function wrap(body, actions = []) {
  return {
    type: "AdaptiveCard",
    $schema: SCHEMA,
    version: "1.5",
    body,
    actions,
  };
}

function fact(title, value) {
  return { title, value: String(value ?? "—") };
}

/** Posted in the Delivery Control Room. Mirrors the "Luna · Ticket Review" card
 *  from the source brief exactly: reason, suggested recipient, suggested
 *  message, status, due date, milestone, impact, then Approve/Edit/Reject. */
function reviewCard(ticket, program) {
  const recipients = ticket.draft.recipientIds
    .map((id) => program.stakeholders.find((s) => s.id === id)?.name || id)
    .join(", ");
  return wrap(
    [
      { type: "TextBlock", text: "Luna · Ticket Review", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: `Proposed Delivery Ticket #${ticket.id}`, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: "Reason for Trigger", weight: "Bolder", spacing: "Medium" },
      { type: "TextBlock", text: ticket.triggerReason, wrap: true },
      { type: "TextBlock", text: "Suggested Recipient", weight: "Bolder", spacing: "Medium" },
      { type: "TextBlock", text: `@${recipients}${ticket.ownerRole === "blockerOwner" ? "  (Blocker Owner, not Task Owner)" : ""}`, wrap: true },
      { type: "TextBlock", text: "Suggested Message", weight: "Bolder", spacing: "Medium" },
      { type: "TextBlock", text: ticket.draft.message.suggestedMessage, wrap: true },
      {
        type: "FactSet",
        spacing: "Medium",
        facts: [
          fact("Current Status", ticket.triggerType),
          fact("Due Date", ticket.draft.dueDate || program.tasks.find((t) => t.id === ticket.relatedTaskId)?.due),
          fact("Related Milestone", ticket.relatedMilestone),
        ],
      },
      { type: "TextBlock", text: "Impact", weight: "Bolder", spacing: "Medium" },
      { type: "TextBlock", text: ticket.draft.message.impactChainText, wrap: true },
    ],
    [
      { type: "Action.Submit", title: "Approve & Push", data: { verb: "approve", ticketId: ticket.id } },
      { type: "Action.ShowCard", title: "Edit", card: editSubCard(ticket) },
      { type: "Action.ShowCard", title: "Reject", card: rejectSubCard(ticket) },
    ]
  );
}

function editSubCard(ticket) {
  return wrap(
    [
      { type: "Input.Text", id: "recipient", label: "Recipient", value: ticket.draft.recipientIds.join(", ") },
      { type: "Input.Text", id: "message", label: "Message", isMultiline: true, value: ticket.draft.message.suggestedMessage },
      {
        type: "Input.ChoiceSet",
        id: "priority",
        label: "Priority",
        value: ticket.draft.priority,
        choices: [
          { title: "High", value: "high" },
          { title: "Medium", value: "medium" },
          { title: "Low", value: "low" },
        ],
      },
      { type: "Input.Date", id: "dueDate", label: "Due Date", value: ticket.draft.dueDate || undefined },
      { type: "Input.Toggle", id: "includeChain", title: "Include dependency chain in message", value: "true" },
    ],
    [{ type: "Action.Submit", title: "Approve edited version", data: { verb: "approve_edited", ticketId: ticket.id } }]
  );
}

function rejectSubCard(ticket) {
  const reasons = [
    "Wrong Owner",
    "Not Worth Following Up",
    "Information Outdated",
    "Already Resolved",
    "Wrong Dependency",
    "Bad Timing",
    "Duplicate Ticket",
    "Other",
  ];
  return wrap(
    [
      {
        type: "Input.ChoiceSet",
        id: "reason",
        label: "Reject reason",
        choices: reasons.map((r) => ({ title: r, value: r })),
      },
    ],
    [{ type: "Action.Submit", title: "Confirm Reject", data: { verb: "reject", ticketId: ticket.id } }]
  );
}

/** Posted in the Project Delivery Group after approval. Mirrors the
 *  "Luna · Delivery Copilot / Action Required" card from the source brief. */
function ticketCard(ticket, program) {
  const recipients = ticket.final.recipientIds
    .map((id) => program.stakeholders.find((s) => s.id === id)?.name || id)
    .join(", ");
  const task = program.tasks.find((t) => t.id === ticket.relatedTaskId);
  return wrap(
    [
      { type: "TextBlock", text: "Luna · Delivery Copilot", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: `Action Required · ${ticket.id}`, weight: "Bolder" },
      { type: "TextBlock", text: task?.name || ticket.relatedTaskId, wrap: true, size: "Medium" },
      { type: "TextBlock", text: `@${recipients}`, wrap: true },
      { type: "TextBlock", text: ticket.final.message.suggestedMessage, wrap: true, spacing: "Medium" },
      {
        type: "FactSet",
        facts: [
          fact("Current Status", ticket.triggerType),
          fact("Target Date", ticket.final.dueDate || task?.due),
          fact("Related Milestone", ticket.relatedMilestone),
        ],
      },
      { type: "TextBlock", text: "Impact", weight: "Bolder" },
      { type: "TextBlock", text: ticket.final.message.impactChainText, wrap: true },
      { type: "TextBlock", text: "Maintained by Luna", isSubtle: true, size: "Small", spacing: "Medium" },
    ],
    [
      { type: "Action.ShowCard", title: "On Track", card: onTrackSubCard(ticket) },
      { type: "Action.ShowCard", title: "Blocked", card: blockedSubCard(ticket) },
      { type: "Action.Submit", title: "Done", data: { verb: "done", ticketId: ticket.id } },
      { type: "Action.ShowCard", title: "Change ETA", card: changeEtaSubCard(ticket) },
    ]
  );
}

function onTrackSubCard(ticket) {
  return wrap(
    [{ type: "TextBlock", text: "Is the current ETA still valid?", wrap: true }],
    [
      { type: "Action.Submit", title: "Yes, ETA still valid", data: { verb: "on_track", ticketId: ticket.id, etaStillValid: true } },
      { type: "Action.Submit", title: "No, needs a new ETA", data: { verb: "on_track", ticketId: ticket.id, etaStillValid: false } },
    ]
  );
}

function blockedSubCard(ticket) {
  const reasons = [
    "Waiting for Data",
    "Waiting for Customer",
    "Waiting for API",
    "Waiting for Approval",
    "Technical Issue",
    "Resource Issue",
    "Other",
  ];
  return wrap(
    [
      { type: "Input.ChoiceSet", id: "blockedReason", label: "What is blocking this item?", choices: reasons.map((r) => ({ title: r, value: r })) },
      { type: "Input.Text", id: "blockerOwner", label: "Who owns the blocker? (name)" },
    ],
    [{ type: "Action.Submit", title: "Submit", data: { verb: "blocked", ticketId: ticket.id } }]
  );
}

function changeEtaSubCard(ticket) {
  return wrap(
    [
      { type: "Input.Date", id: "newEta", label: "New ETA" },
      { type: "Input.Text", id: "reason", label: "Reason", isMultiline: true },
    ],
    [{ type: "Action.Submit", title: "Submit", data: { verb: "change_eta", ticketId: ticket.id } }]
  );
}

/** Control Room reminder proposal. Luna never sends a reminder unilaterally. */
function reminderProposalCard(ticket, recipientName) {
  return wrap(
    [
      { type: "TextBlock", text: "Luna · Suggested Action", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: `No response for ${ticket.reminderCount === 0 ? "48+" : "another 48+"} hours on ${ticket.id}.`, wrap: true },
      { type: "TextBlock", text: `Suggested Action: Send Reminder to @${recipientName}`, wrap: true, weight: "Bolder" },
    ],
    [
      { type: "Action.Submit", title: "Approve Reminder", data: { verb: "approve_reminder", ticketId: ticket.id } },
      { type: "Action.ShowCard", title: "Edit", card: editSubCard(ticket) },
      { type: "Action.Submit", title: "Skip", data: { verb: "skip_reminder", ticketId: ticket.id } },
      { type: "Action.Submit", title: "Escalate", data: { verb: "propose_escalation", ticketId: ticket.id } },
    ]
  );
}

/** Control Room escalation proposal. */
function escalationProposalCard(ticket, escalateToName, daysOverdue) {
  return wrap(
    [
      { type: "TextBlock", text: "Luna · Suggested Escalation", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: `${ticket.id} has been overdue for ${daysOverdue} days. Follow-ups have received no confirmed ETA.`, wrap: true },
      { type: "TextBlock", text: `Suggested escalation: @${escalateToName}`, wrap: true, weight: "Bolder" },
    ],
    [
      { type: "Action.Submit", title: "Approve Escalation", data: { verb: "approve_escalation", ticketId: ticket.id } },
      { type: "Action.Submit", title: "Skip", data: { verb: "skip_escalation", ticketId: ticket.id } },
    ]
  );
}

module.exports = {
  reviewCard,
  ticketCard,
  reminderProposalCard,
  escalationProposalCard,
};
