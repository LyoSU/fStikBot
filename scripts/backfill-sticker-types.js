// One-shot: populate `stickerType` for old Sticker docs that lack it.
//
// Why: handlers/inline-query.js calls telegram.getFile(fileId) on every
// inline request for stickers whose type is unknown, trashing the rate
// limit. After this backfill, every doc has a known type and the inline
// path can simply read sticker.stickerType directly.
//
// How: for each doc with stickerType ∈ {null, missing}, call getFile once,
// classify by file_path, store. Rate-limited to 10 calls/sec to stay well
// under Telegram's limits.
//
// Usage: node scripts/backfill-sticker-types.js
require('dotenv').config({ path: '../.env' })
const { db } = require('../database')
const telegram = require('../utils/telegram')

const BATCH_CONCURRENCY = 10
const BATCH_PAUSE_MS = 1000 // → ~10 req/s overall

function classifyFromPath (filePath) {
  if (/document/.test(filePath)) return 'document'
  if (/photo/.test(filePath)) return 'photo'
  if (/video_note/.test(filePath)) return 'video_note'
  if (/video/.test(filePath)) return 'video'
  if (/animation/.test(filePath)) return 'animation'
  return 'sticker'
}

async function run () {
  const query = {
    fileId: { $exists: true, $nin: [null, ''] },
    $or: [
      { stickerType: { $exists: false } },
      { stickerType: null },
      { stickerType: '' }
    ]
  }

  const total = await db.Sticker.countDocuments(query)
  console.log(`${total} stickers need stickerType backfill`)
  if (total === 0) return

  const cursor = db.Sticker.find(query).select('_id fileId').lean().cursor()
  let bulkOps = []
  let processed = 0
  let errors = 0

  const flush = async () => {
    if (bulkOps.length === 0) return
    await db.Sticker.bulkWrite(bulkOps, { ordered: false })
    processed += bulkOps.length
    bulkOps = []
  }

  while (true) {
    const batch = []
    for (let i = 0; i < BATCH_CONCURRENCY; i++) {
      const doc = await cursor.next()
      if (!doc) break
      batch.push(doc)
    }
    if (batch.length === 0) break

    const results = await Promise.all(batch.map(async (doc) => {
      try {
        const file = await telegram.getFile(doc.fileId)
        return { _id: doc._id, type: classifyFromPath(file.file_path || '') }
      } catch {
        errors++
        return null
      }
    }))

    for (const r of results) {
      if (!r) continue
      bulkOps.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { stickerType: r.type } }
        }
      })
    }

    if (bulkOps.length >= 100) {
      await flush()
      console.log(`  … ${processed}/${total} (errors: ${errors})`)
    }

    // Rate-limit buffer
    await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS))
  }

  await flush()

  console.log(`done: backfilled ${processed}, errors ${errors}`)
}

run()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => process.exit(0))
