"use strict";
/**
 * Persists the Bot Framework conversation reference for each of the two
 * channels Luna is allowed to post into (Delivery Control Room, Project
 * Delivery Group). A conversation reference is what botbuilder needs to
 * proactively send a message outside of a direct reply — it is captured
 * automatically the first time someone sends the bot a message in that
 * channel (see bot.js's registration commands), never typed in by hand.
 */
const fs = require("fs");
const path = require("path");
const { TurnContext } = require("botbuilder");

function save(filePath, activity) {
  const ref = TurnContext.getConversationReference(activity);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ref, null, 2));
}

function load(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = { save, load };
