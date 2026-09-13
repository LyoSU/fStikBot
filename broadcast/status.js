// Single source of truth for broadcast status values.
//
// Transitions are enforced at the write sites with conditional updates
// (`findOneAndUpdate({ status: … })`), not with a transition table here:
//   queued → sending (worker claim), sending → paused/completed/failed/cancelled,
//   paused/failed → queued (admin resume/retry), anything non-terminal → cancelled.

const STATUS = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
})

const TERMINAL = new Set([STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED])

const isTerminal = (status) => TERMINAL.has(status)

module.exports = { STATUS, isTerminal }
