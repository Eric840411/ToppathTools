# Toppath Tools

Internal tooling platform for QA automation, OSM/Jira workflows, and game testing.

## Features

| Module | Description |
|--------|-------------|
| **Jira Automation** | Bulk create/comment/transition Jira issues from Lark Bitable |
| **TestCase Generation** | AI-powered (Gemini) test case generation from Lark Wiki / PDF / Google Docs |
| **OSM Tools** | Component version tracking, channel sync, config comparison, version alerts |
| **Machine Test** | Playwright-based automated machine testing with distributed agent support |
| **AutoSpin** | Multi-agent auto-spin management with real-time monitoring |
| **Game Show** | PDF test case generation, image comparison, log interception, Bonus V2 stats |
| **Image Check** | Verify deleted images are no longer loaded in games |
| **Jackpot Monitor** | Real-time jackpot pool monitoring with Lark alert integration |

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express + TypeScript
- **Database**: SQLite (better-sqlite3)
- **AI**: Google Gemini API
- **Browser Automation**: Playwright
- **Process Manager**: PM2

## System Requirements

- Node.js 20+
- npm 9+
- PM2 (`npm install -g pm2`)
- Windows (some features use PowerShell scripts)

## Quick Start (Development)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your actual values

# 3. Start server + frontend (with hot reload)
npm run dev:all
```

## Production Deployment (PM2)

```bash
# 1. Install dependencies and PM2
npm install
npm install -g pm2

# 2. Configure environment
cp .env.example .env
# Edit .env with your actual values

# 3. Build and start all services
npm run pm2:start

# 4. Save PM2 process list for auto-restart
pm2.cmd save

# 5. (Windows) Set up auto-start on login via Task Scheduler:
#    Program:   pm2.cmd
#    Arguments: resurrect
#    Start in:  <project directory>
```

### PM2 Commands

```bash
npm run pm2:status          # View all services
npm run pm2:logs            # Main server logs
npm run pm2:worker:logs     # Worker logs
npm run pm2:tunnel:logs     # ngrok tunnel logs (local dev only)
npm run pm2:restart         # Rebuild frontend + restart server
npm run pm2:worker:restart  # Restart worker only
npm run pm2:stop            # Stop all services
```

## Architecture

```
┌────────────────────────────────────┐
│  toppath-server (port 3000)        │
│  Jira, Gemini, OSM, Integrations   │
│  Proxies heavy requests to worker  │
└──────────────┬─────────────────────┘
               │ HTTP proxy + WS proxy
┌──────────────▼─────────────────────┐
│  toppath-worker (port 3010)        │
│  Machine Test, AutoSpin, Game Show │
│  Playwright, AI-heavy tasks        │
└────────────────────────────────────┘
```

> On a public server, remove the `toppath-tunnel` app from `ecosystem.config.cjs` — the server is directly accessible and does not need a tunnel.

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `JIRA_BASE_URL` | Yes | Your Jira instance URL |
| `LARK_APP_ID` | Yes | Lark app ID |
| `LARK_APP_SECRET` | Yes | Lark app secret |
| `GEMINI_API_KEY` | No | Google Gemini API key (can also add via UI) |
| `OSM_BASE_URL` | Yes | OSM backend URL |
| `OSM_CHANNELS` | Yes | Comma-separated channel codes |
| `ADMIN_PIN` | No | PIN for admin-only operations |
| `GOOGLE_API_KEY` | No | Google Sheets API key |
| `GMAIL_*` | No | Gmail OAuth credentials (ImageRecon report feature) |

> Gemini API keys can also be managed through the in-app Settings UI without editing `.env`.

## OSMWatcher Webhook

Configure OSMWatcher to POST machine status to:
```
https://<your-server>/api/machine-test/osm-status
```

For local development with a temporary public URL, run `generate-osm-api-key.bat` to start a Cloudflare Quick Tunnel.

## Distributed Machine Testing

To add worker agents for distributed testing from other machines:

```bat
set CENTRAL_URL=ws://<server-ip>:3000
set AGENT_LABEL=QA-PC-01
start-agent.bat
```

## Logs

All PM2 logs are written to `./logs/`:
- `pm2-server-out.log` / `pm2-server-error.log`
- `pm2-worker-out.log` / `pm2-worker-error.log`
- `pm2-tunnel-out.log` / `pm2-tunnel-error.log`
