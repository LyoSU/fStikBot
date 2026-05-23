// Single source of truth for broadcast status values and allowed transitions.
// Anything that flips broadcast.status must go through assertTransition() so
// we never write an illegal pair (e.g. "completed → sending").

const STATUS = Object.freeze({
  DRAFT: 'draft',
  QUEUED: 'queued',
  SENDING: 'sending',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
})

const TERMINAL = new Set([STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED])

// Allowed forward transitions. Re-claim of an already-sending broadcast after
// a crash is `sending → sending` (lock takeover) which is a no-op on status.
const TRANSITIONS = {
  [STATUS.DRAFT]: [STATUS.QUEUED, STATUS.CANCELLED],
  [STATUS.QUEUED]: [STATUS.SENDING, STATUS.CANCELLED],
  [STATUS.SENDING]: [STATUS.PAUSED, STATUS.COMPLETED, STATUS.CANCELLED, STATUS.FAILED],
  [STATUS.PAUSED]: [STATUS.QUEUED, STATUS.CANCELLED],
  [STATUS.COMPLETED]: [],
  [STATUS.CANCELLED]: [],
  [STATUS.FAILED]: [STATUS.QUEUED, STATUS.CANCELLED]
}

const isTerminal = (status) => TERMINAL.has(status)

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to)

const assertTransition = (from, to) => {
  if (from === to) return
  if (!canTransition(from, to)) {
    throw new Error(`Illegal broadcast status transition: ${from} → ${to}`)
  }
}

module.exports = { STATUS, TERMINAL, isTerminal, canTransition, assertTransition }
