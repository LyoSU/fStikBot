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

## `top-sets.js`

Cron-style helper that lists popular public packs — unrelated to DB
maintenance.

## `update-packs.js` / `update-sticker.js`

Legacy one-offs for repairing corrupted records. Kept for reference.

## A note on schema migration

At 488M Sticker docs (94% in the legacy `info.*` shape) and ~138GB
collection size, a bulk rewrite is not viable on a single-node setup — it
would take weeks of sustained writes and hammer the live DB. So instead
of migrating, the codebase treats the legacy shape as a **first-class
format**, not tech debt. Every read path already uses `$or` against
both the flat `fileId` and nested `info.file_id` fields, each served by
its own index.
