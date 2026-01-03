const mongoose = require('mongoose')

const deeplinkSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  deepLink: {
    type: String
  }
}, {
  timestamps: true
})

// Compound index for findOne({ deepLink, user }) queries
// deepLink first as it's more selective
deeplinkSchema.index({ deepLink: 1, user: 1 })

module.exports = deeplinkSchema
