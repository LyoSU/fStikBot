module.exports = {
  apps: [{
    name: 'fStikBot',
    script: './index.js',
    max_memory_restart: '2000M',
    watch: true,
    cron_restart: '0 */6 * * *', // restart every 6 hours
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}
