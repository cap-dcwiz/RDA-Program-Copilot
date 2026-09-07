"use strict";
/**
 * Wires Adaptive Card Action.Submit payloads to the Ticket state machine.
 * Every branch here corresponds to one arrow in the Part 5 workflow diagram
 * in the PRD — if you're looking for where "Approve & Push" actually does
 * something, this is the one file to read.
 */
const { TeamsActivityHandler, CardFactory, MessageFactory } = require("botbuilder");
const cards = require("./cards");
const conversationRefs = require("./conversationRefs");

const REGISTER_CONTROL_ROOM = "/luna register control-room";
const REGISTER_PROJECT_GROUP = "/luna register project-group";

class LunaBot extends TeamsActivityHandler {
  /**
   * @param {import('./store').TicketStore} store
   * @param {object} program  seed program data (tasks/deps/stakeholders)
   * @param {object} config   thresholds + conversation ref file paths
   * @param {(name: string) => Promise<void>} sendToProjectGroup  proactive sender
   */
  constructor(store, program, config, sendToProjectGroup) {
    super();
    this.store = store;
    this.program = program;
    this.config = config;
    this.sendToProjectGroup = sendToProjectGroup;

    this.onMessage(async (context, next) => {
      const text = (context.activity.text || "").trim();

      if (text === REGISTER_CONTROL_ROOM) {
        conversationRefs.save(this.config.TEAMS_CONTROL_ROOM_CONVERSATION_REF_PATH, context.activity);
        await context.sendActivity("Registered this channel as the Delivery Control Room. Luna will post Ticket reviews here.");
        return next();
      }
      if (text === REGISTER_PROJECT_GROUP) {
        conversationRefs.save(this.config.TEAMS_PROJECT_GROUP_CONVERSATION_REF_PATH, context.activity);
        await context.sendActivity("Registered this channel as the Project Delivery Group. Luna will post approved Tickets here.");
        return next();
      }

      const data = context.activity.value; // Adaptive Card Action.Submit payload
      if (data && data.verb) {
        await this._dispatch(context, data);
        return next();
      }

      await context.sendActivity(
        "Hi, I'm Luna. I only act on Tickets that have gone through Delivery Control Room review — I don't respond to free text here."
      );
      await next();
    });
  }

  async _dispatch(context, data) {
    const reviewerName = context.activity.from?.name || "unknown";
    const t = data.ticketId;

    switch (data.verb) {
      case "approve": {
        this.store.approve(t, reviewerName, {});
        await context.sendActivity(`Approved ${t}. Publishing to the Project Delivery Group.`);
        await this._publish(t);
        break;
      }
      case "approve_edited": {
        const edits = {
          recipientIds: (data.recipient || "").split(",").map((s) => s.trim()).filter(Boolean),
          message: { ...this.store.get(t).draft.message, suggestedMessage: data.message },
          priority: data.priority,
          dueDate: data.dueDate || null,
        };
        this.store.approve(t, reviewerName, edits);
        await context.sendActivity(`Approved ${t} (edited). Publishing to the Project Delivery Group.`);
        await this._publish(t);
        break;
      }
      case "reject": {
        this.store.reject(t, reviewerName, data.reason);
        await context.sendActivity(`Rejected ${t}: ${data.reason}. Kept in Closed for audit.`);
        break;
      }
      case "approve_reminder": {
        this.store.approveReminder(t, reviewerName);
        await this._publish(t, { reminder: true });
        await context.sendActivity(`Reminder sent for ${t}.`);
        break;
      }
      case "skip_reminder": {
        this.store.skipReminder(t, reviewerName);
        await context.sendActivity(`Skipped reminder for ${t}.`);
        break;
      }
      case "propose_escalation": {
        const ticket = this.store.get(t);
        const toName = this.program.stakeholders.find((s) => s.id === ticket.rootBlockerId)?.name || "manager";
        this.store.proposeEscalation(t, toName);
        await context.sendActivity(`Escalation proposed for ${t}. Awaiting Delivery Control Room approval.`);
        break;
      }
      case "approve_escalation": {
        this.store.approveEscalation(t, reviewerName);
        await context.sendActivity(`Escalation for ${t} approved and sent.`);
        break;
      }
      case "skip_escalation": {
        await context.sendActivity(`Escalation for ${t} skipped for now.`);
        break;
      }
      case "on_track": {
        this.store.respondOnTrack(t, reviewerName, data.etaStillValid === true || data.etaStillValid === "true");
        await context.sendActivity(`Thanks — recorded On Track for ${t}.`);
        break;
      }
      case "blocked": {
        this.store.respondBlocked(t, reviewerName, data.blockedReason, data.blockerOwner);
        await context.sendActivity(`Recorded Blocked for ${t}. Next follow-up will route to ${data.blockerOwner || "the blocker owner"}.`);
        break;
      }
      case "done": {
        const ticket = this.store.get(t);
        const requiresVerification = ticket.relatedMilestone != null; // Critical Deliverable rule, Part 20/21
        this.store.respondDone(t, reviewerName, requiresVerification);
        await context.sendActivity(
          requiresVerification
            ? `${t} marked Done — this is a Critical Deliverable, so it now needs Evidence and verification before it closes.`
            : `${t} marked Done and closed.`
        );
        break;
      }
      case "change_eta": {
        const ticket = this.store.get(t);
        const impactsCriticalPath = ticket.relatedMilestone != null; // simplified Critical Path check, Part 21
        this.store.respondChangeEta(t, reviewerName, data.newEta, data.reason, impactsCriticalPath);
        await context.sendActivity(
          impactsCriticalPath
            ? `New ETA for ${t} touches the Critical Path — sent to Delivery Control Room for approval before it applies.`
            : `New ETA for ${t} applied.`
        );
        break;
      }
      default:
        await context.sendActivity(`Unrecognized action: ${data.verb}`);
    }
  }

  /** Sends the approved Ticket card to the Project Delivery Group. */
  async _publish(ticketId) {
    const ticket = this.store.get(ticketId);
    const card = CardFactory.adaptiveCard(cards.ticketCard(ticket, this.program));
    await this.sendToProjectGroup(MessageFactory.attachment(card));
  }
}

module.exports = { LunaBot };
