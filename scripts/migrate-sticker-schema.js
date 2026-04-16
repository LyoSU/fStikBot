// One-shot migration: rewrite legacy Sticker docs from nested info.*/file.*
// into the flat fileId/stickerType/caption + original.* shape.
//
// The new schema coexists with the old — this script is what finally lets us
// drop the $or fallback queries in handlers/sticker.js, sticker-delete.js,
// sticker-restore.js, pack-restore.js, inline-query.js, add-sticker.js and
// remove the getter-method fallbacks from database/models/sticker.js.
//
// Idempotent: running it twice is a no-op on docs already migrated.
//
// Usage:
//   node scripts/migrate-sticker-schema.js --dry-run   (inspect only)
//   node scripts/migrate-sticker-schema.js             (apply)
require('dotenv').config({ path: '../.env' })
const { db } = require('../database')

const BATCH_SIZE = 500

async function run ({ dryRun }) {
  console.log(dryRun ? '=== DRY RUN ===' : '=== LIVE RUN ===')

  // Find docs that still carry legacy fields. We handle two independent
  // migrations in one pass:
  //   1. info.* → flat fileId/stickerType/caption
  //   2. file.* → original.fileId/fileUniqueId/stickerType
  const query = {
    $or: [
      { 'info.file_id': { $exists: true } },
      { 'file.file_id': { $exists: true } }
    ]
  }

  const total = await db.Sticker.countDocuments(query)
  console.log(`${total} legacy documents`)
  if (total === 0) {
    console.log('nothing to migrate')
    return
  }

  const cursor = db.Sticker.find(query).lean().cursor()
  let bulkOps = []
  let processed = 0
  let skipped = 0

  const flush = async () => {
    if (bulkOps.length === 0) return
    if (!dryRun) await db.Sticker.bulkWrite(bulkOps, { ordered: false })
    processed += bulkOps.length
    console.log(`  … ${processed}/${total}`)
    bulkOps = []
  }

  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    const set = {}
    const unset = {}

    // Legacy info.* → flat fields (only when the flat field is missing)
    if (doc.info && doc.info.file_id) {
      if (!doc.fileId) set.fileId = doc.info.file_id
      if (!doc.stickerType && doc.info.stickerType) set.stickerType = doc.info.stickerType
      if (!doc.caption && doc.info.caption) set.caption = doc.info.caption
      unset.info = ''
    }

    // Legacy file.* → original.* (only when original.fileId is missing)
    if (doc.file && doc.file.file_id) {
      const hasOriginal = doc.original && doc.original.fileId
      if (!hasOriginal) {
        set['original.fileId'] = doc.file.file_id
        if (doc.file.file_unique_id) set['original.fileUniqueId'] = doc.file.file_unique_id
        if (doc.file.stickerType) set['original.stickerType'] = doc.file.stickerType
      }
      unset.file = ''
    }

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
      skipped++
      continue
    }

    const update = {}
    if (Object.keys(set).length > 0) update.$set = set
    if (Object.keys(unset).length > 0) update.$unset = unset

    bulkOps.push({ updateOne: { filter: { _id: doc._id }, update } })

    if (bulkOps.length >= BATCH_SIZE) await flush()
  }

  await flush()

  console.log(`done: migrated ${processed}, skipped ${skipped}`)
}

run({ dryRun: process.argv.includes('--dry-run') })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => process.exit(0))
