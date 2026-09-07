"use strict";
/**
 * Turns a trigger event into the human-readable draft text Luna proposes.
 * Kept separate from rules.js (which only knows the graph, not English prose)
 * and from cards.js (which only knows Adaptive Card JSON, not wording).
 */

function formatImpactChain(chain, tasksById) {
  return chain.map((id) => (tasksById[id] ? tasksById[id].name || id : id)).join(" → ");
}

function draftMessage(event, program) {
  const tasksById = Object.fromEntries(program.tasks.map((t) => [t.id, t]));
  const task = tasksById[event.taskId];
  const chain = formatImpactChain(event.impactChain, tasksById);

  const byType = {
    overdue_root_blocker: `${task.name} is currently overdue and is blocking downstream work. Please confirm the latest status and expected completion date.`,
    blocked_by_upstream: `${task.name} is blocked pending ${tasksById[event.rootBlockerId]?.name || event.rootBlockerId}. No action needed from you until that upstream item clears — this note is for visibility only.`,
    overdue: `${task.name} is overdue. Please confirm the latest status and expected completion date.`,
    due_soon: `${task.name} is due soon and not yet marked complete. Please confirm it is on track to finish by ${task.due}.`,
    missing_eta: `${task.name} does not have a target date set. Please provide an expected completion date.`,
    stale: `${task.name} has not been updated recently. Please share a status update.`,
    meeting_action: event.reason,
  };

  return {
    reasonForTrigger: event.reason,
    suggestedMessage: byType[event.type] || event.reason,
    impactChainText: chain,
  };
}

module.exports = { draftMessage, formatImpactChain };
