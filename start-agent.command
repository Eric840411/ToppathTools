#!/usr/bin/env bash
# macOS 雙擊啟動用：在 Finder 直接點兩下會用「終端機」開啟並執行。
# 第一次使用前若被 Gatekeeper 擋下，請在「系統設定 → 隱私權與安全性」按「仍要打開」，
# 或先執行：chmod +x start-agent.command start-agent.sh
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ./start-agent.sh
