module.exports = {
  apps: [{
    name: 'fStikBot',
    script: './index.js',
    max_memory_restart: '2000M',
    watch: true,
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}
