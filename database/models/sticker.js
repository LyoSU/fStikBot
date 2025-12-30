const mongoose = require('mongoose')

const stickersSchema = mongoose.Schema({
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
    index: true
  },
  fileUniqueId: {
    type: String,
    index: true,
    required: true
  },
  emojis: String,

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

// Text index for search (supports both old and new caption fields)
stickersSchema.index({ caption: 'text', 'info.caption': 'text' })

// Compound index for inline queries (stickerSet + deleted)
stickersSchema.index({ stickerSet: 1, deleted: 1 })

// Single field index - highly selective, covers most lookups
stickersSchema.index({ fileUniqueId: 1 })

// TTL index - auto-delete documents 30 days after deletedAt is set
// Note: TTL only deletes docs where deletedAt is a Date, so null values are safe
stickersSchema.index(
  { deletedAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
    partialFilterExpression: { deletedAt: { $type: 'date' } }
  }
)

module.exports = stickersSchema
