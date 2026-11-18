// One-off: put packs created before the placeholder sweeper into its queue.
//
// New packs get `placeholderCheckAt` at creation (database/index.js newSet).
// Packs made earlier still carry a pending placeholder marker but no check
// time, so utils/placeholder-sweeper.js never sees them. This gives each one
// a first look, spread evenly over --spread-hours so the sweep doesn't get
// them all at once. Packs older than --days are left alone.
//
//   node scripts/backfill-placeholder-checks.js --dry-run
//   node scripts/backfill-placeholder-checks.js --days 30 --spread-hours 72
//
// Run scripts/ensure-indexes.js first: the sweeper's index on
// placeholderCheckAt must exist before the queue fills.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const mongoose = require('mongoose')
const { db } = require('../database')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? Number(process.argv[i + 1]) : fallback
}

const dryRun = process.argv.includes('--dry-run')
const days = arg('days', 30)
const spreadMs = arg('spread-hours', 72) * 3600 * 1000
const BATCH = 1000

async function run () {
  await db.connection.asPromise()

  const since = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - days * 864e5) / 1000))
  // The _id range keeps this to the last `days` of packs, on the _id index.
  const filter = {
    _id: { $gt: since },
    placeholderFileUniqueId: { $exists: true, $ne: null },
    placeholderCheckAt: { $exists: false }
  }

  const total = await db.StickerSet.countDocuments(filter)
  console.log(`${total} pack(s) created in the last ${days} days have a placeholder and no check time`)
  if (dryRun || total === 0) return

  const start = Date.now()
  let done = 0
  const cursor = db.StickerSet.find(filter).select('_id').lean().cursor()
  let ops = []

  for await (const pack of cursor) {
    const at = new Date(start + Math.floor((done / total) * spreadMs))
    ops.push({ updateOne: { filter: { _id: pack._id }, update: { $set: { placeholderCheckAt: at, placeholderChecks: 0 } } } })
    done++
    if (ops.length >= BATCH) {
      await db.StickerSet.bulkWrite(ops, { ordered: false })
      ops = []
      console.log(`  ${done}/${total}`)
    }
  }
  if (ops.length) await db.StickerSet.bulkWrite(ops, { ordered: false })

  console.log(`scheduled ${done} pack(s) over ${spreadMs / 3600000} h`)
}

run()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.connection.close().catch(() => {})
    process.exit()
  })
