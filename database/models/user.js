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
    ref: 'StickerSet',
    index: true
  },
  videoStickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  inlineStickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  animatedStickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet'
  },
  inlineType: {
    type: String
  },
  newsSubscribedDate: {
    type: Date
  },
  premium: {
    type: Boolean,
    default: false
  },
  balance: {
    type: Number,
    default: 0
  },
  locale: String,
  blocked: {
    type: Boolean,
    default: false
  },
  webapp: {
    country: String,
    platform: String,
    browser: String,
    version: String,
    os: String
  },
  moderator: {
    type: Boolean,
    default: false
  },
  publicBan: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
})

module.exports = userSchema
