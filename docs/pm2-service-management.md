# PM2 Service Management

ToppathTools uses PM2 for long-running central services only:

- `toppath-server`: Express API, WebSocket, production `dist` frontend, cron, and Discord bot.
- `toppath-worker`: reserved heavy-worker process for Playwright, AutoSpin, AI batch, and file processing jobs.
- `toppath-tunnel`: ngrok tunnel for the fixed public webhook URL.

Distributed machine-test agents are still intentionally not managed by the central PM2 ecosystem. Start agents manually on whichever machines should join distributed machine testing.

## First-time setup

```bash
npm install -g pm2
npm install
npm run pm2:start
pm2.cmd save
```

On Windows, prefer Task Scheduler for startup:

1. Create a task that runs when the user logs in.
2. Program: `pm2.cmd`
3. Arguments: `resurrect`
4. Start in: `C:\Users\user\Desktop\Toppath tools`

## Daily commands

```bash
npm run pm2:status
npm run pm2:logs
npm run pm2:worker:logs
npm run pm2:tunnel:logs
npm run pm2:restart
npm run pm2:stop
```

`npm run pm2:restart` rebuilds the frontend and restarts only `toppath-server`.

Check the worker from the API:

```bash
curl http://localhost:3000/api/worker/status
```

Or directly:

```bash
curl http://localhost:3010/internal/worker/health
```

Current split:

| Service | Responsibility |
| --- | --- |
| `toppath-server` | Frontend, API, WebSocket, login, status reads, task creation |
| `toppath-worker` | Heavy job runtime boundary; Playwright/AutoSpin/AI/batch jobs move here gradually |
| `toppath-tunnel` | Public ngrok endpoint for webhook access |

The worker is scaffolded first so PM2 can supervise memory, restarts, and logs independently. Heavy routes should migrate one at a time after their input/output contract is clear.

When running PM2 directly from PowerShell, use `pm2.cmd` instead of `pm2`; PowerShell may block `pm2.ps1` depending on the machine execution policy.

## Tunnel startup

`start-tunnel.bat` now builds the frontend, starts or restarts both PM2 apps, and prints PM2 status. It no longer opens separate server and ngrok windows.

On Windows, manually starting PM2 from an interactive terminal may still create a visible Node console window for `toppath-server`. Do not close that window while the server is running; closing it terminates the process and PM2 will restart it.

For unattended/background use, start PM2 through Windows Task Scheduler with `pm2.cmd resurrect` and set the task to run hidden or run whether the user is logged on or not. That is the preferred Windows production mode.

Fixed webhook URL:

```text
https://royal-parched-catcall.ngrok-free.dev/api/machine-test/osm-status
```

## Manual worker agents

Run `start-agent.bat` on each worker machine that should join distributed machine testing.

Defaults:

```text
CENTRAL_URL=ws://localhost:3000
AGENT_LABEL=%COMPUTERNAME%
```

For a worker connecting through the public tunnel:

```bat
set CENTRAL_URL=wss://royal-parched-catcall.ngrok-free.dev
set AGENT_LABEL=QA-PC-01
start-agent.bat
```

The central server receives workers through `/ws/agent`; each worker claims one machine at a time from the shared queue.
