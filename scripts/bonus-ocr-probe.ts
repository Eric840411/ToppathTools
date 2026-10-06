// 特殊遊戲卡住 → OCR 判斷（1003）：用真實截圖 OCR 出來的文字測 classifyBonusText
// cd C:\machine-test-agent-claude && npx tsx scripts/bonus-ocr-probe.ts
import { classifyBonusText } from '../server/machine-test/runner.ts'
let fail = 0
const ok = (n: string, got: string, want: string) => { console.log(`${got === want ? 'OK  ' : 'FAIL'} ${n}：${got}（應為 ${want}）`); if (got !== want) fail++ }
// 1003 實拍 OCR（中央 ocr-proxy）
ok('MONEYGONG 1562 JP Bonus 等待（SPINS REMAINING）', classifyBonusText('P1,004,285.45 GRAND MONEY GONG JACKPOT 3 SPINS TOTAL BET P100.00 SPINS REMAINING 0 PAYS 188 1 SELECT A DENOMINATION Close Rules P1 P2 P5 88 Credits Long Press To Autoplay'), 'spin')
ok('JJBXGRAND 0337 選金幣（TOUCH A COIN）', classifyBonusText('JIN JI BAO XI FEATURE TOUCH A COIN TO REVEAL A FU BABY SYMBOL. MATCH 3 FU BABY SYMBOLS TO AWARD A JACKPOT OR BONUS. PRESS PLAY TO AUTOPLAY TOUCH'), 'touch')
ok('JJBXGRAND 0337 選完金幣進 FREE GAMES', classifyBonusText('JIN JI BAO XI GRAND TOTAL WIN P4,230 EACH WINS P1,000 IS WILD 1 FREE GAME PLAYED ANY MAY WIN FORTUNE JACKPOT CREDIT 1999120 BET 880 4230 3 SELECT A DENOMINATION Start Feature'), 'spin')
ok('MONEYGONG 1562 Bonus 結束（YOU WIN）', classifyBonusText('MONEY GONG JACKPOT LUCKY HOUR BONUS YOU WIN P9,064.00 176 1504 1504 88 5664 128 TOTAL BET 188 WIN 0 BALANCE ROAD RESERVE Cash Out'), 'wait')
// 規則邊界
ok('選面額選單不算 bonus 指示', classifyBonusText('CHOOSE YOUR DENOMINATION P1 P2 P5'), 'unknown')
ok('AUTOPICK 不算要點觸屏（按 PLAY 會自動選）', classifyBonusText('PRESS PLAY TO AUTOPICK'), 'spin')
ok('PICK A CARD → touch', classifyBonusText('PICK A CARD TO WIN'), 'touch')
ok('讀不到字 → unknown（不亂按）', classifyBonusText(''), 'unknown')
ok('看不懂的字 → unknown', classifyBonusText('GRAND MAJOR MINOR MINI'), 'unknown')
console.log(fail ? `\n${fail} 個案例失敗` : '\n全部通過'); process.exit(fail ? 1 : 0)
