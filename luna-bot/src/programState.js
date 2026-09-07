"use strict";
/**
 * Program data that can be updated at runtime.
 *
 * The seed file (data/program.seed.json) stays the immutable starting point. Changes approved
 * in the Delivery Copilot dashboard arrive through POST /api/apply-changes and are recorded as
 * an overlay in data/program.state.json, which is re-applied on every boot. Two reasons for an
 * overlay rather than rewriting the seed:
 *   · the seed stays readable as "what the program looked like at kickoff", and a bad push can
 *     be undone by deleting one file;
 *   · the overlay is a plain audit list of what the dashboard changed and when.
 *
 * get() always returns the SAME object instance, mutated in place, so anything holding a
 * reference to the program (LunaBot, in-flight requests) sees updates without being rewired.
 */
const fs = require("fs");
const path = require("path");

const KNOWN_FIELDS = new Set(["status", "due", "health", "progress", "next", "ge", "targetOriginal", "owner", "ms"]);

class ProgramState {
  constructor(seedPath, statePath) {
    this.seedPath = seedPath;
    this.statePath = statePath;
    this.seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    this.state = this._loadState();
    this.program = this._build();
  }

  _loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return { updatedAt: null, taskOverrides: {}, meetingActions: [] };
    }
  }

  _save() {
    this.state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /** Rebuild the live program object from seed + overlay, mutating in place. */
  _build() {
    const s = this.seed;
    const tasks = s.tasks.map((t) => {
      const over = this.state.taskOverrides[t.id];
      return over ? Object.assign({}, t, over) : Object.assign({}, t);
    });
    if (!this.program) {
      this.program = {
        id: s.program.id,
        today: s.program.today,
        tasks,
        dependencies: s.dependencies,
        stakeholders: s.stakeholders,
        taskOwnerMap: s.taskOwnerMap,
        blockerOwnerOverride: s.blockerOwnerOverride,
        milestones: s.milestones,
      };
    } else {
      // In place, so existing references stay valid.
      this.program.tasks.length = 0;
      tasks.forEach((t) => this.program.tasks.push(t));
    }
    return this.program;
  }

  get() {
    return this.program;
  }

  /**
   * Apply a batch of approved dashboard changes.
   * @param {Array} changes  [{taskId, field, value}] — one approved Change Proposal each
   * @param {Array} actions  [{title, owner, due, relatedTask, meetingId}] — approved meeting actions
   * @param {object} meta    {meetingId, meetingTitle, meetingDate}
   * @returns {{applied: Array, skipped: Array, actions: Array}}
   */
  applyChanges(changes = [], actions = [], meta = {}) {
    const applied = [];
    const skipped = [];

    for (const c of changes) {
      const task = this.seed.tasks.find((t) => t.id === c.taskId);
      if (!task) {
        // The dashboard tracks the full 18-task roadmap; this bot only carries the subset that
        // matters for blocker routing. Silently dropping would hide that, so it is reported back.
        skipped.push({ ...c, reason: "unknown task in this bot's program data" });
        continue;
      }
      if (!KNOWN_FIELDS.has(c.field)) {
        skipped.push({ ...c, reason: `unsupported field "${c.field}"` });
        continue;
      }
      const over = (this.state.taskOverrides[c.taskId] ||= {});
      const prev = over[c.field] !== undefined ? over[c.field] : task[c.field];
      over[c.field] = c.value;

      // A confirmed new target date means the team re-baselined, so the "already missed an
      // earlier target" flag must not keep forcing this task Overdue forever (see isOverdue).
      if ((c.field === "due" || c.field === "targetOriginal") && c.value && c.value > this.program.today) {
        over.overdueOverride = false;
      }
      // The dashboard records blockage as status:'blocked'; the rule engine tests
      // explicitlyBlocked (see isUnresolved). Without this bridge a task the meeting reported
      // blocked would still route to its Task Owner instead of the Blocker Owner.
      if (c.field === "status") over.explicitlyBlocked = c.value === "blocked";
      applied.push({ taskId: c.taskId, field: c.field, from: prev, to: c.value });
    }

    for (const a of actions) {
      this.state.meetingActions.push({
        id: `MA-${this.state.meetingActions.length + 1}`,
        title: a.title,
        owner: a.owner || null,
        due: a.due || null,
        relatedTask: a.relatedTask || null,
        meetingId: meta.meetingId || a.meetingId || null,
        meetingTitle: meta.meetingTitle || null,
        receivedAt: new Date().toISOString(),
      });
    }

    this._build();
    this._save();
    return { applied, skipped, actions: this.state.meetingActions.slice(-actions.length || 0) };
  }
}

module.exports = { ProgramState, KNOWN_FIELDS };
