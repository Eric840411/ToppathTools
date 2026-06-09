#!/usr/bin/env bash
# Toppath worker agent launcher (macOS / Linux)
# 對應 Windows 的 start-agent.bat
#
# 用法：
#   ./start-agent.sh
#   CENTRAL_URL=ws://192.168.1.100:3000 AGENT_LABEL=my-mac ./start-agent.sh
#
# 環境變數（皆可選）：
#   CENTRAL_URL        中央伺服器 WebSocket 位址（預設 ws://localhost:3000）
#   AGENT_LABEL        此 agent 顯示名稱（預設：本機 hostname）
#   AGENT_CAPABILITIES 能力清單，逗號分隔（預設 machine-test,scripted-bet,uat-record,uat-run）
#   AGENT_OWNER_KEY / AGENT_OWNER_NAME / AGENT_TOKEN  （選填）配對用

set -euo pipefail

# 切到腳本所在目錄（專案根目錄）
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${CENTRAL_URL:=ws://localhost:3000}"
: "${AGENT_LABEL:=$(hostname)}"

export CENTRAL_URL AGENT_LABEL

# 基本環境檢查
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 找不到 node，請先安裝 Node.js（建議 18+）：https://nodejs.org/" >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "❌ 找不到 npx（隨 Node.js 一起安裝），請確認 Node.js 安裝完整。" >&2
  exit 1
fi

echo "Starting Toppath worker agent..."
echo "  CENTRAL_URL=$CENTRAL_URL"
echo "  AGENT_LABEL=$AGENT_LABEL"
echo
echo "按 Ctrl+C 可在目前任務跑完後停止此 worker。"
echo

exec npx tsx server/agent-runner.ts
