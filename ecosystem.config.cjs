// PM2 ecosystem — `pm2 start ecosystem.config.cjs`
// Runs the compiled TypeScript build (dist/). Rebuild with `npm run build`.
module.exports = {
  apps: [
    {
      name: 'tc365-proxy',
      script: 'dist/server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
        HOST: '127.0.0.1',
      },
      max_memory_restart: '200M',
      time: true,
    },
    {
      name: 'tc365-scheduler',
      script: 'dist/scheduler.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        TC_PROXY_BASE: 'http://127.0.0.1:8787',
        // Scheduling defaults live in the script; override here if needed:
        // TC_SCHED_PUNCH_HOUR=9
        // TC_SCHED_JITTER_MIN=30
        // TC_SCHED_MIN_HOURS=8
        // TC_SCHED_MAX_HOURS=10
        // Israeli work week (Sun-Thu); fri/sat omitted = no punches:
        TC_SCHED_DAILY: 'mon:OFFICE,tue:OFFICE,wed:HOME,thu:OFFICE,sun:HOME',
        // Israeli holidays: skipped automatically via Hebcal (yomtov days +
        // Yom Ha'Atzma'ut + Sigd). Overrides:
        // TC_SKIP_HOLIDAYS=false        disable holiday skipping entirely
        // TC_HOLIDAY_EXTRA=Atzma,Sigd   extra holiday titles to skip (add
        //                               CH''M to also skip chol hamoed)
        // TC_HOLIDAY_CACHE=/path        holiday cache file location
        // Telegram pings are read from <root>/state.json (telegram.botToken/chatId)
        // or from TC_TG_BOT_TOKEN / TC_TG_CHAT_ID.
      },
      max_memory_restart: '100M',
      time: true,
    },
  ],
};
