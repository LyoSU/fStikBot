const mongoose = require('mongoose')

// NOTE on schema coexistence:
// The collection holds ~488M docs, of which ~94% still use the nested
// info.* / file.* shape from 2019-2022. A bulk rewrite is not viable
// at that scale (~weeks of writes on a single-node setup), so the
// legacy shape is treated as a FIRST-CLASS format, not tech debt.
// Every read path uses $or against both shapes; getter methods below
// normalize reads transparently. Writes go to the new shape only.
// See scripts/README.md for the full rationale.
const stickersSchema = mongoose.Schema({
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
    // Note: No separate index - covered by compound { stickerSet: 1, deleted: 1 } below
  },
  fileUniqueId: {
    type: String,
    required: true
  },
  emojis: String,
  // Set by Studio publishes. Both stay absent on other docs: keywords must
  // not appear unless someone set them, and `default: undefined` stops
  // mongoose from filling in [].
  emojiList: { type: [String], default: undefined },
  keywords: { type: [String], default: undefined },

  // Set by the Studio worker's sync (pack-ops/worker-repo.js writeSync) for the
  // sticker archive. All optional and without defaults, so old docs stay as
  // they are: 'static' | 'animated' | 'video' and Telegram's thumbnail file_id
  // on live rows; where a deleted sticker stood (its index in the pack and the
  // file_unique_id right before it, null when first); the placeholder's row
  // once removed, which never belongs in the archive; and when a deleted
  // sticker went back into the pack under another file_unique_id.
  format: String,
  thumbFileId: String,
  deletedPosition: Number,
  deletedAfter: { type: String, default: undefined },
  placeholder: { type: Boolean, default: undefined },
  restoredAt: Date,

  // NEW: Flat fields (used for new documents)
  fileId: String,
  stickerType: String,
  caption: String,

  // NEW: Original file data (only if different from current)
  original: {
    fileId: String,
    fileUniqueId: String,
    stickerType: String
  },

  // LEGACY: Keep for backwards compatibility (old documents)
  info: {
    stickerType: String,
    file_id: String,
    file_unique_id: String,
    caption: String
  },
  file: {
    stickerType: String,
    file_id: String,
    file_unique_id: String
  },

  deleted: {
    type: Boolean,
    default: false
  },

  // NEW: For TTL auto-cleanup
  deletedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
})

// ===================
// GETTER METHODS
// Read from new format OR fallback to legacy
// ===================

stickersSchema.methods.getFileId = function () {
  return this.fileId || (this.info && this.info.file_id)
}

stickersSchema.methods.getStickerType = function () {
  return this.stickerType || (this.info && this.info.stickerType) || 'sticker'
}

stickersSchema.methods.getCaption = function () {
  return this.caption || (this.info && this.info.caption)
}

stickersSchema.methods.getOriginalFileId = function () {
  return (this.original && this.original.fileId) || (this.file && this.file.file_id)
}

stickersSchema.methods.getOriginalFileUniqueId = function () {
  return (this.original && this.original.fileUniqueId) || (this.file && this.file.file_unique_id)
}

stickersSchema.methods.hasOriginal = function () {
  return !!((this.original && this.original.fileId) || (this.file && this.file.file_id))
}

stickersSchema.methods.getOriginalStickerType = function () {
  return (this.original && this.original.stickerType) || (this.file && this.file.stickerType)
}

// ===================
// INDEXES
// ===================

// Text index for search (supports both old and new caption fields).
//
// UNUSED as of this writing: there is no $text query anywhere in the codebase
// (inline search uses $regex on caption/emojis). On a collection this size the
// index is expensive to keep. Left in place deliberately — dropping it is an
// ops decision, to be made against `db.stickers.getIndexes()`, not a code
// change. autoIndex is off on both connections, so this declaration no longer
// triggers a createIndex at boot.
stickersSchema.index({ caption: 'text', 'info.caption': 'text' })

// Compound index for inline queries (stickerSet + deleted)
stickersSchema.index({ stickerSet: 1, deleted: 1 })

// Single field index - highly selective, covers most lookups
stickersSchema.index({ fileUniqueId: 1 })

// No index on `original.fileUniqueId` (nor on `file.file_unique_id`, never
// declared here): their one reader, findLiveBySource below, goes through
// { stickerSet, deleted }. Both exist on production until dropped by hand
// (scripts/README.md, "Sticker uid indexes").

// TTL index - auto-delete documents 30 days after deletedAt is set
// Note: Created manually in MongoDB, not via Mongoose to avoid recreation issues
// db.stickers.createIndex({ deletedAt: 1 }, { expireAfterSeconds: 2592000, partialFilterExpression: { deletedAt: { $type: "date" } } })
// stickersSchema.index(
//   { deletedAt: 1 },
//   {
//     expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
//     partialFilterExpression: { deletedAt: { $type: 'date' } }
//   }
// )

// A live sticker of the pack made from this source file, under any of the
// fields a source uid has lived in (fileUniqueId; original.* for converted
// files; file.* in legacy rows). The one duplicate check for adds and restores.
//
// Read through { stickerSet, deleted }: a pack's live stickers are at most a
// few hundred, and the $or is checked on those. Left to the planner, the $or
// could run as an OR over three uid indexes, and it is the only reader of two
// of them: `file.file_unique_id` (8.1 GB) and `original.fileUniqueId` (1.2 GB).
// With this hint neither is read by anything, so they can be dropped
// (scripts/README.md, "Sticker uid indexes"). `file.file_unique_id` is not a
// copy of `fileUniqueId`: in legacy rows it is the source the user sent (a
// photo, a document), and it differs from the sticker's uid in every row
// sampled (2026-11-27, 18471 of 18471), so the field itself stays.
const LIVE_BY_PACK = { stickerSet: 1, deleted: 1 }

stickersSchema.statics.findLiveBySource = function (stickerSet, sourceUid, { except } = {}) {
  return this.findOne({
    stickerSet,
    deleted: false,
    ...(except ? { _id: { $ne: except } } : {}),
    $or: [
      { fileUniqueId: sourceUid },
      { 'original.fileUniqueId': sourceUid },
      { 'file.file_unique_id': sourceUid }
    ]
  }).hint(LIVE_BY_PACK).lean()
}

module.exports = stickersSchema
