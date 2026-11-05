// Read-only audit: compares the bot's Star transactions with the `payments`
// collection and lists charges that did not end up as a credited payment.
// Writes nothing to Mongo or Telegram; crediting anyone stays a human decision.
//
// Usage:
//   node scripts/audit-star-payments.js [--days 90] [--out report.csv]
// Needs BOT_TOKEN and MONGODB_URI in the environment or .env.
//
// Prefer a read-only Mongo user. The CSV holds Telegram user ids: keep it local.

const path = require('path')
const { ObjectId } = require('mongoose').Types

const PAGE_SIZE = 100
const LOOKUP_BATCH = 1000
const DAY_MS = 24 * 60 * 60 * 1000
// A charge this fresh may still be on its way through the bot.
const IN_FLIGHT_MS = 10 * 60 * 1000

const isObjectIdHex = (value) => typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value)

// Refunds share the id of the original transaction, so an id can appear in both
// directions. Incoming ones are keyed separately for that reason.
function splitTransactions (transactions) {
  const incoming = new Map()
  const refundedIds = new Set()
  for (const tx of transactions) {
    if (tx.source && tx.source.type === 'user') incoming.set(tx.id, tx)
    else if (tx.receiver && tx.receiver.type === 'user') refundedIds.add(tx.id)
  }
  return { incoming, refundedIds }
}

// Returns the verdict for one incoming charge. `ok` needs no attention.
function classify ({ tx, payment, refunded, nowMs }) {
  const ageMs = nowMs - tx.date * 1000
  const payload = tx.source.invoice_payload

  if (!isObjectIdHex(payload)) return 'not_our_invoice'
  if (!payment) return 'no_payment_record'

  const recordedCharge = payment.resultData && payment.resultData.telegram_payment_charge_id
  const isThisCharge = recordedCharge === tx.id

  if (recordedCharge && !isThisCharge) return refunded ? 'second_charge_refunded' : 'second_charge'
  if (payment.status === 'pending') {
    if (refunded) return 'lost_but_refunded'
    return ageMs < IN_FLIGHT_MS ? 'in_flight' : 'lost'
  }
  if (payment.status === 'paid') {
    if (refunded) return 'paid_and_refunded'
    // Without a recorded charge, this one can't be told from a second charge.
    return recordedCharge ? 'ok' : 'paid_without_charge_id'
  }
  if (payment.status === 'refunded' && refunded) return 'ok'
  return `status_${payment.status}`
}

const NEEDS_NO_ATTENTION = new Set(['ok', 'in_flight', 'not_our_invoice'])

async function fetchAllTransactions (callApi) {
  const transactions = []
  let offset = 0
  while (true) {
    const page = await callApi('getStarTransactions', { offset, limit: PAGE_SIZE })
    const batch = page.transactions || []
    transactions.push(...batch)
    if (batch.length < PAGE_SIZE) return transactions
    offset += PAGE_SIZE
  }
}

function makeCallApi (token, fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return async function callApi (method, params) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params)
      })
      const body = await response.json()
      if (body.ok) return body.result
      if (body.error_code === 429) {
        const seconds = (body.parameters && body.parameters.retry_after) || 1
        await wait((seconds + 1) * 1000)
        continue
      }
      // Only the code and description: the URL holds the token.
      throw new Error(`${method} failed: ${body.error_code} ${body.description}`)
    }
    throw new Error(`${method} failed: still rate limited`)
  }
}

function buildRows ({ incoming, refundedIds, paymentsById, usersById, cutoffMs, nowMs }) {
  const rows = []
  for (const tx of incoming.values()) {
    if (tx.date * 1000 < cutoffMs) continue
    const payload = tx.source.invoice_payload
    const payment = isObjectIdHex(payload) ? paymentsById.get(payload.toLowerCase()) : undefined
    const verdict = classify({ tx, payment, refunded: refundedIds.has(tx.id), nowMs })
    const owner = payment && payment.user ? usersById.get(String(payment.user)) : undefined
    rows.push({
      verdict,
      date: new Date(tx.date * 1000).toISOString(),
      charge: tx.id,
      stars: tx.amount,
      payer_telegram_id: tx.source.user && tx.source.user.id,
      payload: payload || '',
      payment_status: payment ? payment.status : '',
      credits: payment ? payment.amount : '',
      price: payment ? payment.price : '',
      recorded_user_telegram_id: owner ? owner.telegram_id : ''
    })
  }
  return rows
}

function toCsv (rows) {
  if (rows.length === 0) return ''
  const columns = Object.keys(rows[0])
  const cell = (value) => {
    const text = String(value === undefined || value === null ? '' : value)
    // A leading =, +, - or @ would run as a formula when opened in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\n') + '\n'
}

async function findInBatches (collection, ids, projection) {
  const found = new Map()
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const docs = await collection.find({ _id: { $in: ids.slice(i, i + LOOKUP_BATCH) } }, { projection }).toArray()
    for (const doc of docs) found.set(String(doc._id), doc)
  }
  return found
}

function parseArgs (argv) {
  const args = { days: 90, out: null }
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--days') args.days = Number(argv[i + 1])
    else if (argv[i] === '--out') args.out = argv[i + 1]
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!(args.days > 0)) throw new Error('--days must be a positive number')
  return args
}

async function main () {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
  const mongoose = require('mongoose')
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.BOT_TOKEN || !process.env.MONGODB_URI) throw new Error('Set BOT_TOKEN and MONGODB_URI')

  const nowMs = Date.now()
  const transactions = await fetchAllTransactions(makeCallApi(process.env.BOT_TOKEN))
  const { incoming, refundedIds } = splitTransactions(transactions)
  console.log(`Fetched ${transactions.length} transactions, ${incoming.size} incoming`)

  const connection = await mongoose.createConnection(process.env.MONGODB_URI, {
    autoIndex: false,
    autoCreate: false,
    readPreference: 'secondaryPreferred'
  }).asPromise()

  try {
    const paymentIds = [...incoming.values()]
      .map((tx) => tx.source.invoice_payload)
      .filter(isObjectIdHex)
      .map((id) => new ObjectId(id))
    const paymentsById = await findInBatches(connection.db.collection('payments'), paymentIds,
      { status: 1, amount: 1, price: 1, user: 1, 'resultData.telegram_payment_charge_id': 1 })
    const userIds = [...paymentsById.values()].map((p) => p.user).filter(Boolean)
    const usersById = await findInBatches(connection.db.collection('users'), userIds, { telegram_id: 1 })

    const rows = buildRows({ incoming, refundedIds, paymentsById, usersById, cutoffMs: nowMs - args.days * DAY_MS, nowMs })
    const attention = rows.filter((row) => !NEEDS_NO_ATTENTION.has(row.verdict))

    const counts = {}
    for (const row of rows) counts[row.verdict] = (counts[row.verdict] || 0) + 1
    console.log(`Last ${args.days} days:`, counts)
    console.log(`Stars in charges to review: ${attention.reduce((sum, row) => sum + row.stars, 0)}`)

    const csv = toCsv(attention)
    if (args.out) {
      const fs = require('fs')
      fs.writeFileSync(args.out, csv, { mode: 0o600 })
      // The mode above only applies when the file is created.
      fs.chmodSync(args.out, 0o600)
      console.log(`${attention.length} rows written to ${args.out}`)
    } else {
      process.stdout.write(csv)
    }
  } finally {
    await connection.close()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = { main, splitTransactions, classify, buildRows, toCsv, fetchAllTransactions, makeCallApi, parseArgs }
