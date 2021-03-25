const mongoose = require('mongoose')

const stickersSchema = mongoose.Schema({
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  fileUniqueId: {
    type: String,
    index: true,
    unique: true,
    required: true
  },
  emojis: String,
  info: Object,
  file: Object,
  deleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

module.exports = stickersSchema
