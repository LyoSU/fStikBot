const mongoose = require('mongoose')

const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  first_name: {
    type: String,
    required: true
  },
  last_name: String,
  username: String,
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  animatedStickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  premium: {
    type: Boolean,
    default: false
  },
  payments: Array,
  locale: String,
  blocked: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

module.exports = userSchema
