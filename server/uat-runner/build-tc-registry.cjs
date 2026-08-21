/**
 * build-tc-registry.cjs
 * 建立/刷新 tc-registry.json —— record_id → 凍結版TC文字快照，
 * 供 run-lark-tc-backend.js 在文字被小幅潤飾時仍能穩定比對到正確規則。
 *
 * 用法：
 *   node build-tc-registry.cjs            初次建立：只新增registry裡還沒有的record_id，
 *                                          已存在的entry不動（避免把還沒人工確認過的drift
 *                                          悄悄用新文字覆蓋掉）
 *   node build-tc-registry.cjs --refresh <record_id>
 *                                          人工確認某筆TC的文字變更只是潤飾/意圖沒變後，
 *                                          明確刷新該筆的凍結文字為目前live版本
 *   node build-tc-registry.cjs --refresh-all-minor
 *                                          批次刷新所有「相似度>=0.75」的輕微drift項目
 *                                          （重大drift絕不自動刷新，一律要逐筆--refresh）
 */
const lib = require('./tc-match-lib.cjs');

async function main() {
  const args = process.argv.slice(2);
  const srcText = lib.loadSrcText();
  const cfg = lib.getLarkConfig(srcText);
  const targets = await lib.fetchAllLiveTCs(cfg);
  const { covered, gaps, structuralOnly, noVerifierMapped } = lib.computeCoverage(srcText, targets);

  const registry = lib.loadRegistry();
  const refreshIdx = args.indexOf('--refresh');
  const refreshAllMinor = args.includes('--refresh-all-minor');

  if (refreshIdx !== -1) {
    const targetId = args[refreshIdx + 1];
    if (!targetId) { console.error('❌ --refresh 需要接 record_id'); process.exit(1); }
    const hit = covered.find(c => c.id === targetId);
    if (!hit) {
      console.error(`❌ record_id=${targetId} 目前不在「已命中規則」清單中（可能是缺口或已刪除），無法刷新為凍結版`);
      process.exit(1);
    }
    const prev = registry[targetId];
    registry[targetId] = {
      verifierName: hit.verifierName,
      canonicalText: hit.tcText,
      matchedVia: hit.via,
      sub: hit.sub,
      capturedAt: new Date().toISOString(),
    };
    lib.saveRegistry(registry);
    console.log(`✅ 已刷新 record_id=${targetId} [${hit.sub}]`);
    if (prev) {
      console.log(`   舊凍結版: ${prev.canonicalText.slice(0, 100).replace(/\n/g, ' ')}`);
      console.log(`   新凍結版: ${hit.tcText.slice(0, 100).replace(/\n/g, ' ')}`);
    }
    return;
  }

  if (refreshAllMinor) {
    let count = 0;
    for (const c of covered) {
      const entry = registry[c.id];
      if (!entry) continue;
      if (lib.normalize(entry.canonicalText) === lib.normalize(c.tcText)) continue;
      const sim = lib.textSimilarity(entry.canonicalText, c.tcText);
      if (sim >= 0.75) {
        registry[c.id] = {
          verifierName: c.verifierName,
          canonicalText: c.tcText,
          matchedVia: c.via,
          sub: c.sub,
          capturedAt: new Date().toISOString(),
        };
        count++;
      }
    }
    lib.saveRegistry(registry);
    console.log(`✅ 批次刷新 ${count} 筆輕微drift項目（相似度>=0.75）`);
    return;
  }

  // 預設模式：只新增還沒有的
  let added = 0;
  for (const c of covered) {
    if (registry[c.id]) continue;
    registry[c.id] = {
      verifierName: c.verifierName,
      canonicalText: c.tcText,
      matchedVia: c.via,
      sub: c.sub,
      capturedAt: new Date().toISOString(),
    };
    added++;
  }
  lib.saveRegistry(registry);
  console.log(`✅ tc-registry.json 已更新：新增 ${added} 筆快照（已存在的entry不動）`);
  console.log(`   目前registry共 ${Object.keys(registry).length} 筆`);
  console.log(`   live已命中規則: ${covered.length} 筆 / 缺口: ${gaps.length} 筆 / 結構性通用: ${structuralOnly.length} 筆 / 無verifier對照: ${noVerifierMapped.length} 筆`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
