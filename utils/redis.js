// Shared Redis client for broadcast campaigns.
// Bull queues manage their own connections in utils/queues.js.
// Returns null when REDIS_HOST isn't set — callers must null-check.
const Redis = require('ioredis')

const redis = process.env.REDIS_HOST
  ? new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD
    })
  : null

if (redis) redis.on('error', (err) => console.warn('[redis]', err.message))

module.exports = redis
