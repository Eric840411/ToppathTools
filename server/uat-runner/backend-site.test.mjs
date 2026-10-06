/**
 * 後台跨站（open_page 的 site，2026-10-06 TC T-A-004「CP 只有 OSM、NC 有 OSM＋GCP」）的行為測試。
 * 規則是跟 CodeX 定案的 (a)～(d)，驗收至少要涵蓋：CP→NC→CP、缺帳密、登入過期、網路紀錄串站。
 *
 * 瀏覽器用假的：每個 origin 各自記登入狀態（跟真的 cookie 一樣分 origin），沒登入就導到 /login。
 * 跑法：node server/uat-runner/backend-site.test.mjs
 */
import {
  runSteps, BLOCK_DEFS, stepSiteOf, resolveSiteTarget, sitesUsedBySteps, checkOpenPageSites, missingSiteCreds, openSitePage, sitePreflightError, credsForSite,
} from './block-engine.js';
import { validateMultiTcScript } from './multi-tc.js';
import { attachNetworkCapture } from './net-capture.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (extra !== undefined) console.log('        ', JSON.stringify(extra)); }
}
async function throwsMsg(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

const SITE_URLS = { cp: 'http://uat-cp.osmslot.org', nc: 'http://uat-nc.osmslot.org' };
const CP = 'http://uat-cp.osmslot.org', NC = 'http://uat-nc.osmslot.org';

// ── 積木定義：前端表單照這份長，空字串要有自己的顯示字 ─────────────────
{
  const p = BLOCK_DEFS.open_page.params.find(x => x.key === 'site');
  check('open_page 有 site 參數（cp／nc／不填）', p && p.type === 'select' && p.options.join('|') === '|cp|nc' && p.emptyLabel === '依執行設定', p);
}

// ── (c) 站台怎麼決定：寫明優先，沒寫一律用執行預設、不沿用上一步 ─────────────
{
  const d = { defaultSite: 'cp', siteUrls: SITE_URLS };
  check('沒寫 site → 執行預設站台', JSON.stringify(resolveSiteTarget('/egm', '', d)) === JSON.stringify({ site: 'cp', url: `${CP}/egm` }));
  check('寫 nc → 去 NC', JSON.stringify(resolveSiteTarget('/egm', 'nc', d)) === JSON.stringify({ site: 'nc', url: `${NC}/egm` }));
  check('大小寫不拘（NC）', resolveSiteTarget('/egm', 'NC', d).site === 'nc');
  check('執行預設是 NC、步驟寫 cp → 去 CP（寫明的優先）', resolveSiteTarget('/egm', 'cp', { ...d, defaultSite: 'nc' }).url === `${CP}/egm`);
  check('不認得的站台 → 丟錯', /不認得/.test(await throwsMsg(() => resolveSiteTarget('/egm', 'np', d)) ?? ''));
  check('寫 cp 卻給 NC 的完整網址 → 拒絕（帳密會送錯站）', /衝突/.test(await throwsMsg(() => resolveSiteTarget(`${NC}/egm`, 'cp', d)) ?? ''));
  check('寫 nc、完整網址也是 NC → 放行', resolveSiteTarget(`${NC}/egm`, 'nc', d).url === `${NC}/egm`);
  check('沒寫 site 的完整網址 → 照舊直接開，站台由網址判斷', resolveSiteTarget(`${NC}/x`, '', d).site === 'nc');
  check('站台網址缺（舊派工）→ 丟錯講清楚', /沒有 NC 站台的網址/.test(await throwsMsg(() => resolveSiteTarget('/egm', 'nc', { defaultSite: 'cp', siteUrls: { cp: CP } })) ?? ''));
  check('stepSiteOf：空／undefined＝沒寫，亂寫＝null', stepSiteOf({}) === '' && stepSiteOf({ site: '' }) === '' && stepSiteOf({ site: 'x' }) === null);
}

// ── 存檔檢查（存檔端與 runner 共用） ───────────────────────────────
{
  const ok = [{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'click', selector: 'x' }, { action: 'open_page', path: '/b', site: 'nc' }];
  check('全部寫明 → 沒錯誤', checkOpenPageSites(ok).length === 0, checkOpenPageSites(ok));
  check('舊腳本（沒有任何 site）→ 沒錯誤', checkOpenPageSites([{ action: 'open_page', path: '/a' }, { action: 'open_page', path: '/b' }]).length === 0);
  const mixed = checkOpenPageSites([{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'open_page', path: '/b' }]);
  check('跨站腳本有一顆沒寫 → 擋，並指出第幾步', mixed.length === 1 && /第 2 步/.test(mixed[0]), mixed);
  check('停用的開頁不算', checkOpenPageSites([{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'open_page', path: '/b', disabled: true }]).length === 0);
  check('寫 site 又用完整網址 → 擋', /相對路徑/.test(checkOpenPageSites([{ action: 'open_page', path: `${NC}/a`, site: 'nc' }]).join('')));
  check('site 亂寫 → 擋', /不認得/.test(checkOpenPageSites([{ action: 'open_page', path: '/a', site: 'np' }]).join('')));
  const nested = checkOpenPageSites([{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'group', steps: [{ action: 'open_page', path: '/b' }] }]);
  check('巢狀步驟也檢查', nested.length === 1 && /裡的第 1 步/.test(nested[0]), nested);
  // 多 TC 腳本的存檔驗證有接上（後台引擎才檢查）
  const script = { tableId: 't', bindings: [{ recordId: 'r1', tableId: 't' }], steps: [{ action: 'open_page', path: '/a', site: 'np', tcId: 'r1' }] };
  check('多 TC 腳本存檔驗證會擋 site 錯誤', validateMultiTcScript(script).some(e => /不認得/.test(e)), validateMultiTcScript(script));
}

// ── (b) 開跑前查齊帳密（含巢狀） ───────────────────────────────────
{
  const steps = [{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'repeat', count: 1, span: 1 }, { action: 'x', children: [{ action: 'open_page', path: '/b', site: 'nc' }] }];
  check('用到的站台＝預設＋寫明的（含巢狀）', [...sitesUsedBySteps(steps, 'cp')].sort().join(',') === 'cp,nc');
  const creds = { cp: { username: 'u', password: 'p' }, nc: { username: '', password: '' } };
  check('缺 NC 帳密 → 列出 nc', missingSiteCreds(steps, 'cp', s => creds[s]).join(',') === 'nc');
  check('沒用到 NC 就不要求 NC 帳密', missingSiteCreds([{ action: 'open_page', path: '/a' }], 'cp', s => creds[s]).length === 0);
  check('預設站台本身缺帳密也算', missingSiteCreds([], 'nc', s => creds[s]).join(',') === 'nc');
}

// ── 假瀏覽器：每個 origin 各自的登入狀態 ───────────────────────────
function fakeBrowser({ loginWorks = { cp: true, nc: true }, noPermission = [] } = {}) {
  const logged = new Set();
  let url = 'about:blank';
  const log = [];
  return {
    log, logged,
    expire(origin) { logged.delete(origin); },
    deps: {
      async goto(u) {
        const o = new URL(u).origin;
        log.push(`goto ${u}`);
        url = !logged.has(o) || noPermission.includes(u) ? `${o}/login?redirect=${encodeURIComponent(new URL(u).pathname)}` : u;
      },
      currentUrl: () => url,
      async login(site) {
        log.push(`login ${site}`);
        const o = SITE_URLS[site];
        if (loginWorks[site]) { logged.add(o); url = `${o}/dashboard`; }
      },
      async dismiss() { log.push('dismiss'); },
      async wait() {},
    },
  };
}
let clock = 1000;
const now = () => (clock += 10);

// ── (a) CP→NC→CP：只在被導到 /login 才登入，切回去不重登 ───────────────
{
  const b = fakeBrowser();
  b.logged.add(CP);   // 開跑時已經登入預設站台（CP）
  const r1 = await openSitePage(b.deps, { url: `${CP}/egm`, site: 'cp', now });
  const r2 = await openSitePage(b.deps, { url: `${NC}/egm`, site: 'nc', now });
  const r3 = await openSitePage(b.deps, { url: `${CP}/egm2`, site: 'cp', now });
  check('CP（已登入）→ 不登入', r1.relogged === false);
  check('切到 NC → 被導到登入頁才登入一次', r2.relogged === true && b.log.filter(x => x === 'login nc').length === 1);
  check('切回 CP → cookie 還在，不重登', r3.relogged === false && !b.log.includes('login cp'));
  check('NC 登入後有重開目標頁、並關站台警告', b.log.join(' | ').includes(`login nc | goto ${NC}/egm | dismiss`), b.log);
  check('回報 origin 給斷言隔離用', r1.origin === CP && r2.origin === NC && r3.origin === CP);
}
// (d) 補登時 netMark 要設在登入完成之後、重開目標頁之前
{
  const b = fakeBrowser();
  const marks = [];
  const deps = { ...b.deps, login: async (s) => { marks.push(['loginStart', clock]); await b.deps.login(s); clock += 500; marks.push(['loginEnd', clock]); } };
  const r = await openSitePage(deps, { url: `${NC}/egm`, site: 'nc', now });
  const loginEnd = marks.find(m => m[0] === 'loginEnd')[1];
  check('補登後 navMark 在登入完成之後（登入時打的 API 不算進斷言）', r.navMark > loginEnd, { navMark: r.navMark, loginEnd });
}
// 登入過期：跑到一半 NC 的 session 掉了 → 下一次開 NC 頁會再補登一次
{
  const b = fakeBrowser();
  b.logged.add(CP);
  await openSitePage(b.deps, { url: `${NC}/a`, site: 'nc', now });
  b.expire(NC);
  const r = await openSitePage(b.deps, { url: `${NC}/b`, site: 'nc', now });
  check('登入過期 → 再補登一次、成功', r.relogged === true && b.log.filter(x => x === 'login nc').length === 2);
}
// 帳密錯：送出後仍在登入頁 → 丟錯（不無限重試）
{
  const b = fakeBrowser({ loginWorks: { cp: true, nc: false } });
  const msg = await throwsMsg(() => openSitePage(b.deps, { url: `${NC}/a`, site: 'nc', now }));
  check('帳密錯 → 明確失敗、只試一次', /登入失敗/.test(msg ?? '') && b.log.filter(x => x === 'login nc').length === 1, { msg, log: b.log });
}
// 登入成功但這頁又被導回登入頁（沒權限）→ 丟錯，不再補登
{
  const b = fakeBrowser({ noPermission: [`${NC}/secret`] });
  const msg = await throwsMsg(() => openSitePage(b.deps, { url: `${NC}/secret`, site: 'nc', now }));
  check('補登後又被導回登入頁 → 失敗、最多補登一次', /又被導回登入頁/.test(msg ?? '') && b.log.filter(x => x === 'login nc').length === 1, { msg, log: b.log });
}

// ── runSteps 整合：open_page 把 site 交給 runner、斷言只看目前站台 ─────────
function siteCtx({ legacy = false } = {}) {
  const calls = [];
  const queries = [];
  let n = 0;
  return {
    calls, queries,
    page: {},
    resolveSubtypePath: () => null,
    async openPath(target, waitMs, opts) {
      calls.push({ target, site: opts?.site ?? null, argc: opts === undefined ? 2 : 3 });
      if (legacy) return undefined;   // 舊 runner：不回報任何東西
      n++;
      return { site: opts?.site ?? 'cp', origin: opts?.site === 'nc' ? NC : CP, navMark: 5000 + n, relogged: opts?.site === 'nc' && n === 2 };
    },
    netCallsSince(since, opts) {
      queries.push({ since, pageOrigin: opts?.pageOrigin ?? null });
      return [{ method: 'GET', url: 'http://api.x/egm', urlPattern: 'http://api.x/egm', status: 200 }];
    },
  };
}
{
  const ctx = siteCtx();
  const r = await runSteps([
    { action: 'open_page', path: '/egm', site: 'cp' },
    { action: 'assert_api_called', urlPattern: 'http://api.x/egm' },
    { action: 'open_page', path: '/egm', site: 'nc' },
    { action: 'assert_api_called', urlPattern: 'http://api.x/egm' },
    { action: 'open_page', path: '/egm', site: 'cp' },
    { action: 'assert_api_called', urlPattern: 'http://api.x/egm' },
  ], ctx, { autoScreenshot: false });
  check('CP→NC→CP：三步都把 site 交給 runner', ctx.calls.map(c => c.site).join(',') === 'cp,nc,cp', ctx.calls);
  check('斷言依序只看 CP／NC／CP 的請求（網路紀錄不串站）', ctx.queries.map(q => q.pageOrigin).join(',') === `${CP},${NC},${CP}`, ctx.queries);
  check('斷言界線用 runner 回報的 navMark（補登時是登入完成之後）', ctx.queries.map(q => q.since).join(',') === '5001,5002,5003', ctx.queries);
  check('補登有寫進紀錄', String(r.notes).split(/\s*\|\s*|\n/).some(x => x.includes('［NC］') && x.includes('補登')), r.notes);
  check('全部通過', r.pass === true, r.criticalFails);
}
{
  const ctx = siteCtx({ legacy: true });
  await runSteps([{ action: 'open_page', path: '/egm' }, { action: 'assert_api_called', urlPattern: 'http://api.x/egm' }], ctx, { autoScreenshot: false });
  check('沒寫 site：照舊只傳兩個參數（舊 runner 相容）', ctx.calls[0].argc === 2, ctx.calls);
  check('沒寫 site：斷言不加站台過濾（行為跟以前一樣）', ctx.queries[0].pageOrigin === null, ctx.queries);
}
{
  const ctx = siteCtx();
  ctx.openPath = async () => { throw new Error('NC 後台登入失敗（送出帳密後仍在登入頁）'); };
  const r = await runSteps([{ action: 'open_page', path: '/egm', site: 'nc' }, { action: 'assert_api_called', urlPattern: 'http://api.x/egm' }], ctx, { autoScreenshot: false });
  check('切站登入失敗 → 這一步 FAIL、預設 stop 不往下跑', r.pass === false && /登入失敗/.test(r.criticalFails.join('')) && ctx.queries.length === 0, r);
}
{
  const ctx = siteCtx();
  const r = await runSteps([{ action: 'open_page', path: '/egm', site: 'np' }], ctx, { autoScreenshot: false });
  check('site 亂寫 → 執行時也擋，而且沒開頁', r.pass === false && ctx.calls.length === 0, r.criticalFails);
}

// ── net-capture：請求標的是「發出當下頁面在哪一站」 ───────────────────
{
  const handlers = {};
  let pageUrl = `${CP}/egm`;
  const page = { on: (ev, fn) => { handlers[ev] = fn; }, off() {}, url: () => pageUrl };
  const cap = attachNetworkCapture(page);
  const req = (u) => ({ url: () => u, method: () => 'GET', resourceType: () => 'xhr', timing: () => ({ responseEnd: 10, connectStart: 1, domainLookupStart: 1 }), response: async () => ({ status: () => 200 }), redirectedFrom: () => null, failure: () => null });
  const slow = req('http://api.x/slow-from-cp');
  handlers.request(slow);              // CP 頁面發出
  pageUrl = `${NC}/egm`;               // 換到 NC
  const fresh = req('http://api.x/from-nc');
  handlers.request(fresh);
  await handlers.requestfinished(fresh);
  await handlers.requestfinished(slow); // CP 那筆比較晚回來
  const recs = cap.records();
  const byUrl = Object.fromEntries(recs.map(r => [r.url, r]));
  check('晚回來的 CP 請求仍標成 CP（完成時頁面已在 NC）', byUrl['http://api.x/slow-from-cp']?.pageOrigin === CP, recs);
  check('NC 頁面發出的標成 NC', byUrl['http://api.x/from-nc']?.pageOrigin === NC, recs);
  check('有記發出時間', typeof byUrl['http://api.x/from-nc']?.requestedAt === 'number');
}

// ── CodeX 1006 第二輪 P1：「看起來是相對路徑」卻會解析到別站 ───────────────
{
  const d = { defaultSite: 'cp', siteUrls: SITE_URLS };
  for (const p of ['//uat-nc.osmslot.org/login', '//nc.example/login', '/\\nc.example/x', '\\\\nc.example/x']) {
    check(`site=cp、path=${JSON.stringify(p)} → 解析時拒絕`, /別的站|衝突/.test(await throwsMsg(() => resolveSiteTarget(p, 'cp', d)) ?? ''), p);
    check(`site=cp、path=${JSON.stringify(p)} → 存檔就擋`, checkOpenPageSites([{ action: 'open_page', path: p, site: 'cp' }]).length === 1, p);
  }
  check('正常相對路徑（含 query）照樣過', checkOpenPageSites([{ action: 'open_page', path: '/egm/list?x=1', site: 'cp' }]).length === 0 && resolveSiteTarget('/egm/list?x=1', 'cp', d).url === `${CP}/egm/list?x=1`);
}
// 補登前驗實際頁面在哪一站（涵蓋轉址）
{
  const b = fakeBrowser();
  const deps = { ...b.deps, async goto(u) { b.log.push(`goto ${u}`); await b.deps.goto(u.replace(CP, NC)); } };   // CP 的頁被轉到 NC
  const msg = await throwsMsg(() => openSitePage(deps, { url: `${CP}/egm`, site: 'cp', now }));
  check('CP 的頁被轉到 NC 的登入頁 → 拒絕，而且**沒有填任何帳密**', /別站的登入頁/.test(msg ?? '') && !b.log.some(x => x.startsWith('login')), { msg, log: b.log });
}
{
  const b = fakeBrowser();
  b.logged.add(CP); b.logged.add(NC);
  const deps = { ...b.deps, async goto(u) { await b.deps.goto(u.replace(CP, NC)); } };
  const msg = await throwsMsg(() => openSitePage(deps, { url: `${CP}/egm`, site: 'cp', now }));
  check('最後停在別站（已登入、沒經過登入頁）→ 也拒絕', /停在別站/.test(msg ?? ''), msg);
}

// CodeX 1006 第三輪 P2：等待期間（或關警告時）才轉到別站 → 也要拒絕，不能回傳 CP 的 origin
for (const when of ['wait', 'dismiss']) {
  const b = fakeBrowser();
  b.logged.add(CP); b.logged.add(NC);
  let jumped = false;
  const deps = { ...b.deps, async [when]() { await b.deps[when](); await b.deps.goto(`${NC}/elsewhere`); jumped = true; } };
  let res = null;
  const msg = await throwsMsg(async () => { res = await openSitePage(deps, { url: `${CP}/egm`, site: 'cp', now }); });
  check(`${when === 'wait' ? '等待期間' : '關站台警告時'}轉到 NC → 拒絕、不回傳成功`, jumped && /停在別站/.test(msg ?? '') && res === null, { msg, res });
}

// ── CodeX 1006 第二輪 P2：格式逐份查，帳密合併查 ──────────────────────
{
  const creds = { cp: { username: 'cpU', password: 'p' }, nc: { username: 'ncU', password: 'p' } };
  const newTc = [{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'open_page', path: '/b', site: 'nc' }];
  const oldTc = [{ action: 'open_page', path: '/c' }];
  check('新（全寫 site）＋舊（都沒寫）一起選跑 → 可以跑', sitePreflightError([newTc, oldTc], 'cp', s => creds[s]) === null, sitePreflightError([newTc, oldTc], 'cp', s => creds[s]));
  const broken = [{ action: 'open_page', path: '/a', site: 'cp' }, { action: 'open_page', path: '/b' }];
  const e = sitePreflightError([oldTc, broken], 'cp', s => creds[s]);
  check('單一份自己混寫 → 擋，並指出是第幾筆 TC', /第 2 筆 TC/.test(e ?? '') && !/第 1 筆 TC/.test(e ?? ''), e);
  const noNc = { cp: creds.cp, nc: { username: '', password: '' } };
  check('帳密合併查：舊 TC 不需要 NC、新 TC 需要 → 缺 NC 擋', /NC（uat-nc）/.test(sitePreflightError([oldTc, newTc], 'cp', s => noNc[s]) ?? ''));
  check('只跑舊 TC → 不要求 NC 帳密', sitePreflightError([oldTc], 'cp', s => noNc[s]) === null);
}

// ── CP／NC 用不同帳密（runner 兩條登入路徑都走 credsForSite） ──────────────
{
  const credentials = { cpBackend: { username: 'cp-user', password: 'cp-pw' }, nchBackend: { username: 'nc-user', password: 'nc-pw' } };
  check('credsForSite：cp → cpBackend、nc → nchBackend', credsForSite('cp', credentials).username === 'cp-user' && credsForSite('nc', credentials).username === 'nc-user');
  // 照 runner loginBackendSite 的寫法：login(site) 用 credsForSite(site) 填表——記下每一站實際填了誰
  const b = fakeBrowser();
  const filled = [];
  const deps = { ...b.deps, async login(site) { filled.push(`${site}:${credsForSite(site, credentials).username}`); await b.deps.login(site); } };
  await openSitePage(deps, { url: `${CP}/a`, site: 'cp', now });
  await openSitePage(deps, { url: `${NC}/a`, site: 'nc', now });
  check('CP→NC：各站填的是自己的帳號，沒有拿錯', filled.join(',') === 'cp:cp-user,nc:nc-user', filled);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
