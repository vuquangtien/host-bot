# Hweplir

Hweplir is a Discord bot for managing CTF participation in one server. It is written in TypeScript with discord.js v14 and stores registered CTF data in a local SQLite database (`ctf.db`).

## What the bot does

- Fetches CTF event data from CTFtime.
- Registers a CTF into the Discord server.
- Creates a Discord category, CTF role, info channel, and challenge channels.
- Stores CTF metadata, Discord IDs, archive time, and archive state in SQLite.
- Lists registered CTFs and lets users opt in or out of post-event access with a per-CTF role.
- Lets administrators update shared login information; passwords use Discord spoilers and are removed automatically when the competition ends.
- Opens archive-role access at competition end and archives CTFtime categories after a seven-day grace period.
- Supports manually-created CTF categories that are not on CTFtime.
- Provides admin utilities for deleting, importing, fixing, and securing CTF category permissions.
- Can optionally provide a configurable server-role verification command.
- Handles pagination and confirmation buttons for interactive commands.
- Tracks challenge threads, claims, status, solves, points, writeups, and a pinned live dashboard.
- Can sync challenge threads automatically from Gemini-discovered parser recipes cached in memory.
- Sends persisted CTF reminders and refreshes countdowns every minute.
- Logs bot activity and errors with Winston.

## Commands

Slash commands are deployed to the guild configured by `SERVER_ID` whenever the bot starts.
In the table below, `<value>` is required and `[value]` is optional.

### Core commands

| Command       | Access            | Purpose                                                                                                                               |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/ctf create` | Admin             | Create a CTF area from one challenge URL and enable auto-sync. `name`, `ctftime_id`, `start_at`, and `end_at` are optional overrides. |
| `/solved`     | Active CTF member | Mark the current challenge thread as solved, update dashboard, and prompt for a writeup link.                                         |

Only these commands are registered by default. Older admin, CTFtime lookup, challenge, writeup, help, whoami, and training-task commands remain in source modules but are intentionally not deployed in the user-friendly flow.

`/ctf create` only requires `challenge_url`. If `name` is omitted, the bot derives it from the URL. If `start_at` and `end_at` are omitted, the CTF starts immediately and stays live for seven days. Optional `start_at` and `end_at` accept `YYYY-MM-DD HH:mm` in Vietnam time (UTC+7), ISO 8601 with an explicit timezone, a Unix timestamp, or a Discord timestamp such as `<t:1786811400:F>`. `hide_after` is the number of days after the competition ends before archiving and defaults to 7.

### Challenge sync

When a CTF has a `challenge_url`, the scheduler checks it every minute while the CTF is live. New challenges are turned into Discord threads automatically, grouped by normalized category channels.

Challenge discovery runs in Gemini-assisted mode. If a parser recipe is already cached for the URL in the current bot process, the bot uses that recipe directly. If not, it asks Gemini to infer a safe parser recipe from public page/API samples. Recipes can target JSON APIs, static JavaScript data files, or server-rendered HTML challenge cards. If no reusable recipe works, the bot falls back to direct Gemini extraction and caches the extracted challenge list by a normalized content fingerprint, so unchanged pages are reused without another Gemini call. After a bot restart, Gemini may rediscover the recipe or extraction from the URL. Legacy CTFd/L3ak/generic parsers are not used in this mode.

Sending the first member message in an unsolved challenge thread silently adds that member to the claimant list and refreshes the thread/dashboard. If a challenge thread was created manually in a challenge channel, the bot registers it first.

After `/solved`, users can post an HTTP(S) writeup link directly in the thread. The bot records it, publishes the writeup announcement in `writeups`, then locks and archives the thread.

### Disabled club-task commands

The older training-task workflow is implemented but not currently registered, so `/issue-task`, `/submit`, `/task-status`, and `/show-all` do not appear in Discord. Its `TASK_ADMIN_CHANNEL_ID` and `TASK_ROLE_*` variables are not required for the core CTF workflow.

## CTF lifecycle

1. **Live:** `@everyone` is denied and `ACTIVE_CTF_ROLEID` can view the category. The per-CTF role and `VIEW_ALL_CTF_ROLEID` do not grant live access.
2. **Competition ended:** the scheduler removes shared credentials, keeps `@everyone` denied, and grants the per-CTF role plus `VIEW_ALL_CTF_ROLEID`. It also posts the end reminder and refreshes the dashboard.
3. **Archive time reached:** CTFtime events are archived seven days after the competition ends. Manual events are archived `hide_after` days after their supplied `end_at` time.

The scheduler runs every minute. Reminder delivery is persisted in SQLite, so restarting the bot does not duplicate already-sent 24-hour, 1-hour, start, 3-hours-left, 1-hour-left, or end notifications. Lifecycle notifications use read-only `announcements`, challenge solves use `solved`, and completed write-ups use `writeups`.

Lifecycle permission updates never call Discord's destructive permission sync. Permission ownership is explicit and persisted in SQLite: the bot may edit only categories and channels that it created and recorded. Pre-existing resources, including system-name channels such as `announcements`, are treated as manually managed and their permission overwrites are never changed. There is no automatic adoption of resources created before this ownership policy. Synced bot-owned channels continue inheriting naturally, while custom overwrites remain unsynced and keep their explicit denies.

## Runtime requirements

- Bun
- Dependencies from `package.json`
- A Discord bot token
- The **Message Content Intent** enabled in the Discord Developer Portal (used for automatic challenge claiming)
- A Discord server where the bot can manage roles, channels, messages, threads, and scheduled events

The bot role must be above every role it creates, grants, removes, or deletes. Its channel permissions should include View Channels, Manage Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Create Public Threads, Send Messages in Threads, and Manage Threads.

Required environment variables:

```env
SERVER_ID=discord_guild_id
BOT_TOKEN=discord_bot_token
VIEW_ALL_CTF_ROLEID=role_that_can_view_all_ctfs
ACTIVE_CTF_ROLEID=role_for_current_ctf_players
ADMIN_ROLE_ID=role_allowed_to_manage_ctfs
```

Optional environment variables:

```env
DB_PATH=optional_sqlite_database_path
LOG_CHANNELID=channel_for_bot_logs
DENY_CTF_ROLEID=role_blocked_from_ctf_categories
PUBLIC_CTF_CHANNELS=true_or_false_for_public_test_servers
GEMINI_API_KEY=optional_gemini_key_for_in_memory_parser_recipe_discovery
GEMINI_MODEL=gemini-flash-lite-latest
VERIFY_REMOVE_ROLE_ID=optional_guest_role
VERIFY_GRANT_ROLE_ID=optional_member_role
VERIFY_ALLOWED_ROLE_ID=optional_verifier_role
VERIFIED_ROLE_ID=only_needed_when_htb_enrollment_is_re-enabled
GITHUB_TOKEN=only_needed_when_github_invites_are_re-enabled
GH_INVITE_REPO_OWNER=only_needed_when_github_invites_are_re-enabled
GH_INVITE_REPO_NAME=only_needed_when_github_invites_are_re-enabled
```

Set `PUBLIC_CTF_CHANNELS=true` for a lightweight test server where CTF categories and challenge channels should stay public. In that mode, the bot skips private permission overwrites and only creates the Discord structure.

## Run the bot

```bash
bun install
bun run build
bun start
```

`bun start` runs a small supervisor. If the bot exits unexpectedly, it restarts with exponential backoff; after five rapid failures it stops to avoid an infinite loop caused by invalid configuration or credentials. `SIGINT`/`SIGTERM` are forwarded so Discord, the scheduler, and SQLite shut down cleanly. Use `bun run start:direct` only when debugging without automatic restart.

Development mode:

```bash
bun run dev
```

Useful scripts:

```bash
bun run check       # formatting, lint, build, and deterministic tests
bun run audit       # scan direct and transitive dependencies
bun run start:direct # run once without automatic restart
bun run test        # deterministic local tests (no network)
bun run test:smoke  # optional live CTFtime API smoke test
bun run lint        # lint src/ with zero warnings allowed
bun run format      # format source, maintenance scripts, and root JSON files
```

Maintenance scripts operate on `DB_PATH` or `./ctf.db` when `DB_PATH` is unset:

```bash
bunx tsx scripts/fix-ctf-visibility.ts          # preview lifecycle permission fixes
bunx tsx scripts/fix-ctf-visibility.ts --apply  # apply lifecycle permission fixes
bunx tsx scripts/check-purged.ts                 # mark missing Discord categories as purged
bunx tsx scripts/purge-stale-roles.ts            # preview orphaned per-CTF role deletion
bunx tsx scripts/purge-stale-roles.ts --apply    # delete eligible orphaned roles
```

Stop the bot before running a script that changes the database. Always run the dry-run form first where one is available.

## Code structure

```text
src/
├── index.ts                  # Creates the Discord client, registers commands, routes interactions
├── commands/
│   ├── ctftime/              # Commands backed by CTFtime data
│   ├── general/              # User-facing server commands
│   └── admin/                # Admin-only maintenance commands
├── components/
│   └── buttons.ts            # Button interaction handlers for pagination and confirmations
├── config/
│   └── env.ts                # Environment loading and validation
├── data/
│   └── statuses.ts           # Bot status messages
├── events/
│   └── ready.ts              # Startup behavior and ready-state handling
├── services/
│   ├── ctftime.service.ts    # CTFtime API access, event parsing, search, pagination embeds
│   ├── challenge.service.ts  # Dashboards, system channels, and thread naming
│   ├── ctf-scheduler.service.ts # Lifecycle reminders and permission sweeps
│   ├── database.service.ts   # SQLite schema and persistent state
│   └── discord.service.ts    # Discord roles, channels, categories, events, permissions
├── tests/
│   ├── challenge-database.test.ts
│   ├── ctf-schedule.test.ts
│   └── ctftime.test.ts       # Optional live CTFtime smoke test
├── types/
│   └── index.ts              # Shared TypeScript interfaces and enums
└── utils/
    ├── embed.builder.ts      # Helpers for Discord embeds
    ├── helpers.ts            # Date, formatting, fuzzy search, pagination helpers
    └── logger.ts             # Winston logger setup
```

Other important files:

```text
ctf.db                        # Local SQLite database used at runtime
logs/                         # Runtime log files
```

## Main flow

1. `src/index.ts` loads config, creates the Discord client, imports all commands, and registers slash commands for `SERVER_ID`.
2. A slash command interaction is routed to the matching command object from the command collection.
3. CTFtime commands use `ctftime.service.ts` to fetch and format CTFtime event data.
4. Registration commands use `discord.service.ts` to create roles, categories, channels, and scheduled events.
5. Registration state is saved through `database.service.ts` into `ctf.db`.
6. Button interactions are handled by `components/buttons.ts` for pagination and delete confirmations.
7. Logs are written through `utils/logger.ts`.

## Database model

The SQLite database stores CTFs, challenge state, dashboards, reminders, solved records, and the currently-disabled club-task workflow.

- `metadata`: stores small bot metadata, currently including the CTF counter.
- `ctfs`: stores registered CTFs and separate competition/archive times.
- `ctf_challenges`, `solved_challenges`: challenge ownership and solve state.
- `ctf_dashboards`, `ctf_reminders`: persistent dashboard and scheduler state.

Each CTF row stores:

- CTFtime ID
- Discord role ID
- Discord category ID
- CTF display name
- info message ID
- main/info channel ID
- archive timestamp
- archive state
- created/updated timestamps

## Notes for code readers

- Commands follow the shared `Command` interface in `src/types/index.ts`: each command exports `data` and `execute`.
- `src/index.ts` is the command registry. If a command is not imported and added there, Discord will not receive it.
- `ctftime.service.ts` is responsible for remote CTFtime data and embed content.
- `discord.service.ts` is responsible for Discord side effects.
- `database.service.ts` is responsible for persistent local state.
- `components/buttons.ts` must understand any custom button IDs created by commands or embed builders.
- Generated JavaScript and declaration files are written to `dist/` by `bun run build`.
