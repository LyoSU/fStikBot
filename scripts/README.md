# Maintenance scripts

One-shot operational scripts. Run from the project root:

```bash
node scripts/<name>.js
```

Each one loads `.env` from the parent directory, so no extra setup is needed.

## `ensure-indexes.js`

Creates the indexes declared in the schemas. The app runs with
`autoIndex: false`, so a new index (the pending-payment TTL, the co-edit
activity log TTL, broadcast recipient uniqueness, shared-pack lookups) only
exists once this has run against production.

```bash
node scripts/ensure-indexes.js --dry-run   # list what's missing
node scripts/ensure-indexes.js             # create the missing ones
```

It never drops or changes an existing index. A declared index whose key
already exists with different options (`unique`, `expireAfterSeconds`) is
reported and left alone — fix those by hand. Builds run in the background, but
on the big `stickers` collection pick a quiet hour anyway.

## `inspect-db.js`

Read-only diagnostic of the `Sticker` and `StickerSet` collections. Dumps
counts, index list, a 1000-doc schema-shape sample, collection storage
stats, and oldest/newest `_id` timestamps.

```bash
node scripts/inspect-db.js
```

Doesn't modify any docs. Useful when sizing ops work.

To run against a different DB, override inline:

```bash
MONGODB_URI='mongodb://.../fStikBot?...' node scripts/inspect-db.js
```

## `prune-stickers.js`

Reclaims space in `stickers` in one pass, doing two unrelated cleanups per
`_id` range:

1. Hard-deletes soft-deleted docs past a 30-day restore window. `deletedAt`
   was added late, so ~89% of `deleted: true` docs carry no date — those fall
   back to `updatedAt`, which keeps the same 30-day guarantee.
2. `$unset`s the 14 sub-fields that live in the DB but not in `stickersSchema`
   (`info.width`, `file.mime_type`, …). The collection stores whole Telegram
   sticker objects while the schema declares only four keys per sub-document,
   so the rest is invisible to the app — ~74 bytes per doc, ~16 GiB overall.

```bash
node scripts/prune-stickers.js --dry-run --max-batches=200    # size the job
node scripts/prune-stickers.js --from=2023-01-01 --dry-run --max-batches=50
node scripts/prune-stickers.js              # 5000-doc batches, 50ms apart
node scripts/prune-stickers.js --batch=2000 --throttle=200    # gentler
node scripts/prune-stickers.js --skip-delete --until=2022-01-01   # strip only
node scripts/prune-stickers.js --reset      # forget the checkpoint
```

`--skip-delete` runs the `$unset` half alone. That half needs no fresh backup —
the fields are unreadable through the schema whether they are there or not —
while the hard delete removes records a user can still restore, so the two are
worth separating in time. Paired with `--until`, which bounds `_id` from above,
a strip pass covers the ~37M pre-2022 documents that actually carry dead
fields instead of walking all 511M.

The two modes keep **separate checkpoints** (`.prune-stickers-strip-state.json`
vs `.prune-stickers-full-state.json`). Sharing one would be a silent
correctness bug: a strip pass leaves the cursor at the 2022 boundary, and a
later full run would resume past it, never hard-deleting the expired
soft-deletes among the oldest documents — with nothing in the output to hint
that anything was skipped.

A full dry run costs two `countDocuments` per batch across 100k+ batches, so
sample a few hundred batches and read the extrapolation the summary prints.
Use `--from` for that: the checkpoint starts at the oldest docs, and 2019-2021
records have a different shape from everything after, which would skew the
estimate.

Safe to interrupt: progress is checkpointed to `scripts/.prune-stickers-state.json`
after every 20 batches, and re-running resumes from there. Both operations run
server-side per range, so documents never travel to the Node process.

Two things worth knowing before running it:

- It deliberately uses `.collection` (raw driver) rather than the mongoose
  model. Under `strict: true` mongoose drops unknown paths from an update, so
  a model-level `$unset` of `info.width` would succeed and change nothing.
- WiredTiger does not return freed space to the OS on its own. After the run,
  `compact` (with `force: true` on a single-node replica set) is what actually
  shrinks the file. Dropping an index, by contrast, frees space right away —
  though even then the ident sits in `drop-pending` for a few minutes until
  `oldest_timestamp` passes it.

## `test-*.js`

Dependency-free unit/smoke tests. No DB, no Redis, no Telegram connection —
run them all with:

```bash
npm test
```

- `test-callback-routing.js` — the `action(...)` / `hears(...)` regexes in
  `bot/commands.js` and the scene exit-command list. Guards against the
  unanchored-regex class of bug (`/publish/` swallowing `catalog:publish:<id>`).
- `test-i18n-keys.js` — every `i18n.t('literal')` in the source resolves in
  `en.yaml`. A missing key is not an error at runtime (`allowMissing`); it is
  shown to the user as the raw key.
- `test-tenor-mapping.js` — Tenor v2 URL building (key, `client_key=gboard`,
  `media_filter`) and the `media_formats` → inline-result mapping, against a
  hardcoded v2 fixture. Also pins that 400/401/403 degrade to `TENOR_DISABLED`.
- `test-lottie-rescale.js` — retargeting a TGS to another canvas
  (`utils/lottie-rescale.js`; the bot always targets 512×512, which Telegram
  requires for custom emoji too): precomp wrapper + scale, untouched when the
  canvas already matches, the 64 KB cap, and malformed input →
  `invalid_animated`.
- `test-sticker-geometry.js` — output size of a static sticker
  (`utils/sticker-geometry.js`): longer side exactly 512, other side
  proportional, small sources scaled up instead of padded.
- `test-add-sticker-text.js` — the success/error text built from an
  `addSticker` result, incl. the monochrome-emoji notice and the humanized
  429 ("wait N seconds" instead of the raw Telegram dump).
- `test-sniff-media.js` — magic-byte container detection
  (`utils/sniff-media.js`): mp4/webm/gif originals that arrive with no
  mime_type or extension must be routed to the video converter, not sharp.
- `test-callback-text.js` — the 200-char / no-HTML clamp every
  `ctx.answerCbQuery` text goes through (`utils/callback-text.js`).
- `test-catch-noise.js` — which Telegram errors stay out of the admin log
  channel (`utils/expected-noise.js`): demoted/kicked bot, blocked user,
  expired callback query.
- `test-sticker-update.js` — emoji change by text against a fake ctx: a
  deleted `previousSticker` falls through to the last sticker in the set;
  `STICKER_ALREADY_DELETED` syncs the DB row.
- `test-tgs-static-fix.js` — repair of a TGS Telegram refuses as static
  (`utils/tgs-static-fix.js`): dropped keyframes get interpolators back, a
  fully static file gets a micro-animation, real animations stay untouched.
- `test-placeholder.js` — bootstrap-placeholder removal.
- `test-retry-api.js` — 429 retry / cooldown policy.
- `test-perf-timing.js` — perf-stage instrumentation.

## `check-bot-api-contract.js`

Not a unit test: it talks to the real Bot API and checks the sticker behaviour
the bot relies on — TGS canvas (512×512 only, custom emoji included), TGS
across pack types by `file_id`, `attach://` uploads, `setStickerPositionInSet`
semantics, `replaceStickerInSet` on a one-sticker pack, an empty pack after
deleting the last sticker, a re-added sticker
getting a new `file_unique_id`, keyword/emoji limits. Run it when Telegram
ships a Bot API update or before relying on one of these in new code:

```bash
node scripts/check-bot-api-contract.js [owner_user_id]   # default: config.mainAdminId
```

`BOT_TOKEN` must be a **test** bot (the script refuses the bot behind
`MAIN_BOT_TOKEN`): uploads count against a bot-wide flood quota shared by all
users. It creates two `zz_contract_*` packs and deletes them at the end, and
can sit in a 429 wait for a few minutes. Exit code 1 means Telegram's
behaviour no longer matches.

## `check-pack-ops-live.js`

Runs the publish planner (`pack-ops/plan.js`) against the real Bot API:
builds a pack, publishes drafts with deletes, replaces, adds and reorders,
and checks `getStickerSet` ends up exactly as planned. A stale draft must be
refused. Same rules as above: test bot only, one `packops_*` pack deleted at
the end. Run it after changing the planner; `test-pack-ops-plan.js` covers the
logic offline against a simulated pack.

```bash
node scripts/check-pack-ops-live.js [owner_user_id]   # default: config.mainAdminId
```

## A note on schema migration

At 513M Sticker docs (94% in the legacy `info.*` shape) and ~101 GiB of data
plus ~30 GiB of indexes, the codebase treats the legacy shape as a
**first-class format**, not tech debt: every read path uses `$or` across both
the flat `fileId` and the nested `info.file_id`, and the getters on
`stickersSchema` normalize the difference away.

Two caveats to earlier versions of this note:

- Only some of those paths are index-backed. `fileUniqueId`,
  `file.file_unique_id` and `original.fileUniqueId` each have an index;
  `fileId` and `info.file_id` have none, and are only ever read off a document
  already fetched by another key.
- A bulk rewrite is heavy but not the "weeks of sustained writes" this note
  used to claim — batched server-side updates move ~5k docs/s, i.e. tens of
  hours end to end. The real reasons to avoid a full rewrite are oplog churn
  and the fact that rewriting every doc buys nothing the getters don't already
  provide. Removing the *undeclared* sub-fields is a different matter, and
  that is what `prune-stickers.js` does.
