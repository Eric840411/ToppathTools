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
      // 2026-08-18：kill_timeout 曾經一度改成 5000（PM2 預設 1600ms）想防堵 heavy_tasks
      // migration 那次真實事故（殘留 process 佔用 port 3000）——但那次的根因其實是 migration
      // 本身讓新 process 起不來，不是「舊 process 沒時間關」，延長 shutdown window 擋不住那種
      // 問題，反而讓每次部署使用者實際感受到「網站變慢」（首次載入卡住，重新整理才正常）。
      // migration 已經改成分步驟驗證＋fail fast（見 server/shared.ts），這層防禦性設定的
      // 邊際價值不高，跟 CodeX 討論後移除、回 PM2 預設；如果之後部署還是感覺卡，要查的方向
      // 是 PM2 restart 流程本身／health check／反向代理逾時設定，不是再調這個數字。
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
