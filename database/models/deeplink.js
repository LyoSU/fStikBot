const mongoose = require('mongoose')

const deeplinkSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  deepLink: {
    type: String,
    index: true
  }
}, {
  timestamps: true
})

module.exports = deeplinkSchema
