---
name: add-qq
description: Add QQ (Tencent) as a channel. Uses the QQ Bot Open Platform WebSocket gateway for real-time messaging.
---

# Add QQ Channel

This skill adds QQ support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `qq` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have QQ Bot Open Platform credentials (AppID and ClientSecret), or do you need to create them?

If they have them, collect them now. If not, we'll create them in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-qq
```

This deterministically:
- Adds `src/channels/qq.ts` (QQChannel class with self-registration via `registerChannel`)
- Adds `src/channels/qq.test.ts` (unit tests)
- Appends `import './qq.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `ws` npm dependency
- Updates `.env.example` with `QQ_APP_ID` and `QQ_CLIENT_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new QQ tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create QQ Bot (if needed)

If the user doesn't have credentials, tell them:

> I need you to register a bot on the QQ Bot Open Platform:
>
> 1. Go to [QQ Bot Open Platform](https://q.qq.com) and sign in
> 2. Create a new application (应用)
> 3. Under your application, find the **AppID** and **ClientSecret**
> 4. Enable the messaging permissions your bot needs:
>    - Group messages (群聊消息)
>    - C2C/Direct messages (单聊消息)
> 5. Copy the AppID and ClientSecret

Wait for the user to provide the credentials.

### Configure environment

Add to `.env`:

```bash
QQ_APP_ID=<their-app-id>
QQ_CLIENT_SECRET=<their-client-secret>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add the bot to a QQ group, or start a direct conversation with it
> 2. Send any message — the bot will log the chat JID
> 3. Check the logs for the JID:
>    - C2C (direct): `qq:c2c:<openid>`
>    - Group: `qq:group:<group_openid>`

```bash
tail -f logs/nanoclaw.log | grep "QQ:"
```

Wait for the user to provide the chat JID.

### Register the chat

Use the IPC register flow or register directly. The chat JID, name, and folder name are needed.

For a main chat (responds to all messages):

```typescript
registerGroup("qq:c2c:<openid>", {
  name: "<chat-name>",
  folder: "qq_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For group chats (trigger via @mention):

```typescript
registerGroup("qq:group:<group_openid>", {
  name: "<group-name>",
  folder: "qq_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered QQ chat:
> - For main chat: Any message works
> - For groups: @mention the bot to trigger a response
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `QQ_APP_ID` and `QQ_CLIENT_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'qq:%'"`
3. For groups: message @mentions the bot (GROUP_AT_MESSAGE_CREATE requires @mention)
4. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)

### Token errors

The QQ Bot Open Platform token expires periodically. The channel auto-refreshes tokens with a 5-minute safety buffer. If you see persistent 401 errors:
1. Verify credentials are correct
2. Check that the bot is still active on the QQ Open Platform
3. Restart the service

### WebSocket disconnects

The channel auto-reconnects with exponential backoff (1s → 2s → 5s → 10s → 30s → 60s). If disconnects are frequent:
1. Check network connectivity
2. Verify the bot has not been suspended on the QQ Open Platform
3. Check logs for specific close codes

## Removal

To remove QQ integration:

1. Delete `src/channels/qq.ts` and `src/channels/qq.test.ts`
2. Remove `import './qq.js'` from `src/channels/index.ts`
3. Remove `QQ_APP_ID` and `QQ_CLIENT_SECRET` from `.env`
4. Remove QQ registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'qq:%'"`
5. Uninstall: `npm uninstall ws` (only if no other channels use it)
6. Rebuild: `npm run build && systemctl --user restart nanoclaw` (Linux) or `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
