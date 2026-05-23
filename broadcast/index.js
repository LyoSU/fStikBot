// Public surface for the broadcast subsystem.
//
// Wiring contract:
//   - bot.js calls startWorker() once at boot.
//   - scenes/broadcast.js calls audiences.list() / audiences.get() for the
//     picker, and renderPreview() to show the captured post on confirm.
//   - handlers/admin/messaging.js uses cleanupRecipients() on cancel and
//     renderPreview() for the admin:messaging:view button.
//
// Everything else is internal to the directory.

const { start, stop } = require('./worker')
const audiences = require('./audiences')
const { runBroadcast, cleanupRecipients } = require('./runner')
const { renderPreview } = require('./preview')
const { STATUS, isTerminal } = require('./status')

module.exports = {
  startWorker: start,
  stopWorker: stop,
  runBroadcast,
  cleanupRecipients,
  renderPreview,
  audiences,
  warmupAudienceCounts: audiences.warmupCounts,
  invalidateAudienceCache: audiences.invalidateCache,
  STATUS,
  isTerminal
}
