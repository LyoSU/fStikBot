const mongoose = require('mongoose')

// A video picked in fStik Studio, on its way to a video sticker. Written by the
// API (POST studio/video), converted by utils/studio-video.js:
//
//   queued → converting → done | failed
//
// Copy of fstikbot-api database/models/studio-video.js, which creates the rows
// and the indexes (autoIndex is off here); keep the two in step.
const studioVideoSchema = mongoose.Schema({
  telegramId: { type: Number, required: true },
  packType: { type: String, enum: ['regular', 'custom_emoji'], required: true },
  boost: Boolean,
  frameType: String,
  status: { type: String, required: true },
  // 'convert', 'busy', 'timeout' or 'unavailable'
  error: String,
  // The converter downloads the file from the API by this link.
  sourceUrl: String,
  sourceKey: String,
  source: Buffer,
  sourceSize: Number,
  result: Buffer,
  width: Number,
  height: Number,
  size: Number,
  claimedAt: Date,
  attempts: Number,
  updatedAt: Date,
  createdAt: { type: Date, default: Date.now }
}, {
  versionKey: false
})

module.exports = studioVideoSchema
