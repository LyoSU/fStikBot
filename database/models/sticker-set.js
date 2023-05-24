const mongoose = require('mongoose')

const stickerSetsSchema = mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
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
    type: Date,
    index: true
  },
  about: {
    description: String,
    tags: [String],
    languages: [String],
    safe: {
      type: Boolean,
      default: false,
      index: true
    },
    verified: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  reaction: {
    like: {
      type: Number,
      default: 0,
      index: true
    },
    dislike: {
      type: Number,
      default: 0,
      index: true
    },
    total: {
      type: Number,
      default: 0,
      index: true
    }
  },
  installations: {
    day: {
      type: Number,
      default: 0,
      index: true
    },
    week: {
      type: Number,
      default: 0,
      index: true
    },
    month: {
      type: Number,
      default: 0,
      index: true
    },
    total: {
      type: Number,
      default: 0,
      index: true
    }
  },
  moderated: {
    type: Boolean,
    default: false
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

module.exports = stickerSetsSchema
