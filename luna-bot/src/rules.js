"use strict";
/**
 * Trigger + Business Rule engine.
 * Implements PRD Part 7 (Business Rules) and Part 11 (V1 Luna Trigger) exactly:
 *   - Root Blocker / Hard Dependency propagation
 *   - Blocker Owner vs Task Owner routing (Part 12 of the source brief)
 *   - The six V1 trigger scenarios
 *   - Escalation thresholds are read from config, never hard-coded twice
 *
 * This module is pure (no I/O, no Teams, no store) so it can be unit-tested
 * and reasoned about without any network or bot dependency.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(d) {
  return d ? new Date(d + "T00:00:00Z") : null;
}

function isOverdue(task, today) {
  if (task.status === "done") return false;
  // overdueOverride lets a human record "this already missed an earlier target
  // and today's date is a re-baselined date, so it counts as overdue even
  // though the raw due date hasn't technically passed yet" — see task 03 in
  // the seed data (missed its original 08/14 target, re-baselined to 08/21).
  if (task.overdueOverride === true) return true;
  if (!task.due) return false;
  return toDate(task.due).getTime() < today.getTime();
}

function isDueSoon(task, today, withinDays) {
  if (!task.due || task.status === "done") return false;
  const due = toDate(task.due).getTime();
  const diffDays = (due - today.getTime()) / DAY_MS;
  return diffDays >= 0 && diffDays <= withinDays;
}

function isMissingEta(task) {
  return !task.due && task.status !== "done";
}

function isStale(task, today, staleDays) {
  if (!task.lastUpdated || task.status === "done") return false;
  const diffDays = (today.getTime() - toDate(task.lastUpdated).getTime()) / DAY_MS;
  return diffDays >= staleDays;
}

/** A task is "unresolved" (i.e. capable of being a Blocker) if it is overdue
 *  or has been explicitly flagged as blocked, and is not done. */
function isUnresolved(task, today) {
  return task.status !== "done" && (isOverdue(task, today) || task.explicitlyBlocked === true);
}

function hardUpstreamMap(dependencies) {
  const map = {};
  dependencies
    .filter((d) => d.type === "hard")
    .forEach((d) => {
      (map[d.to] ||= []).push(d.from);
    });
  return map;
}

/** Root Blocker = unresolved node with no unresolved Hard-Dependency upstream node.
 *  This is a structural, deterministic computation over the dependency graph —
 *  never a subjective model judgement (Part 7 requirement). */
function findRootBlockers(tasks, dependencies, today) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const upstream = hardUpstreamMap(dependencies);
  return tasks.filter((t) => {
    if (!isUnresolved(t, today)) return false;
    const ups = upstream[t.id] || [];
    return !ups.some((upId) => byId[upId] && isUnresolved(byId[upId], today));
  });
}

/** BFS forward along Hard Dependency edges only — Blocker propagation must never
 *  cross a Soft Dependency or a Part-of edge (Part 7 requirement). */
function downstreamImpact(rootId, dependencies) {
  const hardEdges = dependencies.filter((d) => d.type === "hard");
  const visited = new Set();
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    hardEdges
      .filter((e) => e.from === cur)
      .forEach((e) => {
        if (!visited.has(e.to)) {
          visited.add(e.to);
          queue.push(e.to);
        }
      });
  }
  return [...visited];
}

/**
 * Decide who Luna should route a Ticket to for a given task.
 * Implements: "只要一个 Task 处于 Blocked 状态且能够追溯到一个仍未解决的
 * Root Blocker，Luna 的下一轮跟进对象必须是 Root Blocker 的 Blocker Owner，
 * 而不是该 Task 的 Task Owner。"
 */
function resolveOwner(taskId, program, today) {
  const { tasks, dependencies, taskOwnerMap, blockerOwnerOverride } = program;
  const roots = findRootBlockers(tasks, dependencies, today);
  for (const root of roots) {
    const impacted = downstreamImpact(root.id, dependencies);
    if (root.id === taskId || impacted.includes(taskId)) {
      return {
        role: "blockerOwner",
        rootBlockerId: root.id,
        ownerIds: [].concat(blockerOwnerOverride[root.id] || taskOwnerMap[root.id] || []),
      };
    }
  }
  return {
    role: "taskOwner",
    rootBlockerId: null,
    ownerIds: [].concat(taskOwnerMap[taskId] || []),
  };
}

function impactChainFor(taskId, program, today) {
  const roots = findRootBlockers(program.tasks, program.dependencies, today);
  const root = roots.find(
    (r) => r.id === taskId || downstreamImpact(r.id, program.dependencies).includes(taskId)
  );
  if (!root) return [taskId];
  const chain = [root.id];
  // Walk hard edges from root to the target task (first path found — good enough
  // for a human-readable Impact line on the Ticket card).
  const hardEdges = program.dependencies.filter((d) => d.type === "hard");
  function walk(cur, target, path) {
    if (cur === target) return path;
    for (const e of hardEdges.filter((x) => x.from === cur)) {
      const res = walk(e.to, target, [...path, e.to]);
      if (res) return res;
    }
    return null;
  }
  const path = walk(root.id, taskId, [root.id]);
  return path || chain;
}

/**
 * The V1 trigger set (PRD Part 11), evaluated once per task per run.
 * Config thresholds (dueSoonDays, staleDays) are intentionally passed in,
 * never hard-coded, so they stay per-Program configurable.
 */
function detectTriggers(program, config, today = toDate(program.today)) {
  const events = [];
  for (const task of program.tasks) {
    const owner = resolveOwner(task.id, program, today);
    const isCritical = owner.role === "blockerOwner" || task.ms != null;

    if (!isCritical) continue; // Part 11: only fire on Critical Task, never scan everything indiscriminately

    if (isOverdue(task, today) && owner.rootBlockerId === task.id) {
      events.push(mkEvent("overdue_root_blocker", task, program, owner, today,
        `${task.name} is overdue and is the current Root Blocker for the downstream chain.`));
    } else if (owner.role === "blockerOwner" && owner.rootBlockerId !== task.id) {
      events.push(mkEvent("blocked_by_upstream", task, program, owner, today,
        `${task.name} is blocked by an unresolved upstream item (${owner.rootBlockerId}).`));
    } else if (isOverdue(task, today)) {
      events.push(mkEvent("overdue", task, program, owner, today, `${task.name} is overdue.`));
    }

    if (isDueSoon(task, today, config.dueSoonDays) && !isOverdue(task, today)) {
      events.push(mkEvent("due_soon", task, program, owner, today,
        `${task.name} is due within ${config.dueSoonDays} day(s) and is not yet complete.`));
    }

    if (isMissingEta(task)) {
      events.push(mkEvent("missing_eta", task, program, owner, today,
        `${task.name} has no target date set.`));
    }

    if (isStale(task, today, config.staleDays)) {
      events.push(mkEvent("stale", task, program, owner, today,
        `${task.name} has not been updated in ${config.staleDays}+ days.`));
    }
  }
  return events;
}

function mkEvent(type, task, program, owner, today, reason) {
  return {
    type,
    taskId: task.id,
    reason,
    suggestedOwnerIds: owner.ownerIds,
    ownerRole: owner.role,
    rootBlockerId: owner.rootBlockerId,
    relatedMilestone: task.ms || null,
    impactChain: impactChainFor(task.id, program, today),
    detectedAt: new Date().toISOString(),
  };
}

/** Ad-hoc trigger for Meeting-derived actions — the sixth V1 scenario.
 *  Meeting parsing itself lives in Delivery Copilot's Meetings page (Part 4);
 *  this is the seam Luna's rule engine exposes for that page to call into. */
function triggerFromMeetingAction(action, program, today = toDate(program.today)) {
  const owner = action.relatedTask
    ? resolveOwner(action.relatedTask, program, today)
    : { role: "taskOwner", rootBlockerId: null, ownerIds: [] };
  return {
    type: "meeting_action",
    taskId: action.relatedTask || null,
    reason: action.title,
    suggestedOwnerIds: owner.ownerIds,
    ownerRole: owner.role,
    rootBlockerId: owner.rootBlockerId,
    relatedMilestone: action.relatedMilestone || null,
    impactChain: action.relatedTask ? impactChainFor(action.relatedTask, program, today) : [],
    detectedAt: new Date().toISOString(),
    sourceMeetingId: action.meetingId || null,
  };
}

module.exports = {
  toDate,
  isOverdue,
  isDueSoon,
  isMissingEta,
  isStale,
  isUnresolved,
  findRootBlockers,
  downstreamImpact,
  resolveOwner,
  impactChainFor,
  detectTriggers,
  triggerFromMeetingAction,
};
