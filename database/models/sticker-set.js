const mongoose = require('mongoose')

const stickerSetsSchema = mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
    // Note: No separate index needed - covered by compound indexes below
  },
  ownerTelegramId: {
    type: Number,
    index: true
  },
  passcode: {
    type: String,
    index: true
  },
  name: {
    type: String,
    unique: true,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  inline: {
    type: Boolean,
    default: false
  },
  // Sticker format flags. Source of truth is per-sticker Telegram data
  // (sticker.is_animated / is_video) — the top-level StickerSet.is_animated /
  // is_video were removed in Bot API 7.2. Without these fields mongoose would
  // silently strip them on save.
  animated: {
    type: Boolean,
    default: false
  },
  video: {
    type: Boolean,
    default: false
  },
  packType: {
    type: String,
    default: 'regular'
  },
  boost: {
    type: Boolean,
    default: false
  },
  frameType: String,
  emojiSuffix: String,
  // file_unique_id of the bootstrap placeholder sticker Telegram forces us to
  // create a set with. Kept until the first real sticker is added (Telegram
  // forbids deleting the last sticker of a set); cleared once the placeholder
  // is actually removed. Absent/null means "no pending placeholder".
  placeholderFileUniqueId: String,
  create: {
    type: Boolean,
    default: false
  },
  thirdParty: {
    type: Boolean,
    default: false
  },
  hide: {
    type: Boolean,
    default: false
  },
  deleted: {
    type: Boolean,
    default: false
  },
  public: {
    type: Boolean,
    default: false
  },
  publishDate: {
    type: Date
  },
  about: {
    description: String,
    tags: [String],
    languages: [String],
    safe: {
      type: Boolean,
      default: false
    },
    verified: {
      type: Boolean,
      default: false
    }
  },
  reaction: {
    like: {
      type: Number,
      default: 0
    },
    dislike: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  installations: {
    day: {
      type: Number,
      default: 0
    },
    week: {
      type: Number,
      default: 0
    },
    month: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  moderated: {
    type: Boolean,
    default: false
  },
  aiModeration: {
    checked: {
      type: Boolean,
      default: false
    },
    isFlagged: {
      type: Boolean,
      default: false
    },
    categoryScores: {
      type: Object
    }
  },
  stickerChannel: {
    messageId: Number
  }
}, {
  timestamps: true
})

// Compound indexes for /packs query performance
// Covers: find({ owner, create, hide, inline/packType }).sort({ updatedAt: -1 })
stickerSetsSchema.index({ owner: 1, create: 1, hide: 1, inline: 1, packType: 1, updatedAt: -1 })
// For inline queries: find({ owner, inline }).sort({ updatedAt: -1 })
stickerSetsSchema.index({ owner: 1, inline: 1, updatedAt: -1 })
// Note: { owner: 1, hide: 1 } removed - covered by the main compound index above

module.exports = stickerSetsSchema
