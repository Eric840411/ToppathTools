/**
 * 新手指引。
 *
 * 🚨 **為什麼不是一般的置中彈框**：這份指引講的每一句都是在講「畫面上那一塊」。
 *    置中的大彈框會把要講的東西整個蓋住，使用者只能先關掉、再自己回想剛剛寫什麼——
 *    等於把說明書搬進畫面裡而已。所以做成**角落的小卡**，每一步同時把對應的面板
 *    捲進畫面並高亮（沿用 `focusPanel`，就是 ①②③ 導引在用的那一套）。
 *
 * ⚠️ 不擋操作：沒有遮罩、不搶焦點。使用者想邊看邊點就讓他點。
 * ⚠️ 只在「這個瀏覽器沒看過」時自動出現一次；之後靠頁首那顆按鈕自己叫出來。
 *    每次都跳的話，老手會在第三次之後開始無視所有提示——包括真正重要的那些。
 */
import { useEffect, useState } from 'react'
import { focusPanel } from './focusPanel'

/** 看過了沒。改版面時把 v 往上加，就會對所有人再播一次 */
const SEEN_KEY = 'toppath:uat-guide-seen:v1'
/** 完整手冊（artifact）。這裡只放最短路徑，細節都在那一頁 */
const MANUAL_URL = 'https://claude.ai/code/artifact/94914111-23d6-420f-80f4-801134eb82ba'

export function hasSeenUatGuide() {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return true }
}

type Step = { title: string; body: string; focus?: string }

const STEPS: Step[] = [
  {
    title: '先選一條線',
    body: 'Backend 測後台、H5 測手機網頁、PC 測桌機版（Cocos 畫布）。三條線的腳本不通用——PC 沒有 DOM，選擇器類的積木在那裡一定命中 0。',
    focus: 'uat-focus-tabs',
  },
  {
    title: '挑一支現成腳本',
    body: '卡片上寫著幾顆積木、綁了幾筆 TC、上次跑的結果與時間。勾選多份就會排成佇列依序跑（一次跑一份）。',
    focus: 'uat-focus-scripts',
  },
  {
    title: '填要跑在哪裡',
    body: '右邊「執行設定」填目標網址；最上面那條狀態列決定實際在哪台機器開瀏覽器。頁面上方 ①②③ 會顯示還缺什麼——點它就會跳到該填的地方。',
    focus: 'uat-focus-url',
  },
  {
    title: '綁 Lark TC 才會回寫',
    body: '貼上 Lark 表格網址 → 掃描 → 勾選對應的 TC，每顆檢查積木都要指定屬於哪一筆。不綁也能跑，只是不回寫。',
    focus: 'uat-focus-lark',
  },
  {
    title: '自己錄一支',
    body: '「錄製新腳本」會開瀏覽器把你的操作錄成積木；要驗什麼就開面板上的「加檢查」再點它——檢查模式下不會觸發原本的操作。預約、帶入額度這類會真的造成後果的按鈕，第一下會被擋下來問你。',
    focus: 'uat-focus-scripts',
  },
  {
    title: '看懂結果',
    body: 'PASS＝這筆 TC 的檢查全過；FAIL＝有檢查掛掉；受阻＝前置條件不成立（沒測到，不是壞掉）；待確認＝一顆有效檢查都沒有（只截圖就會是這個，不是 PASS）。',
  },
]

export function OnboardingGuide({ onClose, xianxia }: { onClose: () => void; xianxia: boolean }) {
  const [index, setIndex] = useState(0)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  // 每翻一步就把對應的面板捲過來高亮；最後一步沒有對應面板就不動畫面
  useEffect(() => {
    if (step.focus) focusPanel(step.focus)
  }, [step.focus])

  // Esc 關掉。⚠️ 沒有這個的話，鍵盤使用者會被一張關不掉的卡片黏住
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') finish() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const finish = () => {
    try { localStorage.setItem(SEEN_KEY, '1') } catch { /* 無痕模式沒得存，下次再播一次也無妨 */ }
    onClose()
  }

  return (
    <aside className="uat-guide" role="dialog" aria-modal="false" aria-label={xianxia ? '入門引路' : '新手指引'}>
      <div className="uat-guide-head">
        <span>{xianxia ? '入門引路' : '新手指引'}</span>
        <button type="button" className="uat-guide-x" onClick={finish} aria-label={xianxia ? '收起引路' : '關閉指引'}>✕</button>
      </div>
      <h4>{step.title}</h4>
      <p>{step.body}</p>
      <div className="uat-guide-dots" aria-hidden="true">
        {STEPS.map((item, i) => <i key={item.title} className={i === index ? 'is-on' : ''} />)}
      </div>
      <div className="uat-guide-foot">
        <a href={MANUAL_URL} target="_blank" rel="noreferrer">{xianxia ? '完整典籍' : '完整手冊'}</a>
        <div>
          <button type="button" className="uat-btn is-quiet" disabled={!index} onClick={() => setIndex(i => i - 1)}>上一步</button>
          {last
            ? <button type="button" className="uat-btn is-primary" onClick={finish}>{xianxia ? '已然明瞭' : '我知道了'}</button>
            : <button type="button" className="uat-btn is-primary" onClick={() => setIndex(i => i + 1)}>下一步（{index + 1}/{STEPS.length}）</button>}
        </div>
      </div>
    </aside>
  )
}
