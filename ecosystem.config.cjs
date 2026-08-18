// PM2 ecosystem — `pm2 start ecosystem.config.cjs`
// Runs the compiled TypeScript build (dist/server.js). Rebuild with `npm run build`.
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
        // TC_USERNAME: 'you@company.com',
        // TC_PASSWORD: 'yourpassword',
        // TC_PROXY_KEY: 'change-me',
      },
      max_memory_restart: '200M',
      time: true,
    },
  ],
};
