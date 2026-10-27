const mongoose = require('mongoose')

// A video picked in fStik Studio, on its way to a video sticker. Written by the
// API (POST studio/video), which also adds its job to the convert queue and
// takes the WebM back (fstikbot-api utils/studio/video-job.js); the bot only
// converts it, as any job in that queue:
//
//   converting → done | failed
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
  // The convert queue's job for it: a process that takes the video over after
  // a restart waits on this job instead of converting the video again.
  jobId: String,
  // The API added the job and settles the row.
  direct: Boolean,
  // Left from the bot's relay, which claimed 'queued' rows.
  claimedAt: Date,
  // The job waits in the convert queue (true) until the converter starts it
  // (startedAt): Studio says "in line" until then.
  waiting: Boolean,
  startedAt: Date,
  attempts: Number,
  updatedAt: Date,
  createdAt: { type: Date, default: Date.now }
}, {
  versionKey: false
})

module.exports = studioVideoSchema
