/**
 * AutoSpin 續租停止時機（v5.80.1，CodeX dfe4007 P1）。跑法：node scripts/ui-checks/autospin-lease-exit.cjs
 * 主程序退出、它開的子程序還握著 stdout → close 會延後到子程序結束。只等 close 才停租，期間孤兒照樣續租。
 * agent-runner 的 sendLease 改成看 exitCode／signalCode 並在 exit 時停；這支用真程序證明兩種寫法的差別。
 */
const { spawn } = require('child_process')
const parentSrc = `const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:['ignore',1,2],detached:true});setTimeout(()=>process.exit(0),300)`
const child = spawn(process.execPath, ['-e', parentSrc])
child.stdout.on('data', () => {})
let oldLease = 0, newLease = 0, exitAt = 0, closeAt = 0
const t0 = Date.now()
let oldStop = false, newStop = false
child.on('exit', () => { exitAt = Date.now() - t0; newStop = true })
child.on('close', () => { closeAt = Date.now() - t0; oldStop = true })
const timer = setInterval(() => {
  if (!oldStop) oldLease++
  if (!newStop && child.exitCode === null && child.signalCode === null) newLease++
  if (oldStop) {
    clearInterval(timer)
    const r = { exitAt, closeAt, onlyClose: oldLease, withExit: newLease }
    console.log(JSON.stringify(r))
    // close 明顯晚於 exit 才算重現成功；看 exit 的寫法要在 exit 當下就停
    const reproduced = closeAt - exitAt > 1000
    const ok = reproduced && newLease <= Math.ceil(exitAt / 100) + 1 && oldLease > newLease + 10
    console.log(ok ? 'PASS 主程序退出就停租，不等 close' : 'FAIL ' + (reproduced ? '看 exit 的寫法沒有提早停' : '沒重現出 close 延後'))
    process.exit(ok ? 0 : 1)
  }
}, 100)
