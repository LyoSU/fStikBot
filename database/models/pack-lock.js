const mongoose = require('mongoose')

// One publish per pack at a time (pack-ops/store.js). _id is the pack name;
// a holder proves itself by token and keeps the lock alive by pushing
// expiresAt forward. An expired lock is free to take — that is what frees a
// pack after a crashed run. The TTL index only sweeps old rows.
const packLockSchema = mongoose.Schema({
  _id: String,
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, {
  versionKey: false
})

packLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

module.exports = packLockSchema
