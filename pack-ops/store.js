// MongoDB-backed store and pack lock for pack-ops/execute.js. The lock lives
// next to the commit state rather than in Redis: one database to reason about
// after a crash, and the bot already depends on it for everything else.

const crypto = require('crypto')

/**
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoStore (db) {
  return {
    async create (commit) {
      const doc = await db.PackCommit.create(commit)
      return doc.toObject()
    },
    async load (id) {
      return db.PackCommit.findById(id).lean()
    },
    async save (commit) {
      await db.PackCommit.replaceOne({ _id: commit._id }, commit)
    }
  }
}

/**
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoLock (db) {
  return {
    // Takes the lock if it is free or expired; null when someone holds it.
    async acquire (name, ttlMs) {
      const token = crypto.randomUUID()
      const now = Date.now()
      try {
        await db.PackLock.updateOne(
          { _id: name, expiresAt: { $lt: new Date(now) } },
          { $set: { token, expiresAt: new Date(now + ttlMs) } },
          { upsert: true }
        )
        return token
      } catch (err) {
        // The row exists and hasn't expired: the upsert's insert collides.
        if (err?.code === 11000) return null
        throw err
      }
    },
    async extend (name, token, ttlMs) {
      const result = await db.PackLock.updateOne({ _id: name, token }, { $set: { expiresAt: new Date(Date.now() + ttlMs) } })
      return result.matchedCount === 1
    },
    async release (name, token) {
      await db.PackLock.deleteOne({ _id: name, token })
    }
  }
}

module.exports = { mongoStore, mongoLock }
