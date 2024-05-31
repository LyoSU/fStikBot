const mongoose = require('mongoose')

const groupSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  title: String,
  username: String,
  memberCount: Number,
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
    index: true
  },
  settings: {
    rights: {
      add: {
        type: String,
        default: 'all'
      },
      delete: {
        type: String,
        default: 'all'
      }
    }
  }
}, {
  timestamps: true
})

module.exports = groupSchema
