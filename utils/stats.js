// Rolling rps / response-time averages, exposed as ctx.stats (read by /ping)
// and as a PM2 metric. Nothing here is logged: at ~40 rps the old per-second
// console.log lines added ~350k lines a day to the PM2 logs.
const io = require('@pm2/io')

const stats = {
  rpsAvrg: 0,
  responseTimeAvrg: 0,
  times: {}
}

const rtOP = io.metric({
  name: 'response time',
  unit: 'ms'
})

// .unref() so this stats sampler doesn't keep the process alive on shutdown.
setInterval(() => {
  const keys = Object.keys(stats.times)

  // Prevent memory accumulation: clean up old entries if too many
  if (keys.length > 60) {
    // splice (not slice) so `keys` below no longer lists the deleted entries
    const keysToDelete = keys.splice(0, keys.length - 60)
    keysToDelete.forEach(key => delete stats.times[key])
  }

  if (keys.length > 1) {
    const time = keys[0]

    const rps = stats.times[time].length
    if (stats.rpsAvrg > 0) stats.rpsAvrg = (stats.rpsAvrg + rps) / 2
    else stats.rpsAvrg = rps

    const sumResponseTime = stats.times[time].reduce((a, b) => a + b, 0)
    const lastResponseTimeAvrg = (sumResponseTime / stats.times[time].length) || 0
    if (stats.responseTimeAvrg > 0) stats.responseTimeAvrg = (stats.responseTimeAvrg + lastResponseTimeAvrg) / 2
    else stats.responseTimeAvrg = lastResponseTimeAvrg

    rtOP.set(stats.responseTimeAvrg)

    delete stats.times[time]
  }
}, 1000).unref()

module.exports = async (ctx, next) => {
  const startMs = new Date()

  ctx.stats = {
    rps: stats.rpsAvrg,
    rta: stats.responseTimeAvrg
  }

  return next().then(() => {
    const now = Math.floor(new Date() / 1000)

    if (!stats.times[now]) stats.times[now] = []
    stats.times[now].push(new Date() - startMs)
  })
}
