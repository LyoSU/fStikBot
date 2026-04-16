const Composer = require('telegraf/composer')
const { convertQueue } = require('../utils/queues')

const composer = new Composer()

composer.command('ping', async (ctx) => {
  const webhookInfo = await ctx.telegram.getWebhookInfo()

  const total = await convertQueue.getJobCounts()

  await ctx.replyWithHTML(`🏓 pong\n\nrps: ${ctx.stats.rps.toFixed(0)}\nresponse time: ${ctx.stats.rta.toFixed(2)}\nupdates in the queue: ${webhookInfo.pending_update_count}\n\nConverting queue: ${total.waiting}`)
})

module.exports = composer
