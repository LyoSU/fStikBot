// Refunding a Telegram Stars payment (the admin panel's "refund").
//
// The payment is claimed first (status `refunding`, with the status it came
// from in `refundFrom`), so only one refund gets through and a crash leaves a
// trace. Then the Stars go back, then the payment and the balance change in
// one transaction. Only a payment that put credits on the balance (`paid`)
// takes them off again: `credit_failed` and `mismatch` were never credited.
//
// A refund Telegram may or may not have made (a 5xx, a dropped connection)
// stays `refunding`. Running the refund again resumes it: Telegram then says
// CHARGE_ALREADY_REFUNDED, or refunds now, and the records are finished.
const { isTransientError } = require('./transient-error')

const REFUNDABLE = ['paid', 'credit_failed', 'mismatch', 'refunding']
const ALREADY_REFUNDED = /CHARGE_ALREADY_REFUNDED/i

const describe = (error) => error?.description || error?.message || String(error)

/**
 * @returns {Promise<{outcome: 'not_found'|'already'|'not_refundable'|'no_user'|'busy'|'refused'|'uncertain'|'not_recorded'|'done', payment?, error?: string, debited?: number}>}
 */
async function refundStarPayment ({ db, telegram, chargeId }) {
  const payment = await db.Payment.findOne({ 'resultData.telegram_payment_charge_id': chargeId })
  if (!payment) return { outcome: 'not_found' }
  if (payment.status === 'refunded') return { outcome: 'already', payment }
  if (!REFUNDABLE.includes(payment.status)) return { outcome: 'not_refundable', payment }

  const user = await db.User.findOne({ _id: payment.user }).select('_id telegram_id').lean()
  if (!user) return { outcome: 'no_user', payment }

  const refundFrom = payment.status === 'refunding' ? payment.refundFrom : payment.status
  const claimed = await db.Payment.findOneAndUpdate(
    { _id: payment._id, status: payment.status },
    { $set: { status: 'refunding', refundFrom } }
  )
  if (!claimed) return { outcome: 'busy', payment }

  try {
    await telegram.callApi('refundStarPayment', { user_id: user.telegram_id, telegram_payment_charge_id: chargeId })
  } catch (error) {
    if (!ALREADY_REFUNDED.test(describe(error))) {
      // Unknown outcome: stays claimed, to be run again.
      if (isTransientError(error)) return { outcome: 'uncertain', payment, error: describe(error) }
      // Refused. A first attempt goes back as it was. A resumed one stays
      // claimed: an earlier attempt may have refunded already.
      if (payment.status !== 'refunding') {
        await db.Payment.updateOne({ _id: payment._id, status: 'refunding' }, { $set: { status: refundFrom }, $unset: { refundFrom: '' } })
      }
      return { outcome: 'refused', payment, error: describe(error) }
    }
  }

  const debit = refundFrom === 'paid' ? payment.amount : 0
  const session = await db.connection.startSession()
  try {
    await session.withTransaction(async () => {
      const done = await db.Payment.updateOne(
        { _id: payment._id, status: 'refunding' },
        { $set: { status: 'refunded' }, $unset: { refundFrom: '' } },
        { session }
      )
      if (done.matchedCount !== 1) throw new Error('the refund claim is gone')
      if (debit) await db.User.updateOne({ _id: user._id }, { $inc: { balance: -debit } }, { session })
    })
  } catch (error) {
    return { outcome: 'not_recorded', payment, error: describe(error) }
  } finally {
    await session.endSession()
  }

  // `refundFrom` is missing on a claim left by the code before it existed:
  // the balance is then left for a look by hand.
  return { outcome: 'done', payment, debited: debit, refundFrom }
}

module.exports = { refundStarPayment, REFUNDABLE }
