const mongoose = require('mongoose')

// A file uploaded in fStik Studio, waiting to be published into a pack. Written
// by the API, read by the publish worker (pack-ops/worker.js). The worker
// remembers the Telegram file_id of its upload here so a retry doesn't spend
// the user's upload quota twice.
const studioAssetSchema = mongoose.Schema({
  telegramId: { type: Number, required: true },
  sha256: { type: String, required: true },
  format: { type: String, enum: ['static', 'video', 'animated'], required: true },
  width: Number,
  height: Number,
  size: Number,
  // Dropped once uploadStickerFile has it (pack-ops/worker-repo.js), unless
  // the commit sends it itself as a thumbnail; a repeat upload brings it back.
  data: Buffer,
  fileId: { type: String, default: null },
  // uploadStickerFile ties the file_id to a user_id; reuse it only for the same one.
  fileOwner: Number,
  createdAt: { type: Date, default: Date.now }
}, {
  versionKey: false
})

// Indexes are created by the API (autoIndex is off here):
//   { telegramId: 1, sha256: 1 }
//   { createdAt: 1 }, expireAfterSeconds: 7 days

module.exports = studioAssetSchema
