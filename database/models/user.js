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
  inlineStickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
    index: true
  },
  inlineType: {
    type: String
  },
  newsSubscribedDate: {
    type: Date
  },
  balance: {
    type: Number,
    default: 0
  },
  locale: {
    type: String,
    index: true
  },
  blocked: {
    type: Boolean,
    default: false,
    index: true
  },
  adminRights: {
    type: Array,
    default: []
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
  banned: {
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

// Compound index for messaging queries
userSchema.index({ locale: 1, blocked: 1 })

module.exports = userSchema
