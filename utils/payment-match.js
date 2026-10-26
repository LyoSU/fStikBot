// Whether a Stars payment is the one its Payment asked for: Telegram Stars,
// and exactly the price the invoice was made with (handlers/donate.js, or
// utils/studio-invoices.js for Studio). Telegram only charges what the invoice
// says, so a mismatch means a Payment that was changed or an invoice not made
// from it; either way nothing is credited for it.

/**
 * @param {{currency?: string, price?: number}} payment our Payment
 * @param {{currency?: string, total_amount?: number}} paid Telegram's
 *   successful_payment or pre_checkout_query
 */
function paysFor (payment, paid) {
  return payment?.currency === 'XTR' &&
    paid?.currency === 'XTR' &&
    Number.isInteger(payment.price) &&
    paid.total_amount === payment.price
}

module.exports = { paysFor }
