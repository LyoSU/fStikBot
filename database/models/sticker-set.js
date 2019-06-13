const mongoose = require('mongoose')


const stickerSetsSchema = mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  name: {
    type: String,
    index: true,
    unique: true,
    required: true,
  },
  title: {
    type: String,
    index: true,
    required: true,
  },
  emojiSufix: String,
  create: {
    type: Boolean,
    default: false,
  },
  hide: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
})


module.exports = stickerSetsSchema
