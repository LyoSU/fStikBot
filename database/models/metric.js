const mongoose = require('mongoose')

// Daily product counters: one document per UTC day, `_id` = "YYYY-MM-DD",
// `counts` = { <event name>: <number> }. Written by utils/metrics.js.
const metricSchema = mongoose.Schema({
  _id: String,
  counts: {
    type: Object,
    default: {}
  },
  // TTL anchor — set on the day's first write; old days drop after 180 days.
  expireAt: Date
}, {
  versionKey: false,
  minimize: false
})

metricSchema.index({ expireAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 })

module.exports = metricSchema
