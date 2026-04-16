/* eslint-disable camelcase */
const config = require('../config.json')
const telegram = require('./telegram')

// Backlog-size monitor. Note this is NOT a hang detector: it runs INSIDE
// the event loop via setInterval — if the loop were truly blocked, this
// function would never fire either. What it can detect is a growing
// queue of pending updates (server-side, reported by getWebhookInfo),
// which means we're not processing fast enough.
//
// Historical landmine: previous versions called `process.exit(1)` at
// pending>100 to "recover". That caused a self-destructive loop on any
// legitimate burst: exit → PM2 restart → Telegram replays all pending
// (now even larger) → monitor fires again → exit → … Removed. If a real
// hang ever needs self-healing, do it from a worker_thread watchdog, not
// from within the loop that's "hung".
//
// Thresholds:
//   - WARN (>40, every 10 updates of growth): post an alert, keep running.
//     Burst recoveries decrease the count; only sustained growth is worth
//     paging on.
//   - ALERT (>250, sampled once per call): post an alert with a louder tag.
//     Still don't exit — ops decides based on whether count stays high
//     across the next samples.
const WARN_THRESHOLD = 40
const ALERT_THRESHOLD = 250

const updateMonitor = async () => {
  const webhookInfo = await telegram.getWebhookInfo().catch(console.error)
  if (!webhookInfo) return

  const { pending_update_count } = webhookInfo

  if (pending_update_count > ALERT_THRESHOLD) {
    console.error(`[update-monitor] pending=${pending_update_count} (high)`)
    await telegram.sendMessage(
      config.logChatId,
      `❌ pending updates: <b>${pending_update_count}</b> — backlog is not clearing`,
      { parse_mode: 'HTML' }
    ).catch(console.error)
    return
  }

  if (pending_update_count > WARN_THRESHOLD && pending_update_count % 10 === 0) {
    console.warn(`[update-monitor] pending=${pending_update_count}`)
    await telegram.sendMessage(
      config.logChatId,
      `⚠️ pending updates: <b>${pending_update_count}</b>`,
      { parse_mode: 'HTML' }
    ).catch(console.error)
  }
}

module.exports = updateMonitor
