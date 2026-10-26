# pack-ops

Publishing a draft of a sticker pack (fStik Studio) as a resumable commit.
Design: `fstik_app/docs/superpowers/specs/2026-10-23-studio-design.md`,
sections 2.3 (publish) and 2.4 (conflicts); Bot API behaviour it relies on is
in section 7.1 there.

| File | What |
|---|---|
| `plan.js` | Pure planning: conflict check, content (delete / replace / add), mapping new stickers by position, LIS reorder, metadata diff |
| `execute.js` | The commit state machine. Gets `telegram`, `store` and `lock` injected |
| `store.js` | MongoDB store (`PackCommit`), pack lock (`PackLock`), uploaded files (`StudioAsset`) |
| `title.js` | The title as Telegram gets it: cut to the tier's limit, bot suffix for packs without Boost; the bot's username |
| `names.js` | Short names for new packs (shared with the `/new` wizard) |
| `worker.js` | The Studio publish worker: claims queued commits, uploads their files, runs them, syncs the bot's sticker docs |
| `worker-repo.js` | The worker's MongoDB queries |
| `fresh.js` | A set as Telegram's servers hold it now (MTProto), past the Bot API's copy |
| `index.js` | `publishCommit(db, telegram, id)`: load and run a stored commit in a copy scope (waits out per-user 429s) |

## A commit

```js
{
  name, ownerTelegramId,          // the pack and whose user_id the API calls use
  base: [file_unique_id],         // the pack when the draft was opened
  draft: [DraftItem],             // the pack as it should end up (plan.js)
  known: { [uid]: { emojiList, keywords } },  // our DB's metadata, for the diff
  packType, boost,                // 'regular' | 'custom_emoji'; Boost decides the title rules
  settings,                       // optional, see "Pack settings"
  remove,                         // optional, see "Deleting a pack"
  create,                         // optional, see "Creating a pack"
  lockName,                       // the pack lock's key when it isn't `name` (a new pack)
  charge,                         // optional, see "Copies"
  status, phase, steps, mapping, contentBase, format, error,
  rebased, outside, stale,        // set by the worker for a pack changed outside the draft
  fresh, conflicts                // on a conflict: the pack as the server has it, and why
}
```

`status`: `pending` → `running` → `succeeded`, or stops at:
- `conflict`: the pack changed outside the draft, touching what the draft changes; nothing was done;
- `interrupted`: a 429 longer than the wait, a network error, a lost lock. Run it again to continue;
- `failed`: Telegram refused a step, or the pack changed mid-publish. Steps before it stay applied.
  `error` is Telegram's text, or one of the codes the client explains itself:
  `bot_not_started` (the owner never started the bot: "user not found"),
  `bot_blocked` (the owner blocked it), `pack_gone`, `name_occupied`,
  `name_invalid`, `asset_missing`, `copy_missing`. The first two are the
  owner's to fix and are not logged as worker faults.

Phases run in order: create (only for a new pack), content (deletes, replaces, adds), then arrange (moves,
emoji, keywords), then settings (title, thumbnail), then verify. Each step is saved as `running` before its
request and settled after. A step found `running` or `uncertain` on the next
run is checked against `getStickerSet` before anything is sent again: a
content step leaves a trace in the pack, and an arrange step is idempotent.

Telegram answers `ok` to an add or replace with a file that already has a
sticker in the pack, but merges it instead of adding one: the add does
nothing, the replace takes its old sticker out and moves the existing one into
its place. So every add and replace is checked against `getStickerSet` right
after it. A merge leaves that item out (`step.merged`; the job lists it as a
duplicate) and the rest goes on: the pack ends up as the draft without it.

A file can also come back as the sticker it already made (measured): the
upload a deleted sticker was made from, added again, is that sticker under its
old `file_unique_id`, and a replace with a sticker's own upload leaves it as it
is. So after the content phase kept stickers are found by id, and the new ones
are whatever else the pack holds, in the order the content phase made them
(`mapAfterContent`); arrange then puts everything in place.

## A pack edited elsewhere

The Bot API answers `getStickerSet` from a copy it keeps, and a pack edited in
a Telegram app or in @Stickers shows as it was for about 12 minutes; only this
bot's own next write that succeeds refreshes the copy (measured). The API reads
packs through the Bot API too, so the client's `base` can stand on that old
copy, and reloading gives the same copy again. A conflict there would repeat on
every publish until the copy expires (seen: one pack published 7 times in 7
minutes, each a conflict).

So the worker plans on the pack as the server has it: `freshUids` (`fresh.js`,
MTProto, each document id turned into the file_unique_id the Bot API would
show; tdlib's encoding, measured, not documented). A read that matches none of
`base` is taken for a broken one (a warning, and the copy is used), as is one
that fails or a bot without MTProto.

When that pack is not `base`, the draft is carried over to it by a three-way
merge (`plan.js` `mergeOutside`: base → fresh is what changed outside, base →
draft what the user changed):

| Outside | In the draft | Result |
|---|---|---|
| deleted | kept as it was | stays deleted |
| deleted | replaced, or other emoji/keywords | conflict |
| deleted | deleted | nothing to do |
| kept | deleted | deleted |
| added | (not in it) | kept: right before the sticker that follows it in fresh (the nearest one left), else after the last sticker the pack already had |
| | added | where the draft has it among the kept stickers |
| moved | not moved | fresh's order |
| not moved | moved | the draft's order |
| moved | moved | the same order: that; another: conflict |
| emoji/keywords | emoji/keywords | the draft's changes against our database are applied; Telegram doesn't show the outside ones in full |

The merged draft is `commit.rebased` (the draft as sent stays: the job view
counts on it), with an item `{ assetId: 'o:<uid>', fileUniqueId }` for each
sticker added outside; it is never relabelled and the sync leaves it alone.
`commit.outside` lists what was deleted and added. A conflict ends the commit
with nothing done, `error: 'the pack changed outside the draft'`, `fresh` (the
pack's file_unique_ids as the server has them) and `conflicts`
(`[{ fileUniqueId?, reason }]`). A client can't rebase by sending `fresh` as
its base unless its draft keeps every sticker in it: one it leaves out is a
delete. It drops or redoes the conflicting edits and publishes again on its
base, and the merge carries the rest.

While the copy still lags (`commit.stale`), the steps read the pack's order and
counts from `freshUids` and only file_ids from the copy; a sticker the copy
doesn't have yet is looked up again after a write, when it has caught up.

A delete of a sticker already gone (deleted elsewhere since the plan, or by an
attempt whose answer got lost) answers `STICKERSET_NOT_MODIFIED`, or the copy no
longer has it. Either way the delete has done what it was for: it is settled
(`alreadyGone`) and the publish goes on. A deleted sticker has nothing else
planned on it.

A step on a set that is gone answers `STICKERSET_INVALID`, as does one on a
set another bot made. `readFresh` (`fresh.js`: MTProto `messages.getStickerSet`,
falling back to the Bot API) decides: a set the server doesn't know ends the
commit as `failed`, `packGone: true`, `error: 'pack_gone: … (STICKERSET_INVALID)'`,
and the worker marks the pack deleted as the bot's own delete does
(`writeRemoved`). A set that is there keeps Telegram's error and is not touched.

## Pack settings

`commit.settings` is optional: `{ title?, thumbnail? }`. A commit may carry
only settings (its draft then keeps every sticker as it is).

- `title`: what the user typed. The `title` step sends `formatTitle(commit, title)`
  (`title.js`): cut to `charTitleMax` (30) or, with `commit.boost`,
  `premiumCharTitleMax` (64), and without Boost followed by ` :: @<bot>`, as the
  bot's own rename does. `setStickerSetTitle`.
- `thumbnail`:
  - `{ assetId }` for a regular pack: the step reads the `studioassets` file and
    uploads it as an InputFile (`setStickerSetThumbnail`, `format` from the asset;
    a static one is a 100×100 WebP/PNG). Not through `uploadStickerFile`: this call takes the file itself.
  - `{ fromSticker: file_unique_id }` for a custom emoji pack:
    `setCustomEmojiStickerSetThumbnail` with that sticker's `custom_emoji_id`
    from `getStickerSet`. The other combination (an asset on an emoji pack, a
    sticker on a regular one) fails the commit.
  - `null`: drop it (the first sticker is the thumbnail again).

The steps run after arrange, so `fromSticker` finds the final pack. Each is
checked against `getStickerSet` first: a title the pack already has, or a
thumbnail to drop from a pack that has none, is done without a call, which also
settles a step whose answer was lost. Setting a thumbnail again is harmless, so
that one is simply repeated. A "not modified" answer counts as done. The sync
copies the title Telegram reports onto the pack document.

An older worker ignores `settings` and would report success, so deploy the bot
before the API starts accepting them.

## Creating a pack

`commit.create` makes the pack first: `{ title, name?, needsRepainting? }` with
`base: []`, `packType` set and every draft item a new file. `name` is the link
the user typed (optional), `title` their part of the title. `commit.name` and
`commit.lockName` start as a provisional `~new:<id>`; the pack lock stays under
it, `commit.name` becomes the real name once Telegram has the set.

`createPack` (`execute.js`) does what the wizard (`scenes/pack-new.js`) does:

- names: `autoNameCandidates` (the title as a link, then two with a random tail)
  or the one name the user typed, all with `_by_<bot>`; from `names.js`, which
  the wizard uses too. A candidate is skipped when our database has a pack by
  that name (`nameTaken`, like the wizard) or Telegram already has the set;
  when `createNewStickerSet` answers "occupied"/"invalid" the next one is tried.
  None left: the commit fails with `error: 'name_occupied'` (or `'name_invalid'`
  when nothing usable is left of a typed link) and nothing was made;
- title: `formatTitle` as for a rename: cut to 30, ` :: @<bot>`. A new pack has no Boost;
- the first 50 draft items go into `createNewStickerSet` (Telegram takes no empty set,
  so there is no placeholder as in the wizard); the rest are added by the content phase.
  `sticker_type` is the commit's `packType`, `needs_repainting` the create's `needsRepainting`;
- the bot's records (`register`, `mongoRegister` in `store.js`): the `StickerSet`
  document through the same `newSet` (owner, ownerTelegramId, name, formatted title,
  packType, `boost: false`, `emojiSuffix: '🌟'`, `create: true`), the owner's current
  pack and `packsCount` reset. The document is reused if a retry finds it.

Resuming: the name under attempt is written down (`create.state = 'creating'`,
`create.attempt`) before the call. A name is only attempted after `getStickerSet`
said nobody has it, so a run that finds the set under the attempted name and our
title adopts it instead of creating another; a set with another title is
somebody's and the next name is tried. After the create the seeded draft items
become kept ones (`fileUniqueId`, `known`), `base` is the pack as made, and the
normal phases go on. If the commit later fails, the pack stays (and is registered).

## Copies

A draft item may be a sticker of another set instead of an uploaded file:
`file: { copy: { set, fileUniqueId }, format, fileId: null }` (`assetId` is
`c:<fileUniqueId>`). Studio's "Copy a pack" and "Add from my packs" queue
these; the API checked with its own token that the set has that sticker and
that it fits the pack (the same type, or a TGS, which fits both).

The worker's prepare reads the set with `getStickerSet` (once per set) and
puts this bot's `file_id` and the sticker's format on the item, nothing is
uploaded: a file_id is only good for the bot it was issued to, so the API's
ids can't be used, while `file_unique_id` is the same for every bot. Telegram
takes a sticker of another set by file_id, as the bot's own add does. A sticker
no longer in its set (or a set that is gone) fails the commit as
`copy_missing`.

A copied pack is a `create` commit with `boost: true` and `create.copyOf`, like
the wizard's copy. It earns Boost only as a copy (`copyEarnsBoost`, written down
as `create.copyBoost` before the first stickers go in): every item a sticker of
`copyOf`, or the copy paid for (into the other type); the API refuses anything
else, and the worker checks again. `register` writes the pack with that Boost, while its first title still gets the
bot's suffix (`formatTitle` as for a pack without Boost). A copy into the
other pack type costs a credit, which the API takes before it queues the
commit and writes down as `charge: { credits, user }`. When the commit ends
`failed` (or `conflict`) before the pack was made, the worker gives it back
once: `refundCharge` adds the credit and marks the commit on the user
(`refundedCommits`) in one update, so no second run pays it again, then sets
`charge.refunded`. A refund that failed, or whose process died before that
mark, is picked up again by `findUnrefunded` a minute later. Once the pack
exists the credit stays spent, as in the wizard. An `interrupted` commit keeps
it until it ends.

A worker that predates copies would try to upload a copied item as an asset
and fail it as `asset_missing` (no refund): deploy the bot before the API.

## Deleting a pack

`commit.remove: true` deletes the whole set (Studio's "Delete pack", the bot's
`scenes/pack-delete.js`), queued by the API with `base: []`, `draft: []`. It
runs one step instead of the phases: `deleteStickerSet` for `commit.name`, then
`succeeded`. Telegram answers `STICKERSET_INVALID` both for a set that is gone
and for one another bot made, so that answer only counts as done when
`readFresh` can't find the set either; otherwise the commit fails and nothing
is touched. A step found `running` is sent again: a second delete of a set this
bot deleted answers `STICKERPACK_NOT_FOUND`, settled the same way.

The sync of a remove commit writes what the bot's own delete writes: the pack
and its stickers `deleted` (the document stays, also for a set Telegram had
already lost), the pack dropped as the current pack of its owner and members
(`stickerSet`, `inlineStickerSet`), the owner's `packsCount` reset.

A worker that predates `remove` runs it as an empty draft: the empty `base`
never matches a live set, so it stops at `conflict` without a call that
changes anything. Still, deploy the bot before the API starts queueing removes,
or every Studio delete ends in that conflict.

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
  owner), and the file's bytes leave that doc (unless the commit sends them
  itself as its thumbnail): a retry finds the file_id on the commit, and a
  file asked for by another owner is one Studio uploads again (the API stores
  the bytes anew; without them the commit fails as `asset_missing`). A missing asset fails the commit as `asset_missing`; a 4xx from
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

- `scripts/test-pack-ops-plan.js`: planning on a simulated pack, incl. 2000 random permutations for minimal moves, the settings steps, and each merge rule plus 2000 random merges.
- `scripts/test-pack-ops-execute.js`: the state machine on a simulated pack that fails on every call in turn (request lost, reply lost, process dies before/after), resuming each time; duplicates left out; a file that comes back as its old sticker; a pack edited or deleted elsewhere, incl. 60 random merges with a fault on every call; owners who never started or blocked the bot; the settings phase; creating a pack (names, the 50 limit, every fault).
- `scripts/test-pack-ops-fresh.js`: the MTProto read and its fallback to the Bot API; file_unique_ids from document ids, and the guard against a read that matches nothing.
- `scripts/test-pack-ops-remove.js`: deleting a pack: faults before and after the call, a set already gone, a set the bot can't delete, an older worker, the sync.
- `scripts/test-pack-ops-worker.js`: the worker on an in-memory repo and Telegram: claims (incl. a stale one), upload resume and reuse, the ways an upload ends, the sync.
- `scripts/check-studio-worker-live.js`: the worker on a throwaway MongoDB and a test bot, incl. a settings-only commit (title with suffix, thumbnail set and dropped; not in `npm test`).
- `scripts/check-pack-ops-live.js`: the same against the real API on a test bot (not in `npm test`).
