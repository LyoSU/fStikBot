// Single pass over the Sticker collection doing two independent cleanups:
//
//   1. Hard-deletes soft-deleted docs that are past the restore window.
//      `deletedAt` was added later, so ~89% of `deleted: true` docs have no
//      date at all. Those fall back to `updatedAt` — a doc nobody has touched
//      for RESTORE_WINDOW_DAYS is safe to drop either way.
//
//   2. Strips sub-fields that exist in the DB but not in the schema. The
//      collection stores the whole Telegram sticker object under `info` /
//      `file`, while the schema only declares `stickerType`, `file_id`,
//      `file_unique_id` and `caption`. Everything else is invisible to the
//      app (strict mode) — roughly 74 bytes per doc, ~16 GiB collection-wide.
//
// IMPORTANT: both run through `.collection` (raw driver) on purpose. Going
// through the mongoose model would strip the unknown paths out of the $unset
// before it ever reaches the server — the very fact that makes these fields
// dead would also make them unremovable.
//
// Work is done server-side per _id range, so documents never travel to this
// process. Progress is checkpointed, so Ctrl-C and re-run resumes where it
// stopped.
//
// Usage:
//   node scripts/prune-stickers.js --dry-run       # count only, no writes
//   node scripts/prune-stickers.js                 # run with defaults
//   node scripts/prune-stickers.js --batch=5000 --throttle=50
//   node scripts/prune-stickers.js --dry-run --max-batches=200   # sample first
//   node scripts/prune-stickers.js --from=2023-01-01 --max-batches=50
//   node scripts/prune-stickers.js --reset         # forget the checkpoint
//
// --from seeks by _id timestamp, so a dry run can measure a representative
// epoch instead of the oldest 2019 docs the checkpoint would start from.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const fs = require('fs')
const path = require('path')
const { db } = require('../database')

const STATE_FILE = path.join(__dirname, '.prune-stickers-state.json')
const RESTORE_WINDOW_DAYS = 30

// Sub-fields present in the DB but absent from stickersSchema.
const DEAD_FIELDS = [
  'info.width', 'info.height', 'info.emoji', 'info.is_animated',
  'info.set_name', 'info.file_size',
  'file.width', 'file.height', 'file.emoji', 'file.is_animated',
  'file.set_name', 'file.file_size', 'file.file_name', 'file.mime_type'
]

const UNSET_SPEC = DEAD_FIELDS.reduce((spec, field) => ({ ...spec, [field]: '' }), {})
const DEAD_FIELD_PROBES = DEAD_FIELDS.map((field) => ({ [field]: { $exists: true } }))

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const raw = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : null
}
const value = (name, fallback) => {
  const hit = raw(name)
  return hit === null ? fallback : Number(hit)
}

// ObjectId whose timestamp is `date` — lets --from seek straight to an epoch
// without an index on createdAt.
function objectIdAt (date) {
  const seconds = Math.floor(date.getTime() / 1000)
  return new (require('mongoose').Types.ObjectId)(seconds.toString(16).padStart(8, '0') + '0000000000000000')
}

const dryRun = flag('dry-run')
const batchSize = value('batch', 5000)
const throttleMs = value('throttle', 50)
// Stop after N batches. A full dry run costs two countDocuments per batch over
// 100k+ batches, so sampling a few hundred and extrapolating is the sane way
// to size the job.
const maxBatches = value('max-batches', Infinity)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadState () {
  const from = raw('from')
  if (from) {
    const date = new Date(from)
    if (isNaN(date)) throw new Error(`--from is not a date: ${from}`)
    return { cursor: objectIdAt(date), scanned: 0, removed: 0, stripped: 0 }
  }
  if (flag('reset') || !fs.existsSync(STATE_FILE)) {
    return { cursor: null, scanned: 0, removed: 0, stripped: 0 }
  }
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  saved.cursor = saved.cursor ? new (require('mongoose').Types.ObjectId)(saved.cursor) : null
  return saved
}

function saveState (state) {
  if (dryRun) return
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, cursor: state.cursor ? String(state.cursor) : null }, null, 2))
}

// A doc is past the restore window when its own delete timestamp is old, or —
// for pre-`deletedAt` records — when nothing has touched it for that long.
function expiredSoftDelete (cutoff) {
  return {
    deleted: true,
    $or: [
      { deletedAt: { $lt: cutoff } },
      { deletedAt: null, updatedAt: { $lt: cutoff } },
      { deletedAt: null, updatedAt: { $exists: false } }
    ]
  }
}

async function run () {
  const coll = db.Sticker.collection
  const total = await db.Sticker.estimatedDocumentCount()
  const cutoff = new Date(Date.now() - RESTORE_WINDOW_DAYS * 86400000)
  const state = loadState()

  console.log('=== prune-stickers ===')
  console.log(`mode:      ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`batch:     ${batchSize} docs, throttle ${throttleMs}ms`)
  console.log(`collection: ${total.toLocaleString()} docs`)
  console.log(`restore window: ${RESTORE_WINDOW_DAYS}d — nothing updated after ${cutoff.toISOString()} is touched`)
  console.log(`resuming at: ${state.cursor || 'start'}\n`)

  // Wrapped in an object so the loop condition is a property lookup — a bare
  // `let` flipped only inside a signal handler reads as never-modified to eslint.
  const control = { stopping: false }
  const stop = () => {
    if (control.stopping) process.exit(1)
    control.stopping = true
    console.log('\ninterrupt received — finishing current batch, then saving state …')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const startedAt = Date.now()
  let batches = 0

  while (!control.stopping) {
    const query = state.cursor ? { _id: { $gt: state.cursor } } : {}
    const ids = await coll
      .find(query, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray()

    if (!ids.length) {
      console.log('\nreached the end of the collection')
      break
    }

    const range = { _id: { $gte: ids[0]._id, $lte: ids[ids.length - 1]._id } }

    if (dryRun) {
      state.removed += await coll.countDocuments({ ...range, ...expiredSoftDelete(cutoff) })
      state.stripped += await coll.countDocuments({ ...range, $or: DEAD_FIELD_PROBES })
    } else {
      const deleted = await coll.deleteMany({ ...range, ...expiredSoftDelete(cutoff) })
      state.removed += deleted.deletedCount
      // Survivors only — the deleteMany above already took the expired ones.
      const updated = await coll.updateMany({ ...range, $or: DEAD_FIELD_PROBES }, { $unset: UNSET_SPEC })
      state.stripped += updated.modifiedCount
    }

    state.scanned += ids.length
    state.cursor = ids[ids.length - 1]._id
    batches++

    if (batches >= maxBatches) {
      console.log(`\nstopping after ${batches} batches (--max-batches)`)
      break
    }

    if (batches % 20 === 0) {
      const rate = state.scanned / ((Date.now() - startedAt) / 1000)
      const left = Math.max(total - state.scanned, 0)
      const eta = rate > 0 ? Math.round(left / rate / 60) : '?'
      console.log(
        `scanned ${state.scanned.toLocaleString()}/${total.toLocaleString()}` +
        ` (${((state.scanned / total) * 100).toFixed(2)}%)` +
        `  removed ${state.removed.toLocaleString()}` +
        `  stripped ${state.stripped.toLocaleString()}` +
        `  ${Math.round(rate).toLocaleString()} docs/s  ETA ${eta}m`
      )
      saveState(state)
    }

    if (throttleMs) await sleep(throttleMs)
  }

  saveState(state)
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1)
  console.log('\n=== summary ===')
  console.log(`scanned:  ${state.scanned.toLocaleString()}`)
  console.log(`removed:  ${state.removed.toLocaleString()}${dryRun ? ' (would be)' : ''}`)
  console.log(`stripped: ${state.stripped.toLocaleString()}${dryRun ? ' (would be)' : ''}`)
  console.log(`elapsed:  ${mins}m`)

  // A sampled run says little on its own — scale it up so the numbers mean
  // something. Only honest if the sample is representative, hence --from.
  if (state.scanned && state.scanned < total) {
    const factor = total / state.scanned
    const rate = state.scanned / ((Date.now() - startedAt) / 1000)
    console.log('\nextrapolated to the full collection:')
    console.log(`  removed:  ~${Math.round(state.removed * factor).toLocaleString()}`)
    console.log(`  stripped: ~${Math.round(state.stripped * factor).toLocaleString()}`)
    if (rate > 0) console.log(`  full pass at this rate: ~${(total / rate / 3600).toFixed(1)}h`)
  }
  if (!dryRun) console.log('\nNOTE: WiredTiger keeps the freed space inside the collection file.\nRun compact (force: true on a single-node replica set) to hand it back to the OS.')
  process.exit(0)
}

run().catch((err) => {
  console.error('prune failed:', err)
  process.exit(1)
})
