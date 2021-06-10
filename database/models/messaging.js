const mongoose = require('mongoose')

const schema = mongoose.Schema({
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  name: String,
  message: {
    type: { type: String },
    data: Object
  },
  sendErrors: Array,
  status: {
    type: Number,
    default: 0
  },
  editStatus: {
    type: Number,
    default: 0
  },
  result: {
    total: {
      type: Number,
      default: 0
    },
    state: {
      type: Number,
      default: 0
    },
    error: {
      type: Number,
      default: 0
    }
  },
  date: Date
}, {
  timestamps: true
})

module.exports = schema
