/**
 * 覆蓋率檢查器 — 不開瀏覽器，純比對 Lark 即時 TC 文字 vs run-lark-tc-backend.js
 * 各 verifier 內登記的 regex 規則，找出「TC文字目前對不到任何規則」的項目。
 *
 * 2026-08-06 架構升級：比對邏輯抽到 tc-match-lib.cjs 共用（build-tc-registry.cjs
 * 也用同一份），並新增 registry drift 偵測——runtime 現在會用 tc-registry.json
 * 凍結快照吸收「TC文字被小幅潤飾」造成的regex失效，這支工具負責在drift發生時
 * 主動報告出來，而不是等下次live run才肉眼發現。
 *
 * 用法：node check-tc-coverage.cjs
 */
const lib = require('./tc-match-lib.cjs');

(async () => {
  const srcText = lib.loadSrcText();
  const cfg = lib.getLarkConfig(srcText);
  const targets = await lib.fetchAllLiveTCs(cfg);
  const { covered, gaps, structuralOnly, noVerifierMapped, specialCaseHandled } = lib.computeCoverage(srcText, targets);

  console.log(`\n總計 live 後台 UAT TC（有子類型）: ${targets.length}`);
  console.log(`✅ 命中具體規則（含MANUAL）: ${covered.length}`);
  console.log(`⚪ 結構性通用verifier（不計入覆蓋率統計）: ${structuralOnly.length}`);
  console.log(`⭐ main()特判分支處理（非SUBTYPE_MAP，工具看不到但實際有人管，不算缺口）: ${specialCaseHandled.length}`);
  console.log(`❓ 找不到對應verifier（SUBTYPE_MAP有但PAGE_VERIFIERS無，真的沒人管）: ${noVerifierMapped.length}`);
  console.log(`❌ 缺口（有專屬verifier但TC文字對不到任何規則）: ${gaps.length}`);

  if (gaps.length > 0) {
    console.log('\n=== ❌ 缺口清單 ===');
    gaps.forEach((g, i) => {
      console.log(`${i + 1}. [${g.sub}] (${g.verifierName}, 該頁已有${g.availableRules}條規則但都不匹配)`);
      console.log(`   TC文字: ${g.tcText.slice(0, 120).replace(/\n/g, ' ')}`);
    });
  }
  if (noVerifierMapped.length > 0) {
    console.log('\n=== ❓ 無verifier對照 ===');
    noVerifierMapped.forEach((g, i) => console.log(`${i + 1}. [${g.sub}] ${g.tcText.slice(0, 80).replace(/\n/g, ' ')}`));
  }

  // ── Registry drift 偵測 ──────────────────────────────────────────────
  const registry = lib.loadRegistry();
  const regEntries = Object.entries(registry);
  if (regEntries.length > 0) {
    const coveredById = new Map(covered.map(c => [c.id, c]));
    let stable = 0, minorDrift = 0, majorDrift = 0, missingLive = 0;
    const majorDriftList = [];
    const minorDriftList = [];
    const missingList = [];

    for (const [id, entry] of regEntries) {
      const live = coveredById.get(id) || [...gaps, ...structuralOnly, ...noVerifierMapped, ...specialCaseHandled].find(x => x.id === id);
      if (!live) { missingLive++; missingList.push({ id, entry }); continue; }
      const liveText = live.tcText;
      if (lib.normalize(liveText) === lib.normalize(entry.canonicalText)) { stable++; continue; }
      const sim = lib.textSimilarity(entry.canonicalText, liveText);
      if (sim >= 0.75) {
        minorDrift++;
        minorDriftList.push({ id, sim, sub: live.sub, entry, liveText });
      } else {
        majorDrift++;
        majorDriftList.push({ id, sim, sub: live.sub, entry, liveText });
      }
    }

    console.log(`\n=== 📌 Registry Drift 檢查（共 ${regEntries.length} 筆凍結快照）===`);
    console.log(`✅ 文字完全一致: ${stable}`);
    console.log(`🟡 輕微潤飾（相似度≥0.75，runtime會自動用凍結版比對，不影響）: ${minorDrift}`);
    console.log(`🔴 重大變更（相似度<0.75，runtime會fallback用live文字，可能對不到規則，需人工確認後重新curate）: ${majorDrift}`);
    if (missingLive > 0) console.log(`⚠️  registry裡的record在目前live TC清單中找不到（可能已刪除/不再是UAT後台TC）: ${missingLive}`);

    if (majorDriftList.length > 0) {
      console.log('\n=== 🔴 重大Drift清單（建議人工確認後執行: node build-tc-registry.cjs --refresh <record_id>）===');
      majorDriftList.forEach((d, i) => {
        console.log(`${i + 1}. [${d.sub}] record_id=${d.id} 相似度=${(d.sim * 100).toFixed(0)}%`);
        console.log(`   凍結版: ${d.entry.canonicalText.slice(0, 100).replace(/\n/g, ' ')}`);
        console.log(`   live版: ${d.liveText.slice(0, 100).replace(/\n/g, ' ')}`);
      });
    }
    if (missingList.length > 0) {
      console.log('\n=== ⚠️ Registry中找不到對應live TC ===');
      missingList.forEach((d, i) => console.log(`${i + 1}. record_id=${d.id} [${d.entry.verifierName}] ${d.entry.canonicalText.slice(0, 80).replace(/\n/g, ' ')}`));
    }
  } else {
    console.log('\n⚠️ tc-registry.json 尚未建立或是空的，執行 node build-tc-registry.cjs 建立初始快照');
  }

  process.exit(gaps.length > 0 ? 1 : 0);
})();
