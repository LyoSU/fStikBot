const Queue = require('bull')
const Telegram = require('telegraf/telegram')

const telegram = new Telegram(process.env.BOT_TOKEN)

module.exports = (findUser, text, extra) => new Promise((resolve) => {
  const users = findUser.cursor()

  const jobName = `messaging_${Math.random()}`

  const queue = new Queue(jobName, {
    limiter: {
      max: 10,
      duration: 1000
    }
  })

  queue.process((job, done) => {
    telegram.sendMessage(job.data.chatId, job.data.text, job.data.extra).then((result) => {
      done()
    }).catch((error) => {
      done(new Error(error))
    })
  })

  users.on('data', (user) => {
    queue.add({
      chatId: user.telegram_id,
      text,
      extra
    })
  })

  const interval = setInterval(async () => {
    const jobCounts = await queue.getJobCounts()

    console.log(jobCounts)

    if (jobCounts.waiting <= 0 && jobCounts.delayed <= 0) {
      console.log('finish')
      resolve()
      clearInterval(interval)
    }
  }, 1000)
})
