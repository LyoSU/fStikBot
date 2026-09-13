const mongoose = require('mongoose')

const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  // Display-only field, never load-bearing. Telegram User.first_name is
  // formally required by Bot API, but in practice it can arrive empty or
  // missing (deleted/deactivated accounts, rare anonymous-sender edges).
  // Mongoose String `required: true` rejects empty strings too, which
  // would crash persistUserIfDirty on those updates — so we keep the
  // field optional and let renderers handle the empty case.
  first_name: String,
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
    type: String
    // Note: No separate index - covered by compound { locale: 1, blocked: 1 } below
  },
  // True once the user picked a language via /lang; the ru → uk auto-switch
  // in bot/middleware.js only applies while this is unset.
  localeChosen: {
    type: Boolean
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
  },
  packsCount: {
    regular: { type: Number, default: 0 },
    custom_emoji: { type: Number, default: 0 },
    inline: { type: Number, default: 0 }
  }
}, {
  timestamps: true
})

// Compound index for messaging queries
userSchema.index({ locale: 1, blocked: 1 })

module.exports = userSchema
