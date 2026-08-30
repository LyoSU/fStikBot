module.exports = {
  apps: [{
    name: 'fStikBot',
    script: './index.js',
    max_memory_restart: '2000M',
    watch: false,
    cron_restart: '0 */6 * * *', // restart every 6 hours
    // bot.js drains in-flight updates + the broadcast worker for up to 15s on
    // SIGTERM. PM2's default kill_timeout is 1600ms — it would SIGKILL the
    // process long before that drain finishes, making the graceful path moot.
    kill_timeout: 20000,
    // sharp (mosaic split, removebg, quote renderer) and fs I/O share Node's
    // libuv thread pool. Default size is 4 — a single mosaic upload fans out
    // 25+ sharp extract/resize/webp ops that pin all 4 threads and starve
    // everything else (sticker conversion, file reads). 16 is a safe bump
    // for a bot box with >=4 CPU cores.
    env: {
      NODE_ENV: 'development',
      UV_THREADPOOL_SIZE: '16'
    },
    env_production: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '16'
    }
  }]
}
