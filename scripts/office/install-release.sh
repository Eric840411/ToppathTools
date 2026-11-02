#!/usr/bin/env bash
# 在 Spug 主機上安裝一個文書工具版本，並一次切換過去（docs/features/34-office.md）。
#   bash scripts/office/install-release.sh <版本名>.tar.gz          安裝並切換
#   bash scripts/office/install-release.sh --rollback <版本名>       切回已裝過的版本
# OFFICE_DIST_DIR 要跟 Toppath server 的同一個值（預設 <Toppath 目錄>/office-dist）。
# 切換只改 CURRENT 一個檔（先寫 CURRENT.tmp 再 mv），不用重啟 server；不覆寫既有版本目錄，保留最近 3 個。
set -euo pipefail

BASE="${OFFICE_DIST_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/office-dist}"
APPS=(word excel ppt pdf photo light vector design fig cad film effect sound)
KEEP=3
RETAIN_MIN="${OFFICE_RETAIN_MIN:-1440}"

switch_to() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ && "$name" != "." && "$name" != ".." ]] || { echo "版本名不合法：$name" >&2; exit 2; }
  [[ -d "$BASE/releases/$name" ]] || { echo "沒有這個版本：$BASE/releases/$name" >&2; exit 1; }
  # 記下舊版本「被換下來的時間」：已開著的頁面網址綁著舊版本，換下來 RETAIN_MIN 分鐘內不能刪
  if [[ -f "$BASE/CURRENT" ]]; then
    local old; old="$(cat "$BASE/CURRENT")"
    [[ -n "$old" && "$old" != "$name" && -d "$BASE/releases/$old" ]] && touch "$BASE/releases/$old/.retired-at"
  fi
  rm -f "$BASE/releases/$name/.retired-at"
  printf '%s\n' "$name" > "$BASE/CURRENT.tmp"
  mv -f "$BASE/CURRENT.tmp" "$BASE/CURRENT"
  echo "目前版本 → $name"
}

if [[ "${1:-}" == "--rollback" ]]; then
  switch_to "${2:?要給版本名}"
  exit 0
fi

TARBALL="${1:?用法：install-release.sh <版本>.tar.gz | --rollback <版本>}"
NAME="$(basename "$TARBALL" .tar.gz)"
[[ "$NAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "檔名不像版本包：$TARBALL" >&2; exit 2; }
DEST="$BASE/releases/$NAME"
[[ -e "$DEST" ]] && { echo "版本已存在，不覆寫：$DEST（要切回去用 --rollback $NAME）" >&2; exit 1; }

mkdir -p "$BASE/releases"
STAGE="$(mktemp -d "$BASE/releases/.stage-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$TARBALL" -C "$STAGE"
[[ -d "$STAGE/$NAME" ]] || { echo "包裡沒有 $NAME/ 目錄" >&2; exit 1; }

# 先驗再切：至少要有一個工具，有的每個都要有 index.html；路徑不能跳出版本目錄
found=0
for app in "${APPS[@]}"; do
  [[ -d "$STAGE/$NAME/$app" ]] || continue
  [[ -f "$STAGE/$NAME/$app/index.html" ]] || { echo "$app 少了 index.html" >&2; exit 1; }
  found=$((found + 1))
done
(( found > 0 )) || { echo "包裡一個工具都沒有" >&2; exit 1; }
if find "$STAGE/$NAME" -type l | grep -q .; then echo "包裡有 symlink，拒絕安裝" >&2; exit 1; fi

mv "$STAGE/$NAME" "$DEST"
echo "已安裝 $NAME（$found 個工具）"
switch_to "$NAME"

# 只留最近 KEEP 個版本；目前這個一定留，換下來不到 RETAIN_MIN 分鐘的也留（還有人開著舊版本的頁面）
current="$(cat "$BASE/CURRENT")"
ls -1t "$BASE/releases" | grep -v '^\.' | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$old" == "$current" ]] && continue
  marker="$BASE/releases/$old/.retired-at"
  if [[ ! -f "$marker" ]] || [[ -z "$(find "$marker" -mmin +"$RETAIN_MIN")" ]]; then
    echo "保留 $old（換下來未滿 $RETAIN_MIN 分鐘）"
    continue
  fi
  rm -rf "${BASE:?}/releases/${old:?}"
  echo "清掉舊版本 $old"
done
