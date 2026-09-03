// PM2 ecosystem — `pm2 start ecosystem.config.cjs`
// Single app now: tc365-bot = HTTP proxy + Telegram bot + per-user scheduler
// in one process (replaces the old tc365-proxy + tc365-scheduler pair).
module.exports = {
  apps: [
    {
      name: 'tc365-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jerusalem',
        PORT: '8787',
        HOST: '127.0.0.1',
        // Secrets live in <repo>/.env (gitignored): TC_BOT_TOKEN, TC_ENC_KEY.
        // Scheduling defaults live in the code / .env; overrides:
        // TC_SCHED_PUNCH_HOUR=9      default punch-in hour (per-user override via /hour)
        // TC_SCHED_JITTER_MIN=30     +/- jitter minutes
        // TC_SCHED_MIN_HOURS=8       shift range (hours)
        // TC_SCHED_MAX_HOURS=10
        // TC_SCHED_DAILY=mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,sun:HOME
        // TC_SKIP_HOLIDAYS=true      skip Israeli holidays (Hebcal)
        // TC_ADMIN_CHAT=6313947459   chat id allowed to run /users & /remove
      },
      max_memory_restart: '200M',
      time: true,
    },
  ],
};
