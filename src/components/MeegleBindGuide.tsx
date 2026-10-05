/**
 * Meegle 綁定引導卡（v5.11.0，使用者看樣稿 mockup-meegle-bind-guide.html 確認；行為 CodeX 2026-10-06 同意）。
 * 開單／評論／狀態／修改四頁共用：後端回這三種 code 時取代原本那一行字。
 * - 判斷只看後端回的 code，前端不自己另外查綁定
 * - 「前往綁定」交給 App 切到個人帳號頁（Meegle 頁保持掛載，回來草稿還在）
 * - 「重新檢查」只重打那一頁的 meta：檢查中反灰防連點；成功才撤卡；網路或其他錯誤照一般錯誤顯示，不當成綁定問題
 */
import './MeegleSpace.css'
export const BIND_CODES = ['NOT_BOUND', 'BINDING_INVALID', 'DECRYPT_FAILED'] as const
export type BindCode = typeof BIND_CODES[number]
export const isBindCode = (c: unknown): c is BindCode => typeof c === 'string' && (BIND_CODES as readonly string[]).includes(c)

const TEXT: Record<BindCode, { title: string; sub: string; go: string; recheck: string }> = {
  NOT_BOUND: {
    title: '還沒綁定 Meegle',
    sub: '批量工具會用你自己的 Meegle 身分開單、評論、改狀態。綁定一次就好，大約 1 分鐘。',
    go: '前往綁定 →', recheck: '我綁好了，重新檢查',
  },
  BINDING_INVALID: {
    title: 'Meegle 綁定已失效',
    sub: '你的 Token 已經不能用了（可能在 Meegle 按過「重置 Token」）。步驟跟綁定一樣：到 Meegle 複製新的 Token、貼到個人帳號更新。',
    go: '前往更新綁定 →', recheck: '我更新好了，重新檢查',
  },
  // ⚠️ 不是 Token 過期：是本站存的資料解不開（伺服器金鑰換過等），講成過期會讓人去 Meegle 白重置一次（CodeX）
  DECRYPT_FAILED: {
    title: '綁定資料無法讀取',
    sub: '本站存的 Token 解不開（可能是伺服器設定換過），不是你的 Token 出問題。請到個人帳號重新貼一次 Token。',
    go: '前往重新綁定 →', recheck: '我重新綁好了，重新檢查',
  },
}

export function MeegleBindGuide({ code, onGoBind, onRecheck, checking }: { code: BindCode; onGoBind?: () => void; onRecheck: () => void; checking: boolean }) {
  const t = TEXT[code]
  return (
    <div className="mbg-card" role="region" aria-label={t.title}>
      <h3 className={`mbg-title${code === 'NOT_BOUND' ? '' : ' mbg-title--bad'}`}>{t.title}</h3>
      <p className="mbg-sub">{t.sub}</p>
      {code === 'NOT_BOUND' && (
        <div className="mbg-steps">
          <div className="mbg-step"><span className="mbg-step-t"><b>1</b>複製 Token</span>
            <p>在 Lark 開啟 Meegle → 首頁「MCP &amp; CLI」卡片 → MCP 設定 → <code>HTTP Header</code> 分頁 → 按「複製 Token」</p></div>
          <div className="mbg-step"><span className="mbg-step-t"><b>2</b>貼到個人帳號</span>
            <p>按下面「前往綁定」，貼上 Token 後按「綁定」。Token 會加密保存，畫面不會再顯示。</p></div>
          <div className="mbg-step"><span className="mbg-step-t"><b>3</b>回到這裡</span>
            <p>綁定成功後回到這一頁，按「我綁好了，重新檢查」就能開始用。</p></div>
        </div>
      )}
      <div className="mbg-actions">
        {onGoBind && <button type="button" className="mb-btn mb-btn--primary" onClick={onGoBind}>{t.go}</button>}
        <button type="button" className="mb-btn" disabled={checking} onClick={onRecheck}>{checking ? '檢查中…' : t.recheck}</button>
        <span className="mbg-note">Token 等同你的 Meegle 身分，不要貼到聊天室。</span>
      </div>
    </div>
  )
}
