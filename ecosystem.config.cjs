module.exports = {
  apps: [
    {
      name: "odds-worker",
      script: "./poller.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" }
    },
    {
      name: "odds-web-api",
      script: "./server.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      kill_timeout: 12000,          // give server.js time to close Chrome (releases profile lock)
      shutdown_with_message: true,  // Windows: deliver 'shutdown' message instead of a hard kill
      exp_backoff_restart_delay: 1000,
      env: { NODE_ENV: "production" }
    }
  ]
};