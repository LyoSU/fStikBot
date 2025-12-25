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

// Indexes for queue processing queries
schema.index({ status: 1, date: 1 })
schema.index({ editStatus: 1, date: 1 })
schema.index({ creator: 1 })
schema.index({ createdAt: -1 })

module.exports = schema
