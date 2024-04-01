const Composer = require('telegraf/composer')
const Queue = require('bull')

const composer = new Composer()

const convertQueue = new Queue('convert', {
  redis: { port: process.env.REDIS_PORT, host: process.env.REDIS_HOST, password: process.env.REDIS_PASSWORD }
})

composer.command('ping', async (ctx) => {
  const webhookInfo = await ctx.telegram.getWebhookInfo()

  const total = await convertQueue.getJobCounts()

  await ctx.replyWithHTML(`🏓 pong\n\nrps: ${ctx.stats.rps.toFixed(0)}\nresponse time: ${ctx.stats.rta.toFixed(2)}\nupdates in the queue: ${webhookInfo.pending_update_count}\n\nConverting queue: ${total.waiting}`)
})

module.exports = composer
