const mongoose = require('mongoose')

const stickerSetsSchema = mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  passcode: {
    type: String,
    index: true
  },
  name: {
    type: String,
    index: true,
    unique: true,
    required: true
  },
  title: {
    type: String,
    text: true,
    required: true
  },
  animated: {
    type: Boolean,
    default: false
  },
  video: {
    type: Boolean,
    default: false
  },
  inline: {
    type: Boolean,
    default: false
  },
  emojiSuffix: String,
  create: {
    type: Boolean,
    default: false
  },
  hide: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

stickerSetsSchema.index({ title: 'text' })

module.exports = stickerSetsSchema
