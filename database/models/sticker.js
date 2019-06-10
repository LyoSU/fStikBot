const mongoose = require('mongoose')


const stickersSchema = mongoose.Schema({
  setId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
  },
  fileId: {
    type: String,
    index: true,
    unique: true,
    required: true,
  },
  emojis: String,
  hash: {
    md5: {
      type: String,
      index: true,
    },
  },
  info: Object,
  file: Object,
}, {
  timestamps: true,
})


module.exports = stickersSchema
