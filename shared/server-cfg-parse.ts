/**
 * 從 serverCfg.js 的原始碼取出 `window._ServerCfg = {...}` 的物件——**只解析、不執行**。
 *
 * 原本後端用 `vm.runInContext` 直接跑抓回來的 JS、前端用 `new Function`。Node 的 vm 不是沙箱，
 * `this.constructor.constructor('return process')()` 就能拿到 process；而網址是請求帶進來的，
 * 等於任何人都能在伺服器上執行指令（資安審查 2026-10-19）。
 *
 * 做法：用 acorn 轉成語法樹，找到對 `_ServerCfg`（或 `window._ServerCfg`）的賦值，
 * 只認字面值組成的節點（物件、陣列、字串、數字、布林、null、沒有內插的樣板字串、
 * 一元正負號、字面值之間的 + - * /），以及頂層 var/let/const 宣告成字面值的變數。
 * 碰到任何其他寫法（函式呼叫、成員取值、函式……）一律丟錯並寫出是哪一種節點，
 * 不猜、不略過——略過會讓比對結果少掉欄位卻看起來正常。
 */
import { parse } from 'acorn'

type Node = { type: string; [k: string]: unknown }

export class ServerCfgParseError extends Error {}

function isServerCfgTarget(n: Node): boolean {
  if (n.type === 'Identifier') return n.name === '_ServerCfg'
  if (n.type === 'MemberExpression' && !n.computed) {
    const obj = n.object as Node
    const prop = n.property as Node
    return prop.type === 'Identifier' && prop.name === '_ServerCfg'
      && obj.type === 'Identifier' && (obj.name === 'window' || obj.name === 'globalThis' || obj.name === 'self')
  }
  return false
}

function walk(node: unknown, visit: (n: Node) => void) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return }
  const n = node as Node
  if (typeof n.type !== 'string') return
  visit(n)
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
    walk(n[k], visit)
  }
}

function evalLiteral(node: Node, vars: Map<string, Node>, depth = 0): unknown {
  if (depth > 200) throw new ServerCfgParseError('serverCfg 巢狀太深')
  switch (node.type) {
    case 'Literal': {
      if ((node as { regex?: unknown }).regex) throw new ServerCfgParseError('serverCfg 含正規表示式，不支援')
      return node.value
    }
    case 'TemplateLiteral': {
      const exprs = node.expressions as Node[]
      if (exprs.length) throw new ServerCfgParseError('serverCfg 的樣板字串含 ${} 內插，不支援')
      return (node.quasis as { value: { cooked: string } }[]).map(q => q.value.cooked).join('')
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {}
      for (const p of node.properties as Node[]) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.method) throw new ServerCfgParseError(`serverCfg 物件含不支援的成員（${p.type}）`)
        const key = p.key as Node
        let name: string
        if (!p.computed && key.type === 'Identifier') name = String(key.name)
        else if (key.type === 'Literal') name = String(key.value)
        else throw new ServerCfgParseError('serverCfg 物件含計算屬性名，不支援')
        if (name === '__proto__') throw new ServerCfgParseError('serverCfg 含 __proto__ 鍵，拒絕')
        out[name] = p.shorthand
          ? evalLiteral(key, vars, depth + 1)
          : evalLiteral(p.value as Node, vars, depth + 1)
      }
      return out
    }
    case 'ArrayExpression':
      return (node.elements as (Node | null)[]).map(e => {
        if (!e) return null
        if (e.type === 'SpreadElement') throw new ServerCfgParseError('serverCfg 陣列含展開運算，不支援')
        return evalLiteral(e, vars, depth + 1)
      })
    case 'UnaryExpression': {
      const v = evalLiteral(node.argument as Node, vars, depth + 1)
      if (node.operator === '-' && typeof v === 'number') return -v
      if (node.operator === '+' && typeof v === 'number') return v
      if (node.operator === '!') return !v
      throw new ServerCfgParseError(`serverCfg 含不支援的一元運算（${String(node.operator)}）`)
    }
    case 'BinaryExpression': {
      const l = evalLiteral(node.left as Node, vars, depth + 1)
      const r = evalLiteral(node.right as Node, vars, depth + 1)
      const op = node.operator
      if (op === '+' && (typeof l === 'string' || typeof r === 'string')) return String(l) + String(r)
      if (typeof l === 'number' && typeof r === 'number') {
        if (op === '+') return l + r
        if (op === '-') return l - r
        if (op === '*') return l * r
        if (op === '/') return l / r
      }
      throw new ServerCfgParseError(`serverCfg 含不支援的運算（${String(op)}）`)
    }
    case 'Identifier': {
      const name = String(node.name)
      if (name === 'undefined') return undefined
      if (name === 'NaN') return NaN
      if (name === 'Infinity') return Infinity
      const init = vars.get(name)
      if (!init) throw new ServerCfgParseError(`serverCfg 引用了未知的變數 ${name}`)
      vars.delete(name) // 防自我引用無限遞迴
      try { return evalLiteral(init, vars, depth + 1) } finally { vars.set(name, init) }
    }
    default:
      throw new ServerCfgParseError(`serverCfg 含不支援的語法（${node.type}），為了安全不執行`)
  }
}

/** 找不到 `_ServerCfg` 賦值或含不支援語法時丟 ServerCfgParseError。 */
export function parseServerCfgSource(source: string): Record<string, unknown> {
  let ast: unknown
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true })
  } catch (e) {
    throw new ServerCfgParseError(`serverCfg.js 語法錯誤：${(e as Error).message}`)
  }
  const vars = new Map<string, Node>()
  for (const stmt of (ast as { body: Node[] }).body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const d of stmt.declarations as Node[]) {
      const id = d.id as Node
      if (id.type === 'Identifier' && d.init) vars.set(String(id.name), d.init as Node)
    }
  }
  let found: Node | null = null
  walk(ast, n => {
    if (found) return
    if (n.type === 'AssignmentExpression' && n.operator === '=' && isServerCfgTarget(n.left as Node)) found = n.right as Node
    else if (n.type === 'VariableDeclarator' && (n.id as Node).type === 'Identifier' && (n.id as Node).name === '_ServerCfg' && n.init) found = n.init as Node
  })
  if (!found) throw new ServerCfgParseError('找不到 window._ServerCfg 的賦值')
  const cfg = evalLiteral(found, vars)
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new ServerCfgParseError('window._ServerCfg 不是物件')
  return cfg as Record<string, unknown>
}
