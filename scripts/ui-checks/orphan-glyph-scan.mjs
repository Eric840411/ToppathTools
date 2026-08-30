/**
 * 掃描「按鈕／標籤的文字只有一個孤立中文字」的可疑殘骸。
 *
 * 來由：先前移除原生 emoji 時，有幾處只把 emoji 換成一個意義不明的中文字就留著
 * （📋→「冊」、🔊→「聲」），畫面上就是一顆寫著「冊」的按鈕。使用者回報了兩次，
 * 第二次是 ${stale ? ' 警' : ''} 這種寫在**字串裡**的——第一版掃描器只看 JSX
 * 文字節點，抓不到，卻回報「沒問題」。
 *
 * ⚠️ 掃描工具自己壞掉時最危險的形式就是那樣：它不會報錯，只會給一個看起來很安全的
 * 結論。所以下面有自我檢查——用已知一定會命中的樣本先驗自己，驗不過就直接報錯，
 * 不輸出「沒問題」。（這支的 regex 已經被 shell 吃掉反向參照三次，每次症狀都一樣：
 * 安靜地回報乾淨。改這個檔案時用 Write 工具，不要用 heredoc 或 node -e。）
 *
 * **這支不會自動修**：單字標籤不一定是錯的，它只負責列出來讓人判斷。
 *
 * 跑法：node scripts/ui-checks/orphan-glyph-scan.mjs
 */
import fs from 'fs';
import path from 'path';

/** 讀得懂、刻意保留的單字標籤。加白名單前先確認它單獨看真的有意義 */
const KEEP = new Set([
  '人', '組', '天', '筆', '次', '份', '字', '式',   // 單位
  '高', '中', '低',                                  // 嚴重度
  '是', '否', '有', '無', '我', '快', '慢',          // 二元狀態
  '鎖', '破', '境', '樞',                            // 修仙版裝飾
  '黃', '白', '粉', '藍', '紅', '綠',                // GS 統計的顏色代碼
]);

/**
 * 這兩處的單字字串是刻意的，不是殘骸：
 * - src/game/      遊戲版的側邊欄／技能／成就本來就用單字當圖示
 * - src/version.ts changelog 文字，裡面的引號是中文標點不是字串邊界
 */
const SKIP = [/[\\/]game[\\/]/, /version\.ts$/];

const CJK = '[\\u4e00-\\u9fff]';
/** JSX 文字節點：>單字< */
const RE_JSX = new RegExp('>\\s*(' + CJK + ')\\s*<');
/** 字串字面值：'單字' / "單字" / `單字`。結尾的反向參照確保引號成對 */
const RE_STR = new RegExp('([\'"`])\\s*(' + CJK + ')\\s*\\1', 'g');
/** 跨行：<button> 內容只有一個字 */
const RE_MULTILINE = new RegExp('>\\s*\\n\\s*(' + CJK + ')\\s*\\n\\s*</(button|span|em|b)>', 'g');

// ── 自我檢查：用已知樣本確認三條 pattern 真的抓得到 ──
{
  const cases = [
    [RE_JSX, '<button>冊</button>', 'JSX 文字節點'],
    [new RegExp(RE_STR.source, ''), "const x = ' 警'", '字串字面值'],
    [new RegExp(RE_MULTILINE.source, ''), '>\n  冊\n</button>', '跨行按鈕'],
  ];
  for (const [re, sample, name] of cases) {
    if (!re.test(sample)) {
      console.error('❌ 掃描器自我檢查失敗：「' + name + '」抓不到已知樣本 ' + JSON.stringify(sample));
      console.error('   修好之前這支的輸出不可信——不要當成「沒問題」。');
      process.exit(2);
    }
  }
}

/** rendered = 真的會畫在畫面上（JSX 節點）；literal = 字串裡，可能只是邏輯比對 */
const hits = { rendered: [], literal: [] };
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/node_modules|dist/.test(filePath)) walk(filePath); continue }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (SKIP.some(re => re.test(filePath))) continue;

    const src = fs.readFileSync(filePath, 'utf8');
    src.split('\n').forEach((line, i) => {
      const m = line.match(RE_JSX);
      if (m && !KEEP.has(m[1]) && /<button|<span|<i\b|<em\b|<b\b/.test(line)) {
        hits.rendered.push({ file: filePath, line: i + 1, ch: m[1], code: line.trim().slice(0, 90) });
      }
      for (const sm of line.matchAll(new RegExp(RE_STR.source, 'g'))) {
        if (KEEP.has(sm[2])) continue;
        hits.literal.push({ file: filePath, line: i + 1, ch: sm[2], code: line.trim().slice(0, 80) });
      }
    });
    for (const m of src.matchAll(new RegExp(RE_MULTILINE.source, 'g'))) {
      if (KEEP.has(m[1])) continue;
      hits.rendered.push({
        file: filePath, line: src.slice(0, m.index).split('\n').length, ch: m[1],
        code: '<' + m[2] + '> 內容只有「' + m[1] + '」',
      });
    }
  }
}
walk('src');

const show = (list) => list.forEach(h => console.log('  ' + h.file + ':' + h.line + '  「' + h.ch + '」  ' + h.code));
if (hits.rendered.length === 0 && hits.literal.length === 0) {
  console.log('沒有可疑的孤立單字標籤（三條 pattern 都通過自我檢查）');
} else {
  console.log('會畫在畫面上的：' + hits.rendered.length + ' 處  ／  只在字串裡的：' + hits.literal.length + ' 處\n');
  if (hits.rendered.length) { console.log('── 高度可疑（JSX 文字節點，使用者看得到）──'); show(hits.rendered); console.log(''); }
  if (hits.literal.length) { console.log('── 參考（字串字面值，可能只是邏輯比對／欄位名）──'); show(hits.literal); }
  console.log('\n判斷方式：這個字單獨看讀不讀得懂？讀得懂就加進 KEEP，讀不懂就是 emoji 殘骸。');
}
