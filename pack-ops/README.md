# pack-ops

Publishing a draft of a sticker pack (fStik Studio) as a resumable commit.
Design: `fstik_app/docs/superpowers/specs/2026-10-23-studio-design.md`,
sections 2.3 (publish) and 2.4 (conflicts); Bot API behaviour it relies on is
in section 7.1 there.

| File | What |
|---|---|
| `plan.js` | Pure planning: conflict check, content (delete / replace / add), mapping new stickers by position, LIS reorder, metadata diff |
| `execute.js` | The commit state machine. Gets `telegram`, `store` and `lock` injected |
| `store.js` | MongoDB store (`PackCommit`) and pack lock (`PackLock`) |
| `worker.js` | The Studio publish worker: claims queued commits, uploads their files, runs them, syncs the bot's sticker docs |
| `worker-repo.js` | The worker's MongoDB queries |
| `index.js` | `publishCommit(db, telegram, id)`: load and run a stored commit in a copy scope (waits out per-user 429s) |

## A commit

```js
{
  name, ownerTelegramId,          // the pack and whose user_id the API calls use
  base: [file_unique_id],         // the pack when the draft was opened
  draft: [DraftItem],             // the pack as it should end up (plan.js)
  known: { [uid]: { emojiList, keywords } },  // our DB's metadata, for the diff
  status, phase, steps, mapping, contentBase, format, error
}
```

`status`: `pending` → `running` → `succeeded`, or stops at:
- `conflict`: the pack changed since the draft was opened; nothing was done;
- `interrupted`: a 429 longer than the wait, a network error, a lost lock. Run it again to continue;
- `failed`: Telegram refused a step, merged a duplicate file, or the pack changed mid-publish. Steps before it stay applied.

Phases run in order: content (deletes, replaces, adds), then arrange (moves,
emoji, keywords), then verify. Each step is saved as `running` before its
request and settled after. A step found `running` or `uncertain` on the next
run is checked against `getStickerSet` before anything is sent again: a
content step leaves a trace in the pack, and an arrange step is idempotent.

Telegram answers `ok` to an add or replace with a file that already has a
sticker in the pack, but merges it instead of adding one. So every add and
replace is checked against `getStickerSet` right after it, and a merge stops
the commit as `duplicate`. Studio should drop duplicate files (by hash) before
committing.

## Worker

`worker.js` is what turns a commit queued by the Studio API into a published
pack. `bot.js` starts it (polling every 2 s, unref'd, drained on SIGTERM); it
handles one commit at a time per process and is safe to run in several.

`STUDIO_URL` (e.g. `https://studio.fstik.app`) enables the "Open in Studio" web_app button in the pack menu (private chats; owner and co-edit members only).

```
queued → preparing → pending → running → succeeded (+ synced)
```

- **Claim**: one atomic update takes a `queued` commit, or a `preparing` one
  whose `claimedAt` is older than 2 min (its process died). Uploads refresh
  `claimedAt`, plus a 30 s heartbeat for long 429 waits.
- **Prepare**: every draft item with `file` and no `file.fileId` is uploaded
  with `uploadStickerFile` for the owner, in a copy scope (waits out 429s).
  The `file_id` goes onto the item and the commit is saved after each upload,
  so a restart doesn't repeat finished ones; it is also kept on the
  `studioassets` doc (with `fileOwner`: a file_id is reused only for the same
  owner). A missing asset fails the commit as `asset_missing`; a 4xx from
  Telegram (not 429) fails it with Telegram's text; a network error or a 429
  beyond the wait leaves it `interrupted` for the API to requeue.
- **Run**: `pending` commits, and `running` ones not touched for the lock TTL,
  go to `publishCommit`, skipping packs whose lock is held (their holder is on it, maybe in a long 429 wait). The pack lock keeps two processes from running one; `runCommit` extends it every 30 s while it runs.
- **Sync**: a `succeeded` commit with no `synced` has the bot's own sticker
  docs brought in line with `getStickerSet`: an upsert per final sticker
  (`emojis` joined with a space, like the bot stores it, `emojiList`,
  `keywords` only when the item has some, `fileId`, `stickerType: 'sticker'`),
  docs the pack no longer holds marked `deleted`, a gone placeholder unset on
  the pack, `updatedAt` touched. Then `synced: true`. It runs last in a pass. A
  failing sync is retried after 10 s, 20 s … up to 10 min (`syncAttempts`,
  `syncAfter`) and given up after 10 tries, leaving `synced` false and
  `syncError` set; other commits are not held up.

Co-edit activity is not logged and the actor is not notified yet.

## Tests

- `scripts/test-pack-ops-plan.js`: planning on a simulated pack, incl. 2000 random permutations for minimal moves.
- `scripts/test-pack-ops-execute.js`: the state machine on a simulated pack that fails on every call in turn (request lost, reply lost, process dies before/after), resuming each time; duplicates.
- `scripts/test-pack-ops-worker.js`: the worker on an in-memory repo and Telegram: claims (incl. a stale one), upload resume and reuse, the ways an upload ends, the sync.
- `scripts/check-studio-worker-live.js`: the worker on a throwaway MongoDB and a test bot (not in `npm test`).
- `scripts/check-pack-ops-live.js`: the same against the real API on a test bot (not in `npm test`).
