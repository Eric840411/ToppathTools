const cwd = __dirname

module.exports = {
  apps: [
    {
      name: 'toppath-server',
      cwd,
      script: 'dist-server/server/index.js',
      watch: false,
      windowsHide: true,
      autorestart: true,
      max_memory_restart: '800M',
      max_restarts: 10,
      restart_delay: 3000,
      // migration 失敗 fail-fast（process.exit）後，給舊 process 足夠時間真正釋放 port 3000
      // 再讓 pm2 起新的——2026-08-18 曾經因為這個沒設定夠寬裕，撞過殘留 process 佔用 port
      // 導致 restart loop 假死的真實事故（見 server/shared.ts 的 heavy_tasks migration 註解）
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        WORKER_URL: 'http://127.0.0.1:3010',
      },
      out_file: './logs/pm2-server-out.log',
      error_file: './logs/pm2-server-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'toppath-worker',
      cwd,
      script: 'dist-server/server/worker.js',
      watch: false,
      windowsHide: true,
      autorestart: true,
      max_memory_restart: '700M',
      cron_restart: '0 4 * * *',
      max_restarts: 20,
      restart_delay: 3000,
      kill_timeout: 5000,
      node_args: '--max-old-space-size=640',
      env: {
        NODE_ENV: 'production',
        WORKER_PORT: '3010',
        WORKER_BROWSER_CONCURRENCY: '2',
        WORKER_AI_CONCURRENCY: '1',
        WORKER_BATCH_CONCURRENCY: '1',
      },
      out_file: './logs/pm2-worker-out.log',
      error_file: './logs/pm2-worker-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
