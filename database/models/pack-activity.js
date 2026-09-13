const mongoose = require('mongoose')

// Who did what in a shared pack — the co-edit activity log (utils/coedit.js).
// Kept small on purpose: only packs with co-editors are logged, a burst of
// adds by one person is one entry with a count, and entries expire after 30
// days (TTL index — created by scripts/ensure-indexes.js, autoIndex is off).
const packActivitySchema = mongoose.Schema({
  stickerSet: { type: mongoose.Schema.Types.ObjectId, ref: 'StickerSet', required: true },
  actor: {
    telegramId: Number,
    name: String
  },
  action: { type: String, required: true },
  count: Number,
  fileUniqueId: String,
  target: {
    telegramId: Number,
    name: String
  },
  role: String
}, {
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false
})

packActivitySchema.index({ stickerSet: 1, createdAt: -1 })
packActivitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

module.exports = packActivitySchema
