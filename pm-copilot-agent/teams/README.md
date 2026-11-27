# Approving meeting to-dos in Teams (Luna)

New to-dos drafted from meetings are posted to one Teams chat as cards with **Approve** / **Reject**.
An approver's click writes to Jira exactly as the web page does; the card then shows who decided.
Deciding on the web page updates the card too. Code: `src/teams.js`.

## One-time setup

1. **The bot** is the existing "Luna Delivery Copilot", registered in the Teams Developer Portal
   (not an Azure resource): App ID / bot ID `b31f5c90-8240-41d9-a1fd-bb9de28d5517`, tenant rda.ai
   (`2cb084b9-f1b5-4878-b639-adf3a4f719c0`). In dev.teams.microsoft.com → Tools → Bots → Luna:
   *Configure* → HTTPS endpoint `https://ai-factory.demo.rda.ai/DeliveryCopilot/api/teams/messages`;
   *Client secrets* → add one for the server. In Apps → Luna → App features → Bot, tick the
   *Group chat* scope if the approval chat is a group chat.
2. **Server `.env`** (then restart `delivery-copilot`):
   ```
   TEAMS_APP_ID=<Microsoft App ID>
   TEAMS_APP_PASSWORD=<client secret>
   TEAMS_TENANT_ID=<directory (tenant) id>
   TEAMS_APP_TYPE=SingleTenant          # or MultiTenant, as registered
   TEAMS_APPROVERS=selena.zhang@rda.ai,sherry.liu@rda.ai
   TEAMS_PROJECTS=dayone                # empty = every project
   ```
   The secret goes only in the server's `.env`, never in chat, git, or a PR.
3. **Teams app package**: `TEAMS_APP_ID=<App ID> ./teams/package.sh` builds `teams/luna-teams.zip`.
   In Teams: *Apps → Manage your apps → Upload an app* (or ask the Teams admin to publish it to the
   org), then add **Luna** to the chat "Delivery Copilot Luna testing".
4. **Register the chat**: an approver sends `@Luna register` in it. From then on, each meeting's
   new to-dos are posted there. `@Luna pending` posts the ones already waiting (up to
   `TEAMS_BACKLOG_LIMIT`, default 10).

## Rules

- Only people in `TEAMS_APPROVERS` (matched on their Teams sign-in email) can approve, reject,
  register or post the backlog. Anyone else's click is refused with a message, and nothing is written.
- Rejecting requires a reason (the text box on the card).
- Every inbound call is checked as a Bot Framework token (signature, issuer, audience = our App ID,
  expiry, serviceUrl, Teams channel) before it is read; anything else gets 401.
- Check status at `/api/health` → `teams: { configured, registered }`.
