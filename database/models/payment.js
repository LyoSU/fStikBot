const mongoose = require('mongoose')

const paymentsSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  amount: {
    type: Number
    // Note: index removed - no queries filter by amount alone
  },
  price: {
    type: Number
    // Note: index removed - no queries filter by price alone
  },
  currency: {
    type: String
    // Note: index removed - no queries filter by currency alone
  },
  paymentSystem: {
    type: String
    // Note: index removed - no queries filter by paymentSystem alone
  },
  paymentId: {
    type: String
    // Note: index removed - queries use resultData.telegram_payment_charge_id instead
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

// Index for admin refund lookups by Telegram charge ID
paymentsSchema.index({ 'resultData.telegram_payment_charge_id': 1 })

module.exports = paymentsSchema
