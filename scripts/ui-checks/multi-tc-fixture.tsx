import React from 'react'
import { createRoot } from 'react-dom/client'
import { MultiTcRecorder } from '../../src/features/uat/MultiTcRecorder'
import '../../src/features/uat/UatStudio.css'
const names = ['藍底：可用機器與遊戲中機器數量', '橘底：大廳玩家數量與更新', '綠底：投入、出金與投注金額', '紅底：玩家存入機台金額']
const tcs = names.map((text, i) => ({ recordId: `rec${i}`, storageKey: `tblFixture:rec${i}`, number: 'T-A-002', text,
  sub: 'Dashboard', taskType: '後台', stepCount: 0, verifierName: null, source: 'live' as const }))
// onClose 要留下痕跡，否則 Esc／關閉鈕的行為在測試裡看不出差別——元件本身不會因為
// onClose 被呼叫而改變畫面（open 是外部控制的），不計數的話「該關」與「不該關」長得一樣。
declare global { interface Window { __closeCount?: number } }
window.__closeCount = 0
createRoot(document.getElementById('root')!).render(<MultiTcRecorder open onClose={() => { window.__closeCount = (window.__closeCount || 0) + 1 }} tcs={new URLSearchParams(location.search).has('empty') ? [] : tcs}
  larkUrl="https://fixture.larksuite.com/base/appFixture?table=tblFixture" agentId={new URLSearchParams(location.search).get('mode') === 'server' ? 'server' : 'fixture-agent'} running={false}
  themeMode={new URLSearchParams(location.search).get('theme') === 'xianxia' ? 'xianxia' : 'classic'} onRun={() => {}} />)
