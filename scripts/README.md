# Maintenance scripts

One-shot operational scripts. Run from the project root:

```bash
node scripts/<name>.js
```

Each one loads `.env` from the parent directory, so no extra setup is needed.

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

## `top-sets.js`

Cron-style helper that lists popular public packs — unrelated to DB
maintenance.

## `update-packs.js` / `update-sticker.js`

Legacy one-offs for repairing corrupted records. Kept for reference.

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
