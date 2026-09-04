# Bot Commands Reference

**Hweplir** — CTF management bot for CLB BKSEC Discord server.

> Current user-friendly builds register only `/ctf create` and `/solved`.
> `/ctf create` only requires `challenge_url`; other fields are optional overrides.
> Challenge discovery is Gemini-assisted: the bot reuses cached recipes first, and falls back to direct Gemini extraction only when needed or when the source content changes.
> The detailed command list below is retained as a legacy module reference.

---

## General Commands

Information commands are available to server members. Challenge-management and solve commands require `ACTIVE_CTF_ROLEID` or Discord Administrator permission.

| Command                   | Description                                                                    | Options                                         |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `/help`                   | Show a private quick-start guide for the basic bot workflow                    | —                                               |
| `/whoami`                 | Display bot info: uptime, memory usage, CTF counts                             | —                                               |
| `/c-list`                 | List all CTFs registered in the server                                         | `order` (Mới nhất / Cũ nhất), `page`, `step`    |
| `/c-view`                 | Add/remove a per-CTF role for post-event channel access                        | `ctf-name` _(role, required)_                   |
| `/solved`                 | Mark the current challenge thread as solved and post a congratulations message | —                                               |
| `/challenge create`       | Create a tracked challenge thread                                              | `name`; `extra_category`, `points` _(optional)_ |
| `/challenge category-add` | **Admin:** register a custom category for the current CTF                      | `name`                                          |
| `/challenge list`         | View all challenges in pages of 10, optionally filtered by category            | `page`, `category` _(optional)_                 |
| `/challenge claim`        | Join the claimant list for the current challenge                               | —                                               |
| `/challenge release`      | Remove yourself from the claimant list                                         | —                                               |
| `/challenge status`       | Set working/idea/unclaimed status                                              | `value`                                         |
| `/challenge dashboard`    | Create or refresh the pinned CTF dashboard                                     | —                                               |
| `/writeup claim`          | Claim the writeup for a solved challenge                                       | —                                               |
| `/writeup release`        | Return a mistakenly claimed writeup task; owner or admin only                  | —                                               |
| `/writeup submit`         | Submit the writeup URL and publish its details in `writeups`                   | `url`                                           |

### `/solved` behavior

- Must be run inside a thread under a registered CTF category.
- Requires `ACTIVE_CTF_ROLEID` (Discord administrators are also accepted).
- Does not require or publish a solver list; the member who runs `/solved` is displayed as the confirmer.
- Renames the thread with `[SOLVED]`, refreshes the pinned dashboard, posts a congratulations message in the read-only `solved` channel, and opens a write-up task in the challenge thread.
- Persists and acknowledges the solve first. Discord follow-up work runs concurrently with a per-step timeout, so a slow announcement or dashboard request does not leave the command spinning.
- Claim the task with `/writeup claim`; use `/writeup release` after a mistaken claim; then submit an HTTP(S) link with `/writeup submit url:<link>`.
- A five-minute scheduler sends 24h/1h/start/3h-left/1h-left/end reminders and refreshes the countdown dashboard.
- CTF registration creates and pins the dashboard in the CTF-named info channel immediately.
- Completed challenges are posted to `solved`. Submitted write-ups are posted to `writeups` with challenge, category, author, URL, and thread details. Lifecycle reminders remain in `announcements`; discussion stays in `general`.
- The dashboard title includes current progress as `solved/total`.
- A member's first message in a challenge thread automatically joins them to its multi-user claimant list. Manually-created threads inside a registered CTF category are registered automatically on that first message.
- Auto-claim updates the thread name and dashboard silently; it does not post participant-added messages in the thread.
- Thread names use standardized states: `[OPEN]`, `[ACTIVE]`, `[LEAD]`, and `[SOLVED]`.
- `/challenge create` infers the primary category from the current channel; `extra_category` may add one different category.
- The member running `/challenge create` is added to the new thread automatically, without claiming it or changing `[OPEN]` status.
- `/challenge category-add name:<name>` creates and ownership-marks a new channel, or registers an existing channel as manually managed without changing any permission overwrite. Custom categories are available only for that event.
- The pinned dashboard truncates a long challenge list and provides `Xem challenges`. It opens a private list with `Trang trước` and `Trang sau`; `/challenge list` provides the same controls and supports `category:<name>` filtering.

### `/c-list` options

| Option  | Type    | Default  | Description                              |
| ------- | ------- | -------- | ---------------------------------------- |
| `order` | Choice  | Mới nhất | Sort order: newest first or oldest first |
| `page`  | Integer | 1        | Page number                              |
| `step`  | Integer | 5        | Results per page                         |

### `/c-view` behavior

- Adds or removes the role selected by `ctf-name`.
- While a CTF is live, visibility is controlled by `ACTIVE_CTF_ROLEID`; the per-CTF role does not grant live access.
- After the competition ends, the scheduler grants category visibility to the per-CTF role and `VIEW_ALL_CTF_ROLEID` while keeping `@everyone` denied.

---

## CTFTime Commands

Pull competition info from CTFTime and manage CTF channels in the server.

| Command         | Description                                                                                                   | Options                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/ct-reg`       | **Admin:** register a new CTF from CTFTime — creates category, role, channels, dashboard, and scheduled event | `ctftime-id` _(required)_                                   |
| `/ct-regacc`    | **Admin:** create/update shared credentials for CTFtime or manual CTFs in the private pinned info message     | `username`, `password` _(required)_; `cate_id` _(optional)_ |
| `/ct-info_find` | Look up a CTF by CTFTime ID or name                                                                           | `search-key` _(required)_                                   |
| `/ct-info_ongo` | Show currently ongoing CTFs from CTFTime                                                                      | —                                                           |
| `/ct-info_upco` | Show upcoming CTFs from CTFTime (paginated)                                                                   | `page`, `step`                                              |

### `/ct-reg` behavior

1. Fetches CTF info from CTFTime API.
2. Creates a Discord category, role, and info channel.
3. Pins a CTF info embed in the info channel.
4. Creates a Discord scheduled event for the competition window.
5. Opens archive-role access when the competition ends and archives the category after a seven-day grace period.
6. Logs the action to the configured log channel.

The command requires `ADMIN_ROLE_ID` or Discord Administrator permission. If registration fails before the database write, partially-created roles and channels are rolled back.

### `/ct-regacc` options

| Option     | Type   | Required | Description                                                         |
| ---------- | ------ | -------- | ------------------------------------------------------------------- |
| `username` | String | Yes      | CTF account username                                                |
| `password` | String | Yes      | CTF account password                                                |
| `cate_id`  | String | No       | Discord Category ID (auto-detected from current channel if omitted) |

The command is admin-only. For a manual/non-CTFtime event, it creates a dedicated pinned account message the first time and updates that same message on later calls. The event must have a valid end time; use `/admin-set-time` first for imported categories without a schedule. The password is rendered as a Discord spoiler while the CTF is active, is never posted to `announcements`, and is removed automatically before post-event access opens.

### `/ct-info_upco` options

| Option | Type    | Default | Description      |
| ------ | ------- | ------- | ---------------- |
| `page` | Integer | 1       | Page number      |
| `step` | Integer | 3       | Results per page |

---

## Admin Commands

Restricted to users with the configured admin role or Discord Administrator permission.

| Command              | Description                                                                                | Options                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `/admin-add`         | Manually register an existing Discord category as a CTF in the database                    | `cate_id` _(optional, auto-detected)_                                   |
| `/admin-delete`      | Delete a CTF — prompts to choose between full delete or keep channels                      | `search_id` _(CTFTime ID or Category ID, required)_                     |
| `/admin-hide`        | Manually archive all CTFs that have passed their archive time                              | —                                                                       |
| `/admin-deny-role`   | Apply `ViewChannel: false` for `DENY_CTF_ROLEID` across all CTF categories                 | —                                                                       |
| `/admin-fix`         | Rebuild lifecycle permissions only for bot-owned resources; manual permissions are skipped | —                                                                       |
| `/admin-reg_special` | Register a CTF that is not on CTFTime using its real schedule                              | `name`, `start_at`, `end_at` _(required)_; `hide_after` _(optional)_    |
| `/admin-set-time`    | Correct an existing manual CTF schedule and reset its reminders                            | `start_at`, `end_at` _(required)_; `hide_after`, `cate_id` _(optional)_ |
| `/admin-unsolve`     | Undo an accidental solve in the current challenge thread                                   | —                                                                       |
| `/verifyg10`         | Verify a user into G10: swap guest role for member role                                    | `user` _(required)_                                                     |

### `/admin-delete` flow

Shows a confirmation embed with two buttons:

- **Delete all** — removes category, channels, role, and database record.
- **Keep channels** — removes the CTF role and database record, but preserves discussion channels privately for `ACTIVE_CTF_ROLEID` and `VIEW_ALL_CTF_ROLEID`; it never grants access to `@everyone`.

### `/admin-reg_special` options

| Option       | Type            | Required | Description                                                             |
| ------------ | --------------- | -------- | ----------------------------------------------------------------------- |
| `name`       | String          | Yes      | CTF name to create                                                      |
| `start_at`   | String          | Yes      | Actual competition start time                                           |
| `end_at`     | String          | Yes      | Actual competition end time; must be in the future and after `start_at` |
| `hide_after` | Integer (0–365) | No       | Days after `end_at` before archive; defaults to 7                       |

Time strings accept `YYYY-MM-DD HH:mm` in Vietnam time (UTC+7), ISO 8601 with an explicit timezone, Unix seconds, or Discord timestamps such as `<t:1786811400:F>`.

### `/admin-set-time` options

Run this command in a channel/thread belonging to the manual CTF, or supply its Discord Category ID. It updates all three lifecycle times atomically, resets previously-sent reminders, refreshes the dashboard, and posts a schedule correction. Live permissions are restored only when the category is recorded as bot-owned; a pre-existing manual category and all manual child channels keep their permission overwrites unchanged.

| Option       | Type            | Required | Description                                                              |
| ------------ | --------------- | -------- | ------------------------------------------------------------------------ |
| `start_at`   | String          | Yes      | Correct competition start time                                           |
| `end_at`     | String          | Yes      | Correct competition end time                                             |
| `hide_after` | Integer (0–365) | No       | Days after `end_at` before archive; defaults to 7                        |
| `cate_id`    | String          | No       | Discord Category ID; auto-detected from the current channel when omitted |

### `/verifyg10` notes

This optional command is registered only when `VERIFY_REMOVE_ROLE_ID`, `VERIFY_GRANT_ROLE_ID`, and `VERIFY_ALLOWED_ROLE_ID` are all configured. No deployment-specific role IDs are stored in source code.

---

## Task Commands _(disabled while the core CTF workflow is being tested)_

These commands are fully implemented but currently disabled until the required environment variables (`ADMIN_ROLE_ID`, `TASK_ADMIN_CHANNEL_ID`, `TASK_ROLE_PWN/REV/CRYPTO/ALL`) are configured.

| Command        | Who                                               | Description                                                                           |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/issue-task`  | Admin only                                        | Create a new club task with a name, category, and requirement description (via modal) |
| `/submit`      | All members                                       | Submit a writeup/solution for an open task (select-menu flow)                         |
| `/task-status` | Admin only                                        | View all tasks and their submission lists                                             |
| `/show-all`    | Admin (all tasks) / Members (revealed tasks only) | Browse task submissions by task                                                       |

### Task categories

| Value    | Label     |
| -------- | --------- |
| `pwn`    | Pwn       |
| `rev`    | Reversing |
| `crypto` | Crypto    |

### Re-enabling task commands

1. Set the required env vars in `.env`:
   ```
   ADMIN_ROLE_ID=
   TASK_ADMIN_CHANNEL_ID=
   TASK_ROLE_PWN=
   TASK_ROLE_REV=
   TASK_ROLE_CRYPTO=
   TASK_ROLE_ALL=
   ```
2. Uncomment the task imports in `src/index.ts`.
3. Uncomment the task entries in the `commands` array in `src/index.ts`.
4. Restore the `isStringSelectMenu` and `isModalSubmit` handlers in `src/index.ts` (fix brace alignment — see note in that file).
5. Restore the required-vars list in `src/config/env.ts`.

---

## Environment Variables Summary

| Variable                 | Required      | Used by                                                      |
| ------------------------ | ------------- | ------------------------------------------------------------ |
| `BOT_TOKEN`              | Yes           | Bot login                                                    |
| `SERVER_ID`              | Yes           | Guild command deployment                                     |
| `DB_PATH`                | No            | SQLite path; defaults to `./ctf.db`                          |
| `VERIFIED_ROLE_ID`       | No / disabled | HTB enrollment is temporarily disabled                       |
| `GITHUB_TOKEN`           | No / disabled | GitHub integration is temporarily disabled                   |
| `GH_INVITE_REPO_OWNER`   | No / disabled | GitHub integration is temporarily disabled                   |
| `GH_INVITE_REPO_NAME`    | No / disabled | GitHub integration is temporarily disabled                   |
| `VIEW_ALL_CTF_ROLEID`    | Yes           | CTF channel visibility                                       |
| `ACTIVE_CTF_ROLEID`      | Yes           | Live CTF visibility and challenge commands                   |
| `LOG_CHANNELID`          | No            | Audit log channel                                            |
| `DENY_CTF_ROLEID`        | No            | `admin-deny-role` command                                    |
| `ADMIN_ROLE_ID`          | Yes           | All `/admin-*` commands and destructive confirmation buttons |
| `VERIFY_REMOVE_ROLE_ID`  | No            | Role removed by optional `/verifyg10`                        |
| `VERIFY_GRANT_ROLE_ID`   | No            | Role granted by optional `/verifyg10`                        |
| `VERIFY_ALLOWED_ROLE_ID` | No            | Role allowed to run optional `/verifyg10`                    |
| `TASK_ADMIN_CHANNEL_ID`  | Task only     | Task submission notifications                                |
| `TASK_ROLE_PWN`          | Task only     | Role granted on pwn task solve                               |
| `TASK_ROLE_REV`          | Task only     | Role granted on rev task solve                               |
| `TASK_ROLE_CRYPTO`       | Task only     | Role granted on crypto task solve                            |
| `TASK_ROLE_ALL`          | Task only     | Role granted when all categories solved                      |

`ACTIVE_CTF_ROLEID` and `VIEW_ALL_CTF_ROLEID` should be different roles. Using the same role is supported as a compatibility mode, but disables phase-specific visibility. A conflicting `DENY_CTF_ROLEID` is ignored with a startup warning.
