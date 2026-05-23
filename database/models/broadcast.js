const mongoose = require('mongoose')

// Status state machine — transitions enforced by broadcast/status.js
//   draft     → operator is still building (currently unused: wizard saves as 'queued')
//   queued    → ready, waiting for scheduledAt
//   sending   → worker has claimed it, currently materializing/dispatching
//   paused    → halted by long retry_after or invalid media; resume manually
//   completed → all recipients processed
//   cancelled → operator stopped it
//   failed    → unrecoverable error (e.g. unknown audience)
const STATUSES = ['draft', 'queued', 'sending', 'paused', 'completed', 'cancelled', 'failed']

const broadcastSchema = new mongoose.Schema({
  name: { type: String, required: true },

  // Message payload, captured once via telegraf/core/replicators at wizard time.
  // replyMarkup is fully built (inline_keyboard array) — no re-parsing per send.
  message: {
    type: { type: String, required: true },
    data: { type: Object, required: true },
    replyMarkup: { type: Object, default: null }
  },

  audience: {
    type: { type: String, required: true }, // key in broadcast/audiences.js registry
    // Count captured at create-time. Compared against actual materialized
    // count in the worker; large drift (>5%) logs a warning so the operator
    // notices when the audience changed significantly between creation and
    // dispatch (e.g. scheduled broadcast a week ahead).
    snapshotCount: { type: Number, default: null }
  },

  scheduledAt: { type: Date, required: true },

  status: { type: String, enum: STATUSES, default: 'queued', required: true },
  pausedReason: { type: String, default: null },

  progress: {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    materialized: { type: Boolean, default: false },
    // Keyset checkpoint — last successfully-dispatched recipient _id.
    // On crash/restart we resume from BroadcastRecipient._id > lastRecipientId.
    lastRecipientId: { type: mongoose.Schema.Types.ObjectId, default: null }
  },

  // Aggregated counts by classified error code (see broadcast/errors.js).
  // Plain Object (not Mongoose Map): Map + `$inc: { 'errorCounts.<dyn>': 1 }`
  // happens to work but is brittle across Mongoose versions. Bounded
  // cardinality (~6 keys), so no schema validation needed.
  errorCounts: { type: Object, default: () => ({}) },

  // Bounded sample (max 20 via $slice on push) for admin debug visibility.
  errorSamples: [{
    telegram_id: Number,
    code: String,
    message: String,
    at: Date
  }],

  // Distributed lock with TTL. Any worker may claim if lockedUntil < now.
  lockedBy: { type: String, default: null },
  lockedUntil: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true })

// Claim path: queued+scheduled, or sending with expired lock
broadcastSchema.index({ status: 1, scheduledAt: 1, lockedUntil: 1 })
// List/archive views in admin UI
broadcastSchema.index({ status: 1, createdAt: -1 })
broadcastSchema.index({ createdBy: 1 })

module.exports = broadcastSchema
module.exports.STATUSES = STATUSES
