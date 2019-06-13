const mongoose = require('mongoose')


const userSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true,
  },
  first_name: {
    type: String,
    required: true,
  },
  last_name: String,
  username: String,
  stickerSet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StickerSet',
  },
  premium: {
    type: Boolean,
    default: false,
  },
  donates: Array,
}, {
  timestamps: true,
})


module.exports = userSchema
