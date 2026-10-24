const mongoose = require('mongoose')

// A publish of a pack draft (pack-ops/execute.js): the draft, the plan and
// the state of every step, written before and after each Bot API call so a
// restart resumes it instead of guessing. The shape of draft/steps/mapping is
// owned by pack-ops, hence Mixed.
const packCommitSchema = mongoose.Schema({
  name: { type: String, required: true },
  stickerSet: { type: mongoose.Schema.Types.ObjectId, ref: 'StickerSet' },
  ownerTelegramId: { type: Number, required: true },
  actorTelegramId: Number,
  packType: String,
  // The pack has Boost: its title is longer and carries no bot suffix.
  boost: Boolean,
  // Pack title and thumbnail to set once the stickers are in place (pack-ops/plan.js planSettings).
  settings: mongoose.Schema.Types.Mixed,
  // Client-supplied: a double tap on "Publish" returns the same commit.
  idempotencyKey: String,
  status: { type: String, required: true },
  phase: String,
  format: String,
  base: [String],
  contentBase: [String],
  draft: mongoose.Schema.Types.Mixed,
  known: mongoose.Schema.Types.Mixed,
  steps: mongoose.Schema.Types.Mixed,
  mapping: mongoose.Schema.Types.Mixed,
  error: String,
  // Set by the worker while it uploads files; a stale one means it died.
  claimedAt: Date,
  // The bot's own sticker docs reflect a succeeded commit.
  synced: Boolean,
  // A failing sync is retried with a growing delay, then left (pack-ops/worker.js).
  syncAttempts: Number,
  syncAfter: Date,
  syncError: String,
  createdAt: Date,
  updatedAt: Date
}, {
  versionKey: false,
  minimize: false
})

packCommitSchema.index({ name: 1, status: 1 })
packCommitSchema.index(
  { actorTelegramId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
)

module.exports = packCommitSchema
