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

// A pending Payment is created per tap on a credit package; most are never
// paid. They expire after 30 days — an invoice that old is not coming back.
paymentsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: 'pending' } }
)

module.exports = paymentsSchema
