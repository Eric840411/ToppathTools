/**
 * server/uat-runner/pc-node-hittest.js
 *
 * **座標 → Cocos 節點**的反查，以及反過來的「識別字 → 節點」解析。**只有這一份。**
 *
 * ## 為什麼需要
 * PC 版整個畫面是一張 canvas，錄製器原本只能錄 `click_viewport` 座標。座標腳本的問題
 * 不是「不能跑」，是**跑起來不會錯**：視窗尺寸一變、清單捲過、彈窗擋住，點擊照樣送出去，
 * 只是點在別的東西上——畫面沒有任何異狀，報告全綠。（`pcClickNode` 那段註解講的就是
 * 這件事：Cocos 上的誤點是最難查的錯。）
 *
 * ## 為什麼要合成一份
 * 反查要在**兩個地方**跑：錄製器（注入頁面、純字串）與執行引擎（page.evaluate）。
 * 這個檔案開頭那條「只要有兩份就會漂」的教訓在 frontend-engine 已經發生過三次，
 * 所以這裡把規則寫成**一份原始碼字串**，兩邊都注入同一份。
 *
 * ⚠️ **這段字串裡不能有反引號（`）與 ${}**：錄製器是把它包進樣板字串注入頁面的，
 *    反引號會把字串切斷——而且 `node --check` 照樣過，是無聲的破壞。
 *
 * ## 規則
 * ① 每個可見節點換算成畫面矩形（要拿得到尺寸，拿不到就放棄那顆，不猜）
 * ② 包含該點、**最深**的那顆＝使用者真正點到的東西（最外層 Canvas 也包含所有點）
 * ③ 識別字優先用**唯一的節點名**；重名（實測大廳裡 `content` 有 22 個）就往上找
 *    第一個唯一的祖先，組成 `祖先>子>孫` 的路徑
 * ④ **連路徑都不唯一就回 null**——呼叫端要退回座標，不可以硬給一個會點錯的名字
 */

/** 注入用的原始碼（定義 `window.__uatPcHit`）。⚠️ 不可含反引號 */
export const PC_HITTEST_SOURCE = [
  '(() => {',
  '  if (window.__uatPcHit) return;',
  '  const walk = (n, d, out) => { if (!n || d > 18) return; out.push({ n: n, d: d });',
  '    const kids = n.children || []; for (let i = 0; i < kids.length; i++) walk(kids[i], d + 1, out); };',
  '  const nodes = () => { const cc = window.cc; if (!cc || !cc.director || !cc.director.getScene) return [];',
  '    const out = []; walk(cc.director.getScene(), 0, out); return out; };',
  '  const visible = (n) => n && n.activeInHierarchy !== false && !!n.worldPosition;',
  '  const labelOf = (n) => { const cs = n.components || [];',
  '    for (let i = 0; i < cs.length; i++) { const s = cs[i] && cs[i].string;',
  '      if (typeof s === "string" && s.trim()) return s.trim(); } return ""; };',
  '  /* 畫面矩形。尺寸在某個 component 上（UITransform 之類），欄位名不保證，所以用特徵找 */',
  '  const rectOf = (n) => {',
  '    const canvas = document.querySelector("canvas"); const cc = window.cc;',
  '    if (!canvas || !cc || !n.worldPosition) return null;',
  '    const r = canvas.getBoundingClientRect();',
  '    const vis = (cc.view && cc.view.getVisibleSize) ? cc.view.getVisibleSize() : { width: r.width, height: r.height };',
  '    const sx = r.width / vis.width, sy = r.height / vis.height;',
  '    let w = 0, h = 0, ax = 0.5, ay = 0.5; const cs = n.components || [];',
  '    for (let i = 0; i < cs.length; i++) { const c = cs[i];',
  '      if (c && typeof c.width === "number" && typeof c.height === "number" && (c.width || c.height)) {',
  '        w = c.width; h = c.height;',
  '        if (typeof c.anchorX === "number") ax = c.anchorX;',
  '        if (typeof c.anchorY === "number") ay = c.anchorY; break; } }',
  '    if (!w && !h) return null;',
  '    const sc = n.worldScale || { x: 1, y: 1 };',
  '    const ww = w * (sc.x == null ? 1 : sc.x), hh = h * (sc.y == null ? 1 : sc.y);',
  '    const wp = n.worldPosition;',
  '    return { left: r.left + (wp.x - ax * ww) * sx, right: r.left + (wp.x + (1 - ax) * ww) * sx,',
  '             top: r.top + r.height - (wp.y + (1 - ay) * hh) * sy,',
  '             bottom: r.top + r.height - (wp.y - ay * hh) * sy,',
  '             cx: r.left + (wp.x + (0.5 - ax) * ww) * sx,',
  '             cy: r.top + r.height - (wp.y + (0.5 - ay) * hh) * sy }; };',
  '  const nameOf = (n) => String((n && n.name) || "");',
  '  /* 這個名字在可見樹裡有幾顆 */',
  '  const countName = (list, name) => { let k = 0;',
  '    for (let i = 0; i < list.length; i++) if (visible(list[i].n) && nameOf(list[i].n) === name) k++; return k; };',
  '  /* 節點 -> 識別字：唯一的名字就用名字，否則往上接到第一個唯一的祖先 */',
  '  const idOf = (list, node) => {',
  '    const parts = []; let cur = node;',
  '    for (let step = 0; step < 8 && cur; step++) {',
  '      const nm = nameOf(cur); if (!nm) return null;',
  '      parts.unshift(nm);',
  '      if (countName(list, nm) === 1) return parts.join(">");',
  '      cur = cur.parent;',
  '    }',
  '    return null; };',
  '  /* 識別字 -> 節點。路徑要求：第一段在可見樹裡唯一，其後逐層比子節點名字 */',
  '  const resolve = (id) => {',
  '    const list = nodes(); if (!list.length) return null;',
  '    const parts = String(id || "").split(">").map(s => s.trim()).filter(Boolean);',
  '    if (!parts.length) return null;',
  '    let roots = list.filter(x => visible(x.n) && nameOf(x.n) === parts[0]);',
  '    if (roots.length !== 1) return null;',
  '    let cur = roots[0].n;',
  '    for (let i = 1; i < parts.length; i++) {',
  '      const kids = (cur.children || []).filter(k => visible(k) && nameOf(k) === parts[i]);',
  '      if (kids.length !== 1) return null;',
  '      cur = kids[0]; }',
  '    return cur; };',
  '  window.__uatPcHit = {',
  '    /* 座標 -> { id, name, label, depth, ambiguous } */',
  '    at: (x, y) => {',
  '      const list = nodes(); if (!list.length) return null;',
  '      const hits = [];',
  '      for (let i = 0; i < list.length; i++) { const n = list[i].n; if (!visible(n)) continue;',
  '        const r = rectOf(n); if (!r) continue;',
  '        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hits.push({ n: n, d: list[i].d, r: r }); }',
  '      if (!hits.length) return null;',
  '      hits.sort((a, b) => b.d - a.d);',
  '      const best = hits[0];',
  '      const id = idOf(list, best.n);',
  '      return { id: id, name: nameOf(best.n), label: labelOf(best.n), depth: best.d,',
  '               cx: Math.round(best.r.cx), cy: Math.round(best.r.cy),',
  '               nameUnique: countName(list, nameOf(best.n)) === 1, candidates: hits.length }; },',
  '    /* 識別字 -> 畫面座標（執行時用） */',
    /* 把節點捲進畫面。清單裡的節點位置會隨捲動改變——重播時清單停在別的位置，
       算出來的座標就在視窗外（實測 y=-93）。這時候不該失敗，該先捲過去。 */
  '    into: (id) => {',
  '      const n = resolve(id); if (!n) return { ok: false, why: "解析不到" };',
  '      const r = rectOf(n); if (!r) return { ok: false, why: "量不到大小" };',
  '      /* 往上找帶 ScrollView 的祖先（用能力認，不是用名字——名字會改） */',
  '      let sv = null, svNode = null, cur = n;',
  '      for (let i = 0; i < 10 && cur && !sv; i++) {',
  '        const cs = cur.components || [];',
  '        for (let k = 0; k < cs.length; k++) {',
  '          if (cs[k] && typeof cs[k].scrollToOffset === "function" && typeof cs[k].getMaxScrollOffset === "function") { sv = cs[k]; svNode = cur; break; } }',
  '        cur = cur.parent; }',
  '      if (!sv) return { ok: false, why: "這顆節點不在任何清單裡，捲不動" };',
  '      const svRect = rectOf(svNode); if (!svRect) return { ok: false, why: "量不到清單大小" };',
  '      const canvas = document.querySelector("canvas"); const cc = window.cc;',
  '      const cr = canvas.getBoundingClientRect();',
  '      const vis = (cc.view && cc.view.getVisibleSize) ? cc.view.getVisibleSize() : { width: cr.width, height: cr.height };',
  '      const sy = cr.height / vis.height;',
  '      const max = sv.getMaxScrollOffset();',
  '      const now = sv.getScrollOffset ? sv.getScrollOffset() : { x: 0, y: 0 };',
  '      /* 螢幕像素差 -> 內容座標差（往下捲＝offset.y 變大） */',
  '      let wantY = now.y + (r.cy - svRect.cy) / sy;',
  '      if (wantY < 0) wantY = 0; if (wantY > max.y) wantY = max.y;',
  '      sv.scrollToOffset({ x: now.x, y: wantY }, 0.25);',
  '      return { ok: true, from: Math.round(now.y), to: Math.round(wantY), max: Math.round(max.y) }; },',
    /* 節點上的文字。label 常常掛在**子節點**（按鈕底下的 tip 之類），
       所以自己沒有字就往下找，把看得到的字串起來——只看自己的話會常常回空字串。 */
  '    text: (id) => {',
  '      const n = resolve(id); if (!n) return null;',
  '      const own = labelOf(n); if (own) return own;',
  '      const out = []; const stack = [n];',
  '      while (stack.length && out.length < 6) { const cur = stack.shift();',
  '        const kids = cur.children || [];',
  '        for (let i = 0; i < kids.length; i++) { const k = kids[i];',
  '          if (!visible(k)) continue;',
  '          const t = labelOf(k); if (t) out.push(t); else stack.push(k); } }',
  '      return out.join(" "); },',
  '    find: (id) => { const n = resolve(id); if (!n) return null; const r = rectOf(n);',
  '      if (!r) return null;',
  '      return { name: nameOf(n), label: labelOf(n), x: Math.round(r.cx), y: Math.round(r.cy),',
  '               inViewport: r.cx >= 0 && r.cx <= window.innerWidth && r.cy >= 0 && r.cy <= window.innerHeight }; },',
  '  };',
  '})();',
].join('\n');

/**
 * 在頁面上裝好反查器（同一頁重複呼叫是安全的）。
 * @param {import('playwright').Page} page
 */
export async function installPcHitTest(page) {
  await page.evaluate(PC_HITTEST_SOURCE).catch(() => {});
}

/**
 * 座標反查節點。
 * @returns {Promise<{id: string|null, name: string, label: string, depth: number, nameUnique: boolean, candidates: number}|null>}
 */
export async function pcNodeAtPoint(page, x, y) {
  await installPcHitTest(page);
  return page.evaluate(([px, py]) => window.__uatPcHit?.at(px, py) ?? null, [x, y]).catch(() => null);
}

/**
 * 識別字（節點名或 `祖先>子>孫` 路徑）→ 畫面座標。
 *
 * ⚠️ 解析不到就回 null，**不要退而求其次挑一顆像的**——那正是座標腳本的老問題。
 */
export async function pcResolveNodeId(page, id) {
  await installPcHitTest(page);
  return page.evaluate((want) => window.__uatPcHit?.find(want) ?? null, id).catch(() => null);
}

/**
 * 把節點捲進畫面（只對「在某個 ScrollView 裡」的節點有用）。
 *
 * 🚨 實測 2026-09-20：重播時清單停在跟錄製當下不同的位置，同一個識別字算出來是
 *    y = -93（在視窗上方）。**這不是找錯節點，是位置會動**——直接判失敗的話，
 *    所有清單裡的東西都變成不能重播。
 */
export async function pcScrollNodeIntoView(page, id) {
  await installPcHitTest(page);
  const r = await page.evaluate((want) => window.__uatPcHit?.into(want) ?? { ok: false, why: '反查器不在' }, id)
    .catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));
  if (r?.ok) await page.waitForTimeout(700);   // scrollToOffset 是 0.25 秒的動畫
  return r;
}

/**
 * 讀某個節點上的文字（Cocos label）。
 *
 * 🚨 **這是 PC 版「驗文字」的正解，不是 OCR。** 畫面雖然是 canvas，文字本身仍然是
 *    label 元件上的字串——直接讀比截圖辨識準（不怕字體、動畫、背景），而且零依賴。
 * ⚠️ 讀不到回 `null`，**不要回空字串**：兩者意思完全不同（找不到節點 vs 節點上沒字），
 *    混在一起的話「驗到空字串＝通過」這種錯會出現。
 */
export async function pcNodeText(page, id) {
  await installPcHitTest(page);
  return page.evaluate((want) => window.__uatPcHit?.text(want) ?? null, id).catch(() => null);
}
