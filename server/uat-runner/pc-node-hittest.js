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
  /* 1008 路徑的同名兄弟序號（claude-osm-2 T-A-002：more_ScrollView>view>content 底下 8 個都叫 item1；CodeX 定案）：
     一段寫成 name[N]＝同一個父節點底下、visible() 且同名的子節點，照 children 順序的第 N 個（從 0 算）。
     不寫 [N] 照舊必須唯一；第一段不准帶 [N]（沒有父節點可以算序號）；N 只能是 0 以上的整數，越界／負數／小數一律解析不到。
     名字本身含 [ 的寫成 [[（例：a[0] 這個名字寫成 a[[0]）。[N] 只代表「目前符合條件的第幾個」，不保證是畫面上由上到下第 N 個，
     虛擬清單會重用節點——要操作特定資料，點之前先驗文字 */
  '  const escSeg = (s) => s.split("[").join("[[");',
  '  const unescSeg = (s) => s.split("[[").join("[");',
  '  const parseSeg = (seg) => { const e = seg.length - 1;',
  '    if (seg.charAt(e) !== "]") return { name: unescSeg(seg), idx: -1 };',
  '    const o = seg.lastIndexOf("["); if (o < 0) return { name: unescSeg(seg), idx: -1 };',
  /* CodeX 96797d3 [P2]：用「連續 [ 的個數」奇偶判斷——偶數＝都是跳脫的 [[，奇數＝最後那個是序號的開頭（名字叫 tail[ 時是 tail[[[1]） */
  '    let k = 0; while (o - k >= 0 && seg.charAt(o - k) === "[") k++;',
  '    if (k % 2 === 0) return { name: unescSeg(seg), idx: -1 };',
  '    const num = seg.slice(o + 1, e); if (!/^[0-9]+$/.test(num)) return null;',
  '    return { name: unescSeg(seg.slice(0, o)), idx: Number(num) }; };',
  '  /* 節點 -> 識別字：唯一的名字就用名字，否則往上接到第一個唯一的祖先；同名兄弟加 [N]。產出後一定反解一次，回到同一顆才用 */',
  '  const idOf = (list, node) => {',
  '    const parts = []; let cur = node;',
  '    for (let step = 0; step < 12 && cur; step++) {',
  '      const nm = nameOf(cur); if (!nm) return null;',
  '      if (countName(list, nm) === 1) { parts.unshift(escSeg(nm)); const id = parts.join(">"); return resolve(id) === node ? id : null; }',
  '      const par = cur.parent; if (!par) return null;',
  '      const sibs = (par.children || []).filter(k => visible(k) && nameOf(k) === nm);',
  '      const i = sibs.indexOf(cur); if (i < 0) return null;',
  '      parts.unshift(escSeg(nm) + (sibs.length > 1 ? "[" + i + "]" : ""));',
  '      cur = par;',
  '    }',
  '    return null; };',
  '  /* 識別字 -> 節點。路徑要求：第一段在可見樹裡唯一（不准帶 [N]），其後逐層比子節點名字（可帶 [N]） */',
  '  const resolve = (id) => {',
  '    const list = nodes(); if (!list.length) return null;',
  '    const parts = String(id || "").split(">").map(s => s.trim()).filter(Boolean);',
  '    if (!parts.length) return null;',
  '    const p0 = parseSeg(parts[0]); if (!p0 || p0.idx >= 0) return null;',
  '    let roots = list.filter(x => visible(x.n) && nameOf(x.n) === p0.name);',
  '    if (roots.length !== 1) return null;',
  '    let cur = roots[0].n;',
  '    for (let i = 1; i < parts.length; i++) {',
  '      const ps = parseSeg(parts[i]); if (!ps) return null;',
  '      const kids = (cur.children || []).filter(k => visible(k) && nameOf(k) === ps.name);',
  '      if (ps.idx >= 0) { if (ps.idx >= kids.length) return null; cur = kids[ps.idx]; continue; }',
  '      if (kids.length !== 1) return null;',
  '      cur = kids[0]; }',
  '    return cur; };',
  /* 1008 assert_pc_node 必須在畫面內（CodeX）：名稱與路徑兩種識別字都要能用；名稱找法跟 pcFindNode 一樣（先比名字、再比標籤） */
  '  const resolveAny = (id) => { const want = String(id || "").trim(); if (!want) return null;',
  '    if (want.indexOf(">") >= 0) return resolve(want);',
  /* CodeX 96797d3 [P2]：錄製器會把名字含 [ 的唯一節點錄成 x[[0]（沒有 >）——含 [ 的先照路徑解析，解不到再退回名稱／標籤 */
  '    if (want.indexOf("[") >= 0) { const viaPath = resolve(want); if (viaPath) return viaPath; }',
  '    const list = nodes(); let hit = null;',
  '    for (let i = 0; i < list.length && !hit; i++) if (visible(list[i].n) && nameOf(list[i].n) === want) hit = list[i].n;',
  '    for (let i = 0; i < list.length && !hit; i++) if (visible(list[i].n) && labelOf(list[i].n) === want) hit = list[i].n;',
  '    return hit; };',
  /* 遮罩：祖先上的 Mask 元件（用類別名認），以及 ScrollView 的可視區（content 的父節點）。
     要通過**所有**祖先遮罩、也要在視窗內；有遮罩卻量不到範圍 → measurable:false，不能退回只看視窗 */
  '  const classOf = (c) => { const cc = window.cc; try { if (cc && cc.js && cc.js.getClassName) { const k = cc.js.getClassName(c); if (k) return String(k); } } catch (e) {}',
  '    return String((c && (c.__classname__ || (c.constructor && c.constructor.name))) || ""); };',
  '  const clipsOf = (n) => { const out = []; let cur = n.parent;',
  '    for (let i = 0; i < 40 && cur; i++) { const cs = cur.components || [];',
  '      for (let k = 0; k < cs.length; k++) { const c = cs[k]; if (!c) continue;',
  '        if (/(^|\\.)Mask$/.test(classOf(c))) out.push({ node: cur, why: "Mask " + nameOf(cur) });',
  '        if (typeof c.scrollToOffset === "function") out.push({ node: (c.content && c.content.parent) || null, why: "ScrollView " + nameOf(cur) }); }',
  '      cur = cur.parent; }',
  '    return out; };',
  /* 1008：判「在不在畫面內」只有這一份——assert_pc_node 用識別字、pc_enter_machine 挑卡片時直接給節點，都走 seenNode */
  '  const seenNode = (n) => { if (!n) return { found: false };',
  '    const r = rectOf(n); if (!r) return { found: true, measurable: false, why: "量不到節點大小" };',
  '    const inWindow = r.cx >= 0 && r.cx <= window.innerWidth && r.cy >= 0 && r.cy <= window.innerHeight;',
  '    const clips = clipsOf(n); const outside = [];',
  /* CodeX e0bb3f3 [P2]：ScrollView 認得出來、可視區卻取不到（content／parent 讀不到）→ 一樣算量不到，不能略過 */
  '    for (let i = 0; i < clips.length; i++) { const m = clips[i].node ? rectOf(clips[i].node) : null;',
  '      if (!m) return { found: true, measurable: false, why: "量不到遮罩範圍（" + clips[i].why + "）", cx: Math.round(r.cx), cy: Math.round(r.cy) };',
  '      if (!(r.cx >= m.left && r.cx <= m.right && r.cy >= m.top && r.cy <= m.bottom)) outside.push(clips[i].why + " 可視範圍 x" + Math.round(m.left) + "~" + Math.round(m.right) + " y" + Math.round(m.top) + "~" + Math.round(m.bottom)); }',
  '    return { found: true, measurable: true, name: nameOf(n), cx: Math.round(r.cx), cy: Math.round(r.cy), rx: r.cx, ry: r.cy, inWindow: inWindow,',
  '             clips: clips.length, outside: outside, visible: inWindow && outside.length === 0 }; };',
  '  const seenImpl = (id) => seenNode(resolveAny(id));',
  /* 1008：捲動也只有一份——識別字（into）與節點（intoNode，pc_enter_machine 用卡片節點）共用 */
  '  const intoNode = (n) => {',
  '      if (!n) return { ok: false, why: "解析不到" };',
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
  '      return { ok: true, from: Math.round(now.y), to: Math.round(wantY), max: Math.round(max.y) }; };',
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
  '    into: (id) => intoNode(resolve(id)),',
  '    seenNode: (n) => seenNode(n),',
  '    intoNode: (n) => intoNode(n),',
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
  '    seen: (id) => seenImpl(id),',
  /* 1008：識別字 -> 節點本身（關彈窗時要避開「目標所在的那一塊」，跟找節點用同一份解析） */
  '    node: (id) => resolveAny(id),',
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
export { installPcHitTest as pcInstallHitTest };
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
export async function pcNodeVisibility(page, id) {
  await installPcHitTest(page);
  return page.evaluate((want) => window.__uatPcHit?.seen ? window.__uatPcHit.seen(want) : null, id).catch(() => null);
}

/**
 * 讀某個節點上的文字（Cocos label）—— 見下方。
 */
export async function pcNodeText(page, id) {
  await installPcHitTest(page);
  return page.evaluate((want) => window.__uatPcHit?.text(want) ?? null, id).catch(() => null);
}
