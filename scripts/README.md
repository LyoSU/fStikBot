# Maintenance scripts

One-shot operational scripts. Run from the project root:

```bash
node scripts/<name>.js
```

Each one loads `.env` from the parent directory, so no extra setup is needed.

## `migrate-sticker-schema.js`

Rewrites legacy `Sticker` docs (nested `info.*` / `file.*`) into the flat
`fileId`/`stickerType`/`caption` + `original.*` schema the code expects.

```bash
node scripts/migrate-sticker-schema.js --dry-run   # inspect only
node scripts/migrate-sticker-schema.js             # apply
```

**Idempotent** — safe to re-run. Once it reports `done: migrated X, skipped Y`
with no remaining legacy docs, the `$or` fallback queries across
`handlers/sticker.js`, `sticker-delete.js`, `sticker-restore.js`,
`pack-restore.js`, `inline-query.js`, `utils/add-sticker.js` can be
simplified and the `info.*` / `file.*` fields removed from
`database/models/sticker.js`.

## `backfill-sticker-types.js`

Populates `stickerType` for existing `Sticker` docs that don't have it set,
by calling `telegram.getFile(fileId)` once per doc and classifying from
the returned `file_path`. Rate-limited to ~10 req/s.

```bash
node scripts/backfill-sticker-types.js
```

After this runs, `handlers/inline-query.js` can drop its per-request
`detectStickerTypes` fetch path entirely.

## `top-sets.js`

Cron-style helper that lists popular public packs — separate concern, unrelated
to migrations.

## `update-packs.js` / `update-sticker.js`

Legacy one-offs for repairing corrupted records. Kept for reference.
