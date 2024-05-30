const mongoose = require('mongoose')

const paymentsSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  amount: {
    type: Number,
    index: true
  },
  price: {
    type: Number,
    index: true
  },
  currency: {
    type: String,
    index: true
  },
  paymentSystem: {
    type: String,
    index: true
  },
  paymentId: {
    type: String,
    index: true
  },
  status: {
    type: String,
    index: true
  },
  resultData: {
    type: Object
  }
}, {
  timestamps: true
})

module.exports = paymentsSchema
