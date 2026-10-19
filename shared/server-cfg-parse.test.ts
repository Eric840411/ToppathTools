/**
 * parseServerCfgSource 的回歸。跑法：npx tsx shared/server-cfg-parse.test.ts
 * 重點：攻擊用的寫法一律丟錯、正常設定檔解析結果跟原本 vm 執行一致。
 */
import vm from 'node:vm'
import { parseServerCfgSource, ServerCfgParseError } from './server-cfg-parse.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fails.push(`${name}${detail ? ': ' + detail : ''}`)
}
function rejects(name: string, src: string) {
  try { parseServerCfgSource(src); fails.push(`${name}: 沒有丟錯`) }
  catch (e) { ok(name, e instanceof ServerCfgParseError, String(e)) }
}
function sameAsVm(name: string, src: string) {
  const ctx = vm.createContext({ window: {} as Record<string, unknown> })
  vm.runInContext(src, ctx)
  const want = JSON.stringify((ctx as { window: Record<string, unknown> }).window._ServerCfg)
  let got = ''
  try { got = JSON.stringify(parseServerCfgSource(src)) } catch (e) { got = String(e) }
  ok(name, got === want, `got ${got} want ${want}`)
}

sameAsVm('實際 osmplay 格式', 'window._ServerCfg = {\n  gate: "wss://gate.osmplay.com",\n  debug: false,\n  apiDebug: false,\n}')
sameAsVm('最小', 'window._ServerCfg = { debug: false };')
sameAsVm('典型多欄位', `
  // comment
  window._ServerCfg = {
    debug: false,
    'serverUrl': "wss://gate.example.com:443",
    ports: [3010, 3011,],
    ratio: -0.5,
    timeout: 60 * 1000,
    name: \`osm\`,
    nested: { a: null, b: true, c: "x" + "y" },
  };`)
sameAsVm('頂層變數', 'var host = "https://a.example.com"; var cfg = { host: host, api: host + "/api" }; window._ServerCfg = cfg;')
sameAsVm('沒有 window 前綴', 'var _ServerCfg = { a: 1 }; window._ServerCfg = _ServerCfg;')
sameAsVm('簡寫屬性', 'var debug = true; window._ServerCfg = { debug };')

rejects('constructor 逃逸', "window._ServerCfg = { x: this.constructor.constructor('return process')() };")
rejects('IIFE', 'window._ServerCfg = (function(){ return { a: 1 } })();')
rejects('函式呼叫', "window._ServerCfg = { a: require('child_process').execSync('whoami').toString() };")
rejects('方法', 'window._ServerCfg = { get a() { return 1 } };')
rejects('內插樣板', 'var p = 1; window._ServerCfg = { a: `${p}` };')
rejects('getter 定義', "Object.defineProperty(window, '_ServerCfg', { get(){ return process } });")
rejects('__proto__', 'window._ServerCfg = { "__proto__": { polluted: true } };')
rejects('展開', 'var b = {}; window._ServerCfg = { ...b };')
rejects('沒有賦值', 'var x = 1;')
rejects('語法錯誤', 'window._ServerCfg = { a: ')
rejects('未知變數', 'window._ServerCfg = { a: process };')
rejects('自我引用', 'var a = a; window._ServerCfg = { a: a };')

ok('沒有污染原型', ({} as Record<string, unknown>).polluted === undefined)

console.log(`server-cfg-parse: ${pass} pass, ${fails.length} fail`)
if (fails.length) { for (const f of fails) console.log('  FAIL', f); process.exit(1) }
