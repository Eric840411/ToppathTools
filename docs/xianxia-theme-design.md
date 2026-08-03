# ToppathTools 太玄道樞主題

## 方向

本模板依照 Open Design 的「設計契約 + 單頁 Dashboard」方法製作：固定側欄、黏性頂欄、高密度核心指標、圖表、任務表格與事件流。修仙語彙只影響材質、命名、色彩和動態，不犧牲工具操作效率。

## 設計 Token

- 墨黑：`#05070d`、`#090d16`
- 玄月青：`#75d7cf`
- 赤霄紅：`#df765e`
- 古金：`#c7a96b`
- 紙白：`#e8edf4`
- 基準間距：4 / 8 / 12 / 16 / 24 / 28
- 元件圓角：3 至 8px，避免現代膠囊卡片感

## 動態

- 頁面切換：550ms 淡入與上移
- 卡片與按鈕：短距離位移、按壓縮放和點擊漣漪
- 圖表：線條繪製與容量條展開
- 背景：使用者提供的 MP4 以低透明度混合；可以隨時停用
- `prefers-reduced-motion`：停用影片與非必要動畫

## Emoji 規則

- HTML 不包含 Emoji 字元。
- 圖示使用 CSS 幾何線條、文字印章與狀態圓點。
- `.emoji`、`img.emoji`、`[data-emoji]` 會被主題 CSS 隱藏。
- 字型清單不指定任何系統 Emoji 字型。

## 素材

- `xianxia-dashboard-bg.png`：ImageGen 生成的雙境修仙 Dashboard 背景。
- `dual-cultivators-loop.mp4`：使用者提供的動態背景。
- `dual-cultivators-preview.jpg`：使用者提供的封面／Hero 視覺。

## 接入 React

模板確認後，可將 `body[data-realm]` 與 `public/themes/xianxia/xianxia-theme.css` 接入現有 React 主殼。現階段保持獨立，避免覆蓋 `src/App.css` 中尚未提交的 control-room 主題修改。

## 深層功能頁

- 卷宗管理：狀態篩選、文字搜尋、主從詳情與覆核操作。
- 試煉玉簡：環境／套件選擇、四階段執行器、案例清單、進度與終端紀錄。
- 靈機巡檢：環境設定、健康指標、巡檢矩陣與即時軌跡。
- 傀儡監院：Agent 狀態篩選、工作站負載、暫停、指派與異常重啟。
- 藏經閣：分類、文件清單、全文搜尋與閱讀面板。
- 陣法設定：模型、Local Agent、Discord 與安全設定頁籤、開關與儲存狀態。

目前所有深層操作均為前端互動原型，不會呼叫正式 API 或寫入正式設定。
