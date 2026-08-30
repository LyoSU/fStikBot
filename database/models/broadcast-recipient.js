const mongoose = require('mongoose')

// Materialized work queue for an in-flight broadcast.
//
// Why a separate collection (not embedded array on Broadcast):
//   - BSON document limit is 16MB; even Long telegram_id × 1M users hits the
//     ceiling. A flat collection scales without that cliff.
//   - Keyset pagination by _id gives lock-free, resume-after-crash iteration:
//     each batch reads `{broadcastId, _id: $gt: lastRecipientId}` sorted by _id.
//   - Insertion order is preserved by ObjectId monotonicity, so we never sort
//     by anything else.
//
// Lifecycle: materialized at claim time → consumed by runner → bulk-deleted
// when the broadcast reaches a terminal status. The TTL index below is a
// safety net for the rare case where explicit cleanup fails (e.g. Mongo
// blip) — documents older than 30 days disappear on their own.
const broadcastRecipientSchema = new mongoose.Schema({
  broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true, index: true },
  telegram_id: { type: Number, required: true }
}, { timestamps: { createdAt: true, updatedAt: false } })

// Primary iteration index — covers the sendLoop query in broadcast/runner.js.
broadcastRecipientSchema.index({ broadcastId: 1, _id: 1 })

// De-duplication. If materialization crashes halfway the broadcast is re-claimed
// with progress.materialized still false and the audience is walked again — the
// already-inserted rows would be inserted a second time and that slice of the
// audience would receive the post twice. With this index the retry is a no-op
// for rows that already exist (insertMany runs ordered:false and E11000 is
// ignored in broadcast/runner.js).
//
// NOTE: autoIndex is off, so this has to be created once by ops:
//   db.broadcastrecipients.createIndex({ broadcastId: 1, telegram_id: 1 }, { unique: true })
// Until it exists the runner's E11000 handling simply never triggers.
broadcastRecipientSchema.index({ broadcastId: 1, telegram_id: 1 }, { unique: true })

// Failsafe cleanup: 30 days is way longer than any sensible broadcast.
broadcastRecipientSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

module.exports = broadcastRecipientSchema
