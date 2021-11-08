const mongoose = require('mongoose')

const stickerSetsSchema = mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    required: true
  },
  animated: {
    type: Boolean,
    default: false
  },
  private: {
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

module.exports = stickerSetsSchema
