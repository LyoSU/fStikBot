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

## Tests

- `scripts/test-pack-ops-plan.js`: planning on a simulated pack, incl. 2000 random permutations for minimal moves.
- `scripts/test-pack-ops-execute.js`: the state machine on a simulated pack that fails on every call in turn (request lost, reply lost, process dies before/after), resuming each time; duplicates.
- `scripts/check-pack-ops-live.js`: the same against the real API on a test bot (not in `npm test`).
