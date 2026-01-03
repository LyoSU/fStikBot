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
    index: true,
    unique: true,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  animated: {
    type: Boolean,
    default: false
  },
  video: {
    type: Boolean,
    default: false
  },
  inline: {
    type: Boolean,
    default: false
  },
  packType: {
    type: String,
    default: 'regular',
    index: true
  },
  boost: {
    type: Boolean,
    default: false
  },
  frameType: String,
  emojiSuffix: String,
  create: {
    type: Boolean,
    default: false
  },
  thirdParty: {
    type: Boolean,
    default: false,
    index: true
  },
  hide: {
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
      default: false,
      index: true
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

stickerSetsSchema.index({
  public: 1,
  'about.description': 'text',
  title: 'text'
}, {
  weights: {
    'about.description': 5,
    title: 1
  }
})

// Compound indexes for /packs query performance
// Covers: find({ owner, create, hide, inline/packType }).sort({ updatedAt: -1 })
stickerSetsSchema.index({ owner: 1, create: 1, hide: 1, inline: 1, packType: 1, updatedAt: -1 })
// For inline queries: find({ owner, inline }).sort({ updatedAt: -1 })
stickerSetsSchema.index({ owner: 1, inline: 1, updatedAt: -1 })
// Note: { owner: 1, hide: 1 } removed - covered by the main compound index above

module.exports = stickerSetsSchema
