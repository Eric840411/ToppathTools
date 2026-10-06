/**
 * Meegle 批量工具「使用說明」（v5.14.0；使用者 2026-10-05 要求，版面：放在分頁操作下方、可收合，樣稿 mockup-meegle-guide.html 使用者確認）。
 *
 * ⚠️ 內容是照**現在的規則**寫的（shared/meegle-*-rules.ts、server/meegle-batch-store.ts、meegle-sheet-writeback.ts），
 *    規則改了這裡要跟著改。特別是：Sheet 欄名**一字不差**才認（server/routes/sheets.ts 用表頭原字當 key，不 trim）
 * ⚠️ 修仙版不用 emoji（使用者）：普通版是線條圖示（inline SVG），修仙版是 CodeX 生的圖（public/themes/xianxia/meegle-guide/），
 *    兩組都渲染、用 CSS data-theme-mode 切
 */
import { useEffect, useState, type ReactNode } from 'react'
import './MeegleGuide.css'

export type GuideTab = 'create' | 'comment' | 'status' | 'edit'
type IconName = 'sheet' | 'options' | 'writeback' | 'tip'

const OPEN_KEY = 'meegle-guide-open'
const TAB_LABEL: Record<GuideTab, string> = { create: '開單', comment: '評論', status: '狀態', edit: '修改' }

const LINE_ICON: Record<IconName, ReactNode> = {
  sheet: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 3v18" /></>,
  options: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  writeback: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16.5 9" /></>,
  tip: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" /></>,
}

function Icon({ name }: { name: IconName }) {
  return (
    <span className="mgd-ic" aria-hidden="true">
      <svg className="mgd-ic-line" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{LINE_ICON[name]}</svg>
      <img className="mgd-ic-art" src={`/themes/xianxia/meegle-guide/${name}.png`} alt="" />
    </span>
  )
}

const Sec = ({ icon, children }: { icon: IconName; children: ReactNode }) => <div className="mgd-sec"><Icon name={icon} />{children}</div>
const Req = () => <td className="mgd-req">必填</td>
const Opt = ({ text = '選填' }: { text?: string }) => <td className="mgd-opt">{text}</td>
const Writeback = ({ children }: { children: ReactNode }) => <div className="mgd-wb"><Icon name="writeback" /><div>{children}</div></div>

function CreatePane({ isAdmin }: { isAdmin: boolean }) {
  return <>
    <div className="mgd-col">
      <Sec icon="sheet">Sheet 要有哪些欄</Sec>
      <table className="mgd-table">
        <thead><tr><th>欄名</th><th /><th>用途</th></tr></thead>
        <tbody>
          <tr><td><code>摘要</code> 或 <code>標題</code></td><Req /><td>任務名稱。兩欄都空白的列不能送</td></tr>
          <tr><td><code>關聯需求</code></td><Opt /><td>填需求名稱或 ID。<b>沒填</b>就用畫面上的「整批預設需求」；<b>填了但找不到／同名多筆</b>那列會被擋，不會改用預設</td></tr>
          <tr><td><code>描述</code></td><Opt /><td>單子的描述</td></tr>
          <tr><td><code>回報者</code>／<code>回報人</code>／<code>填寫人</code></td><Opt /><td>回報者（有其中一個欄名就好）</td></tr>
          <tr><td><code>RD負責人</code>／<code>RD</code></td><Opt /><td>RD 負責人</td></tr>
          <tr><td><code>QA驗證人員</code></td><Opt /><td>QA 驗證，可以多個人</td></tr>
        </tbody>
      </table>
      <ul className="mgd-list">
        <li>人名寫暱稱就好（Dean、zen），一格多人用<b>逗號、頓號或換行</b>分開。第一次出現的名字要在②「人員對照」配一次，之後會記住</li>
        <li><b>受托人、Code Review</b> Sheet 沒有欄位：在①選整批預設，③可以逐列改</li>
        <li>「進度」欄不會被讀（不等於 Meegle 狀態）</li>
      </ul>
    </div>
    <div className="mgd-col">
      <Sec icon="options">畫面上的選項會怎樣</Sec>
      <ul className="mgd-list">
        <li><b>整批預設需求</b>：Sheet「關聯需求」空白的列用它</li>
        <li><b>開單後推到</b>：選了就開完單接著推到那個狀態；<b>不選＝不推</b>，停在初始狀態</li>
        {isAdmin && <li><b>Meegle 空間</b>（只有管理員看得到）：測試或正式。正式送出前會再確認一次；同一份 Sheet 只能用一個空間</li>}
        <li>③ 預覽：之前開過的列標「已開過」不會重開；被擋的列寫出原因</li>
      </ul>
      <div className="mgd-sub">範例</div>
      <div className="mgd-scroll">
        <table className="mgd-table">
          <thead><tr><th>摘要</th><th>關聯需求</th><th>回報者</th><th>RD</th><th>QA驗證人員</th></tr></thead>
          <tbody>
            <tr><td>[OSM] 彈窗按鈕改為 Confirm</td><td>OSM 10 月版本</td><td>Dean</td><td>zen</td><td>Tim, Siara</td></tr>
            <tr><td>[OSM] 匯出報表欄位錯位</td><td className="mgd-opt">（空白→用預設）</td><td>Dean</td><td>James Chang</td><td>Tim</td></tr>
          </tbody>
        </table>
      </div>
      <Writeback><b>開完會寫回 Sheet</b>：<code>Meegle 單號</code>（#單號，可點連結）、<code>處理階段</code>（已開單（Meegle）・已推到 X）、<code>處理時間</code>。欄位不存在會自動加在最右邊</Writeback>
    </div>
  </>
}

function CommentPane() {
  return <>
    <div className="mgd-col">
      <Sec icon="sheet">Sheet 要有哪些欄</Sec>
      <table className="mgd-table">
        <thead><tr><th>欄名</th><th /><th>用途</th></tr></thead>
        <tbody>
          <tr><td><code>Meegle 單號</code></td><Req /><td>格子第一個字要是 <code>#數字</code>（開單會自動回填這欄）。沒有單號的列不送</td></tr>
          <tr><td>評論內容欄</td><Req /><td>②選哪一欄當評論內容（例如「備註」）</td></tr>
          <tr><td>附件欄</td><Opt /><td>欄名有「附件」或「截圖」會自動選上；圖片進測試說明、影片各一則評論</td></tr>
          <tr><td>填寫人欄</td><Opt /><td>用那個人的身分送（要對方綁定 Meegle、你有代理授權）；沒有就用你自己</td></tr>
          <tr><td><code>處理階段</code></td><Opt /><td>空白或「已開單…」的列預設勾選</td></tr>
        </tbody>
      </table>
    </div>
    <div className="mgd-col">
      <Sec icon="options">畫面上的選項會怎樣</Sec>
      <ul className="mgd-list">
        <li><b>AI 整理測試說明／AI 完整性分析</b>（有權限才看得到）：在③預覽時就跑完，你可以改；送出不會再跑一次</li>
        <li>測試說明會<b>整格覆寫</b>。Meegle 上被人改過，③會標出來要你確認</li>
      </ul>
      <Writeback><b>送完寫回</b>：<code>處理階段</code>＝添加評論、<code>處理時間</code></Writeback>
    </div>
  </>
}

function StatusPane() {
  return <>
    <div className="mgd-col">
      <Sec icon="sheet">Sheet 要有哪些欄</Sec>
      <table className="mgd-table">
        <thead><tr><th>欄名</th><th /><th>用途</th></tr></thead>
        <tbody>
          <tr><td><code>Meegle 單號</code></td><Req /><td>同評論</td></tr>
          <tr><td><code>目標狀態</code></td><Opt /><td>填狀態名稱（要完全一樣）。空白就用整批預設</td></tr>
          <tr><td>日期欄</td><Opt /><td>選「指定日期」時才用；空白的列保留原值</td></tr>
        </tbody>
      </table>
    </div>
    <div className="mgd-col">
      <Sec icon="options">畫面上的選項會怎樣</Sec>
      <ul className="mgd-list">
        <li><b>目標狀態</b>：③手改 ＞ Sheet「目標狀態」 ＞ 整批預設；找不到或同名多個那列會被擋</li>
        <li><b>日期</b>：保留原值（預設）／用自動帶入（轉狀態時 Meegle 自動填今天）／指定日期</li>
        <li>「處理階段」已經是「已切換狀態」的列預設不勾</li>
      </ul>
      <Writeback><b>送完寫回</b>：<code>處理階段</code>＝已切換狀態、<code>處理時間</code></Writeback>
    </div>
  </>
}

function EditPane() {
  return <>
    <div className="mgd-col">
      <Sec icon="sheet">Sheet 要有哪些欄</Sec>
      <table className="mgd-table">
        <thead><tr><th>欄名</th><th /><th>用途</th></tr></thead>
        <tbody>
          <tr><td><code>Meegle 單號</code></td><Req /><td>同評論</td></tr>
          <tr><td>要改的欄位</td><Opt text="自選" /><td>②每個 Meegle 欄位各自選：不修改／讀 Sheet 某一欄／固定值／明確清空</td></tr>
        </tbody>
      </table>
    </div>
    <div className="mgd-col">
      <Sec icon="options">畫面上的選項會怎樣</Sec>
      <ul className="mgd-list">
        <li>選「Sheet 欄」時，<b>那格空白＝不改</b>（不是清空）；要清空請選「明確清空」</li>
        <li>可以改：任務名稱、描述（可附圖）、優先順序、受托人／RD／回報者／Code Review／QA、嚴重性、QA測試難易度、退件、三個日期、開發說明、Gitlab 連結</li>
        <li>③會列出每欄「原值 → 新值」，送出前後端會再算一次，對不上就要重新預覽</li>
      </ul>
      <Writeback><b>送完寫回</b>：<code>處理階段</code>＝已修改欄位、<code>處理時間</code></Writeback>
    </div>
  </>
}

/** 放在分頁操作的下方。第一次進來展開，之後記住收起來沒；說明分頁跟著目前的工具分頁走 */
export function MeegleGuide({ tab, isAdmin }: { tab: GuideTab; isAdmin: boolean }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== '0' } catch { return true } })
  const [shown, setShown] = useState<GuideTab>(tab)
  useEffect(() => { setShown(tab) }, [tab])
  const toggle = () => setOpen(o => { try { localStorage.setItem(OPEN_KEY, o ? '0' : '1') } catch { /* 記不住就算了 */ } return !o })

  return (
    <section className={`mgd${open ? '' : ' mgd--closed'}`} aria-label="Meegle 批量工具使用說明">
      <div className="mgd-head">
        <h3 className="mgd-title">使用說明</h3>
        <button type="button" className="mb-btn" onClick={toggle} aria-expanded={open}>{open ? '收起 ▲' : '展開 ▼'}</button>
      </div>
      {open && <>
        <p className="mgd-lead">說明會跟著你目前所在的分頁切換。<b>Sheet 欄名要跟下面寫的一字不差</b>（前後多一個空白也對不到）。</p>
        <div className="mgd-tabs" role="tablist">
          {(Object.keys(TAB_LABEL) as GuideTab[]).map(k => (
            <button key={k} type="button" role="tab" aria-selected={shown === k} className={`mgd-tab${shown === k ? ' is-on' : ''}`} onClick={() => setShown(k)}>{TAB_LABEL[k]}</button>
          ))}
        </div>
        <div className="mgd-pane" role="tabpanel">
          {shown === 'create' && <CreatePane isAdmin={isAdmin} />}
          {shown === 'comment' && <CommentPane />}
          {shown === 'status' && <StatusPane />}
          {shown === 'edit' && <EditPane />}
        </div>
        <div className="mgd-tip"><Icon name="tip" /><div>Sheet 讀完之後，被擋的列會寫出原因（缺什麼欄、哪個值對不上），照著補 Sheet 再按「重新讀取 Sheet」就好</div></div>
      </>}
    </section>
  )
}
