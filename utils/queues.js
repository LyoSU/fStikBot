// utils/queues.js
const Queue = require('bull')

const redisConfig = {
  port: process.env.REDIS_PORT,
  host: process.env.REDIS_HOST,
  password: process.env.REDIS_PASSWORD
}

// Shared queue instances — do not re-instantiate in consumers.
const convertQueue = new Queue('convert', { redis: redisConfig })
const removebgQueue = new Queue('removebg', { redis: redisConfig })
const videoNoteQueue = new Queue('videoNote', { redis: redisConfig })

module.exports = { convertQueue, removebgQueue, videoNoteQueue, redisConfig }
