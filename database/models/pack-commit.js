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
  // Makes the pack first (pack-ops/execute.js createPack): { title, name?, needsRepainting?, ... }.
  create: mongoose.Schema.Types.Mixed,
  // Credits taken for the commit (a copy into another pack type): { credits, user, refunded? }.
  // The worker gives them back when the commit ends without making the pack.
  charge: mongoose.Schema.Types.Mixed,
  // Deletes the whole set instead of publishing a draft (pack-ops/execute.js removePack).
  // Queued with an empty base and draft, so a worker that predates it stops at a conflict.
  remove: Boolean,
  // The pack lock's key when it is not `name`: a new pack's name changes once it is made.
  lockName: String,
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
  // The executor's recovery state (pack-ops/execute.js). The worker saves a
  // commit with replaceOne, and a strict schema dropped every field not
  // listed here: a resumed publish forgot it had been rebased onto the pack
  // as it was, a resumed removal forgot the archive order, and Studio never
  // got the conflicts it shows on a conflict.
  stale: Boolean,
  fresh: [String],
  rebased: mongoose.Schema.Types.Mixed,
  outside: mongoose.Schema.Types.Mixed,
  conflicts: mongoose.Schema.Types.Mixed,
  removedOrder: mongoose.Schema.Types.Mixed,
  packGone: Boolean,
  // Set by the worker while it uploads files; a stale one means it died.
  claimedAt: Date,
  // A queued commit put back for its owner's upload limit: not claimed before
  // this (pack-ops/worker.js prepare).
  prepareAfter: Date,
  // A pending commit put back for a Telegram limit mid-run: not run before
  // this (pack-ops/execute.js).
  runAfter: Date,
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
// The publish worker's polls (pack-ops/worker-repo.js), every couple of
// seconds: a claim, a runnable commit, an unsynced one (status + synced +
// createdAt), a charge to refund (status + charge.credits). Without them each
// poll scanned the whole collection, 126k commits nearly all succeeded and
// synced, about half a core of the shared Mongo (2026-11-23).
packCommitSchema.index({ status: 1, synced: 1, createdAt: 1 })
packCommitSchema.index({ status: 1, 'charge.credits': 1 })
packCommitSchema.index(
  { actorTelegramId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
)

module.exports = packCommitSchema
