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
  },
  // 'studio' for a purchase started in Studio, which asks for its invoice link
  // through `invoice` (utils/studio-invoices.js); absent for one from the chat.
  source: {
    type: String
  },
  invoice: {
    // requested → creating → ready | failed | expired
    state: String,
    link: String,
    error: String,
    claimedAt: Date
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

// The invoice maker's queue: only Studio's requests carry invoice.state.
paymentsSchema.index(
  { 'invoice.state': 1, createdAt: 1 },
  { partialFilterExpression: { 'invoice.state': { $exists: true } } }
)

module.exports = paymentsSchema
