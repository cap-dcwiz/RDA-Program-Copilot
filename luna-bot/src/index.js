"use strict";
require("dotenv").config();
const path = require("path");
const restify = require("restify");
const {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  MessageFactory,
  CardFactory,
} = require("botbuilder");

const { LunaBot } = require("./bot");
const { TicketStore } = require("./store");
const { detectTriggers, triggerFromMeetingAction } = require("./rules");
const { draftMessage } = require("./messages");
const { groupByTab } = require("./queueView");
const { ProgramState } = require("./programState");
const cards = require("./cards");
const conversationRefs = require("./conversationRefs");

// Seed + runtime overlay. `program` is a stable object reference that ProgramState mutates in
// place, so the bot and every request handler always read current data.
const programState = new ProgramState(
  path.resolve(__dirname, "..", "data", "program.seed.json"),
  path.resolve(__dirname, "..", "data", "program.state.json")
);
const program = programState.get();

const config = {
  REMINDER_THRESHOLD_HOURS: Number(process.env.REMINDER_THRESHOLD_HOURS || 48),
  ESCALATION_THRESHOLD_DAYS: Number(process.env.ESCALATION_THRESHOLD_DAYS || 7),
  ESCALATION_MIN_REMINDERS: Number(process.env.ESCALATION_MIN_REMINDERS || 2),
  dueSoonDays: 3,
  staleDays: 5,
  TEAMS_CONTROL_ROOM_CONVERSATION_REF_PATH: path.resolve(
    __dirname,
    "..",
    process.env.TEAMS_CONTROL_ROOM_CONVERSATION_REF_PATH || "./data/control-room-conversation-ref.json"
  ),
  TEAMS_PROJECT_GROUP_CONVERSATION_REF_PATH: path.resolve(
    __dirname,
    "..",
    process.env.TEAMS_PROJECT_GROUP_CONVERSATION_REF_PATH || "./data/project-group-conversation-ref.json"
  ),
};

const store = new TicketStore(path.resolve(__dirname, "..", "data", "tickets.store.json"));

const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: process.env.BOT_APP_ID,
  MicrosoftAppPassword: process.env.BOT_APP_PASSWORD,
  MicrosoftAppTenantId: process.env.BOT_TENANT_ID,
  MicrosoftAppType: process.env.BOT_APP_TYPE || "MultiTenant",
});
const adapter = new CloudAdapter(botFrameworkAuth);

adapter.onTurnError = async (context, error) => {
  console.error("[onTurnError]", error);
  await context.sendActivity("Luna hit an internal error handling that action. It has been logged.");
};

async function sendToConversation(refPath, activity) {
  // LUNA_DRY_RUN=1 exercises the whole pipeline — detection, drafting, card rendering — without
  // a Teams connection, by logging what would have been posted. Useful before the channels are
  // registered, and the only way to test the meeting-action path offline.
  if (process.env.LUNA_DRY_RUN === "1") {
    const card = activity?.attachments?.[0]?.content;
    const title = card?.body?.[0]?.text || card?.body?.[0]?.columns?.[0]?.items?.[0]?.text || "(card)";
    console.log(`[dry-run] would post to ${path.basename(refPath)}: ${title}`);
    return;
  }
  const ref = conversationRefs.load(refPath);
  if (!ref) {
    throw new Error(
      `No conversation registered at ${refPath}. In that Teams channel, send "/luna register control-room" or "/luna register project-group" once.`
    );
  }
  await adapter.continueConversationAsync(process.env.BOT_APP_ID, ref, async (ctx) => {
    await ctx.sendActivity(activity);
  });
}

const sendToProjectGroup = (activity) => sendToConversation(config.TEAMS_PROJECT_GROUP_CONVERSATION_REF_PATH, activity);
const sendToControlRoom = (activity) => sendToConversation(config.TEAMS_CONTROL_ROOM_CONVERSATION_REF_PATH, activity);

const bot = new LunaBot(store, program, config, sendToProjectGroup);

const server = restify.createServer();
server.use(restify.plugins.bodyParser());

// The Delivery Copilot dashboard is opened as a local file, so its requests carry `Origin: null`
// and a JSON content-type triggers a CORS preflight. Allow both — these endpoints are meant to be
// reachable only on a trusted network (see "No auth on the HTTP endpoints" in the README).
server.pre((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ALLOW_ORIGIN || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.send(204);
    return;
  }
  next();
});

/**
 * Draft one trigger event and put its review card in front of a human. Shared by every
 * detection path.
 *
 * Delivery failure rolls the ticket back out of the store on purpose. A ticket sitting in
 * PENDING_REVIEW whose card never arrived is worse than no ticket at all: dedupe would suppress
 * every future re-trigger for that task, so it would stay invisible forever. Dropping it means
 * the next run retries cleanly once the channel is registered.
 */
async function draftAndReview(event, results) {
  const messageDraft = draftMessage(event, program);
  const { ticket, deduped } = store.draftFromTrigger(program.id, event, messageDraft);
  if (deduped) {
    results.push({ ticketId: ticket.id, deduped: true, triggerType: event.type });
    return;
  }
  store.sendForReview(ticket.id);
  try {
    const card = CardFactory.adaptiveCard(cards.reviewCard(ticket, program));
    await sendToControlRoom(MessageFactory.attachment(card));
    results.push({ ticketId: ticket.id, deduped: false, triggerType: event.type, delivered: true });
  } catch (err) {
    store.remove(ticket.id);
    results.push({ ticketId: ticket.id, deduped: false, triggerType: event.type, delivered: false, error: err.message });
  }
}

server.post("/api/messages", async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

/**
 * Operational endpoint: run the rule engine, draft any new Tickets, and post
 * their Review Cards into the Delivery Control Room. This is what a scheduler
 * (cron, Azure Function timer, etc.) should call periodically in production —
 * kept as an explicit HTTP call in V1 rather than an in-process setInterval so
 * it is easy to trigger on demand while testing.
 */
server.post("/api/run-detection", async (req, res) => {
  const events = detectTriggers(program, config);
  const results = [];
  for (const event of events) await draftAndReview(event, results);
  const undelivered = results.filter((r) => r.delivered === false);
  res.send({ evaluated: events.length, results, deliveryError: undelivered.length ? undelivered[0].error : null });
});

/**
 * The meeting-minutes path. The Delivery Copilot dashboard extracts Change Proposals from
 * imported minutes, a human approves them there, and the approved set is pushed here.
 *
 * This endpoint is deliberately the *second* gate, not the first: the dashboard's approval says
 * "this is what the meeting actually decided", and Luna's own Control Room review still decides
 * "and this is what we chase someone about". Nothing reaches the Project Delivery Group without
 * both. Approved changes are written to program state first, so detection re-runs against the
 * post-meeting picture — a task whose date the meeting re-baselined stops looking overdue, and a
 * task the meeting reported blocked starts routing to its Blocker Owner.
 *
 * Body: { meetingId, meetingTitle, meetingDate,
 *         changes: [{taskId, field, value}], actions: [{title, owner, due, relatedTask}] }
 */
server.post("/api/apply-changes", async (req, res) => {
  const body = req.body || {};
  const meta = { meetingId: body.meetingId, meetingTitle: body.meetingTitle, meetingDate: body.meetingDate };
  const { applied, skipped } = programState.applyChanges(body.changes || [], body.actions || [], meta);

  const results = [];
  // 1. Re-detect against the updated program picture.
  for (const event of detectTriggers(program, config)) await draftAndReview(event, results);
  // 2. Meeting action items become their own tickets (PRD Part 11, meeting_action trigger).
  for (const a of body.actions || []) {
    if (!a.relatedTask) continue;
    await draftAndReview(triggerFromMeetingAction({ ...a, meetingId: meta.meetingId }, program), results);
  }

  // The program changes are saved either way; delivery is reported separately so a caller can
  // tell "nothing needed chasing" apart from "Teams is not wired up yet".
  const undelivered = results.filter((r) => r.delivered === false);
  res.send({
    applied, skipped,
    drafted: results.filter((r) => r.delivered === true).length,
    deduped: results.filter((r) => r.deduped).length,
    results,
    deliveryError: undelivered.length ? undelivered[0].error : null,
  });
});

/**
 * Operational endpoint: sweep tickets waiting for response and propose
 * Reminders / Escalations per the configured thresholds. Never sends
 * anything itself — only posts a proposal card to the Control Room.
 */
server.post("/api/run-followups", async (req, res) => {
  const now = new Date();
  const { waitingForResponse, escalation } = groupByTab(store.list(), config, now);
  const proposed = [];

  for (const ticket of waitingForResponse) {
    store.proposeReminder(ticket.id);
    const recipientName =
      program.stakeholders.find((s) => ticket.final.recipientIds.includes(s.id))?.name || "the owner";
    const card = CardFactory.adaptiveCard(cards.reminderProposalCard(ticket, recipientName));
    await sendToControlRoom(MessageFactory.attachment(card));
    proposed.push({ ticketId: ticket.id, kind: "reminder" });
  }

  for (const ticket of waitingForResponse.concat(escalation)) {
    const hoursSincePublish = (now - new Date(ticket.publishedAt)) / 3600000;
    const daysOverdue = hoursSincePublish / 24;
    const eligible =
      daysOverdue >= config.ESCALATION_THRESHOLD_DAYS && ticket.reminderCount >= config.ESCALATION_MIN_REMINDERS;
    if (eligible && !(ticket.escalation && ticket.escalation.proposedAt)) {
      const escalateToName =
        program.stakeholders.find((s) => s.id === ticket.rootBlockerId)?.name || "management";
      const card = CardFactory.adaptiveCard(cards.escalationProposalCard(ticket, escalateToName, Math.floor(daysOverdue)));
      await sendToControlRoom(MessageFactory.attachment(card));
      proposed.push({ ticketId: ticket.id, kind: "escalation" });
    }
  }

  res.send({ proposed });
});

server.get("/api/queue", (req, res, next) => {
  res.send(groupByTab(store.list(), config));
  next();
});

server.get("/healthz", (req, res, next) => {
  res.send({ ok: true });
  next();
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`Luna Delivery Bot listening on port ${port}`);
  console.log(`Bot messaging endpoint: http://localhost:${port}/api/messages`);
});
