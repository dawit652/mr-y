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
      script: "./server.js",        // HTTP API: Redis cache + BullMQ producer (no Chrome)
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      kill_timeout: 15000,          // in-flight requests get SHUTDOWN_GRACE_MS (8s) to finish
      shutdown_with_message: true,  // Windows: deliver 'shutdown' message instead of a hard kill
      exp_backoff_restart_delay: 1000,
      env: { NODE_ENV: "production" }
    },
    {
      name: "casino-worker",
      script: "./queue-worker.js",  // BullMQ consumer: shared Chrome + rotating sessions
      instances: 1,                 // more instances add redundancy, not load: GLOBAL_CONCURRENCY caps all of them
      autorestart: true,
      max_memory_restart: "300M",
      kill_timeout: 30000,          // let active jobs finish and Chrome close cleanly
      shutdown_with_message: true,
      exp_backoff_restart_delay: 1000,
      env: { NODE_ENV: "production" }
    }
  ]
};