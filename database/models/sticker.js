const mongoose = require('mongoose')

const stickersSchema = mongoose.Schema({
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
    index: true
  },
  fileUniqueId: {
    type: String,
    index: true,
    required: true
  },
  emojis: String,
  info: {
    stickerType: String,
    file_id: String,
    file_unique_id: String,
    caption: {
      type: String,
      text: true
    }
  },
  file: {
    stickerType: String,
    file_id: String,
    file_unique_id: String
  },
  deleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

stickersSchema.index({ caption: 'text' })
stickersSchema.index({ stickerSet: 1, deleted: 1 })
stickersSchema.index({ stickerSet: 1, fileUniqueId: 1, deleted: 1 })
stickersSchema.index({ 'file.file_unique_id': 1, deleted: 1 })

module.exports = stickersSchema
