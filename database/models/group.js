const mongoose = require('mongoose')

const groupSchema = mongoose.Schema({
  telegram_id: {
    type: Number,
    index: true,
    unique: true,
    required: true
  },
  title: String,
  username: String,
  memberCount: Number
}, {
  timestamps: true
})

module.exports = groupSchema
