// A successful_payment must reach the donate handler whatever scene the payer
// is in: the Stars are already taken, and scenes with a catch-all on('message')
// used to swallow it, so nothing was credited. Runs the real middleware order
// from bot/commands.js and the real stage, without a network or a database.

process.env.LOG_LEVEL = 'error'
process.env.BOT_TOKEN = '0:test' // a dummy on purpose: this test must never reach Telegram

const assert = require('assert')
const Telegraf = require('telegraf')
const Composer = require('telegraf/composer')

const handlers = require('../handlers')
const scenes = require('../scenes')
const registerCommands = require('../bot/commands')

let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.stack}`)
  }
}

function setup (sceneId) {
  const payment = { _id: 'p1', amount: 3, price: 60, currency: 'XTR', status: 'pending' }
  const user = { _id: 'u1', balance: 0 }
  const replies = []
  const fakeDb = {
    Payment: {
      findOne: async () => (payment.status === 'pending' ? payment : null),
      updateOne: async () => null,
      findOneAndUpdate: async (query, update) => {
        if (payment.status !== query.status) return null
        Object.assign(payment, update.$set)
        return payment
      }
    },
    User: {
      findByIdAndUpdate: async (id, update) => {
        user.balance += update.$inc.balance
        return user
      }
    }
  }

  const bot = new Telegraf('0:test')
  bot.botInfo = { id: 1, username: 'test_bot' }
  bot.context.db = fakeDb
  bot.context.config = {}
  bot.catch((error) => { throw error })
  bot.use((ctx, next) => {
    ctx.session = {
      userInfo: { _id: 'u1', balance: 0 },
      scene: { newPack: {} },
      __scenes: sceneId ? { current: sceneId } : {}
    }
    ctx.i18n = { t: (key) => key, locale: () => 'en' }
    ctx.replyWithHTML = async (text) => { replies.push(text) }
    ctx.reply = ctx.replyWithHTML
    return next()
  })

  const privateMessage = new Composer()
  privateMessage.use((ctx, next) => (ctx.chat?.type === 'private' ? next() : false))
  registerCommands(bot, privateMessage, { handlers, privacyHtml: '', db: fakeDb, scenes })

  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: 5, is_bot: false, first_name: 'u' },
      chat: { id: 5, type: 'private' },
      successful_payment: {
        invoice_payload: 'p1',
        currency: 'XTR',
        total_amount: 60,
        telegram_payment_charge_id: 'c1',
        provider_payment_charge_id: 'c1'
      }
    }
  }
  return { bot, update, payment, user, replies }
}

;(async () => {
  console.log('payment in scene test')

  // Every scene is covered, not just the ones with a catch-all today.
  const ids = [null, ...scenes.scenes.keys()]
  for (const id of ids) {
    await test(`credited in ${id || 'no scene'}`, async () => {
      const { bot, update, payment, user, replies } = setup(id)
      await bot.handleUpdate(update)
      assert.strictEqual(payment.status, 'paid')
      assert.strictEqual(user.balance, 3)
      assert.ok(replies.includes('donate.update'), `replies: ${replies}`)
    })
  }

  if (failed) process.exit(1)
  console.log('payment in scene test OK')
  process.exit(0)
})()
