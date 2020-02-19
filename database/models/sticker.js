const mongoose = require('mongoose')

const stickerSchema = mongoose.Schema({
  file_id: {
    type: String,
    index: true,
    required: true
  },
  file_unique_id: {
    type: String,
    index: true,
    required: true
  },
  width: Number,
  height: Number,
  is_animated: Boolean,
  thumb: Object,
  emoji: String,
  set_name: String,
  file_size: Number
})

const stickersSchema = mongoose.Schema({
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  fileId: {
    type: String,
    index: true,
    unique: true,
    required: true
  },
  fileUniqueId: {
    type: String,
    index: true,
    unique: true,
    required: true
  },
  emojis: String,
  hash: {
    md5: {
      type: String,
      index: true
    }
  },
  info: stickerSchema,
  file: stickerSchema,
  deleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

module.exports = stickersSchema
