import { BLOCK_DEFS, runSteps } from './block-engine.js';
import { stepDependencyIssues } from './step-dependencies.js';

/** A script preserves one chronological flow. tcId owns evidence/results, never a display number. */
export function isCheck(step) {
  return ['assert', 'compare'].includes(BLOCK_DEFS[step.action]?.category);
}

export function validateMultiTcScript(script, forRun = false) {
  const errors = [];
  if (!script || !Array.isArray(script.bindings) || !Array.isArray(script.steps)) return ['腳本格式不正確'];
  if (forRun) errors.push(...stepDependencyIssues(script.steps).map(issue => issue.message));
  const ids = new Set(script.bindings.map(b => b.recordId));
  if (!ids.size || ids.size !== script.bindings.length) errors.push('必須綁定 TC，且每筆 recordId 不得重複');
  if (script.bindings.some(b => b.tableId !== script.tableId)) errors.push('TC 必須來自腳本綁定的同一張 Lark 表格');
  if (forRun && !script.steps.some(s => s && s.disabled !== true)) errors.push('腳本沒有步驟');
  script.steps.forEach((step, i) => {
    if (!step || typeof step.action !== 'string') { errors.push(`第 ${i + 1} 步：格式不正確`); return; }
    const def = BLOCK_DEFS[step.action];
    if (!def || step.action === 'builtin_verifier') errors.push(`第 ${i + 1} 步：多 TC 腳本不支援 ${step.action}`);
    if (step.tcId && !ids.has(step.tcId)) errors.push(`第 ${i + 1} 步：找不到綁定的 TC`);
    if (forRun && step.disabled !== true && !step.tcId && (isCheck(step) || ['read', 'evidence', 'result'].includes(def?.category))) errors.push(`第 ${i + 1} 步：請指定檢查、讀值或截圖的所屬 TC`);
    if (forRun && step.disabled !== true && step.secret) errors.push(`第 ${i + 1} 步：密碼欄位需移至登入設定，不可直接重播空密碼`);
  });
  for (const id of ids) if (script.steps.filter(s => s?.action === 'set_tc_result' && s.tcId === id && s.disabled !== true).length > 1) errors.push(`TC ${id} 只能有一個啟用的回填判定積木`);
  return errors;
}

export function reviewMultiTcScript(script) {
  return script.bindings.map(binding => {
    const steps = script.steps.filter(s => s.tcId === binding.recordId && s.disabled !== true);
    return { ...binding, stepCount: steps.length, checks: steps.filter(isCheck).length,
      screenshots: steps.filter(s => s.action === 'screenshot').length,
      weakSelectors: steps.filter(s => s.selectorStrategy === 'cssPath').length };
  });
}

/** Per-TC failure isolation, one shared page, persistent read variables and explicit evidence. */
export async function runMultiTcSteps(steps, ctx, bindings) {
  const results = bindings.map(b => ({ recordId: b.recordId, task: b.text || b.title || b.number,
    subtype: b.sub || '多 TC 錄製', pass: false, manual: false, skip: false, outcome: 'unverified',
    steps: [], evidence: [], assertions: 0, durationMs: 0, criticalFails: [], warnings: [], allShotPaths: [], notes: '', error: null }));
  const byId = new Map(results.map(r => [r.recordId, r]));
  const state = { vars: {}, netMark: Date.now() };
  const stopped = new Set();
  let sharedFailure = '';
  const sharedSteps = [];
  let previewBytes = 0;
  const preview = async (shot) => {
    if (!ctx.previewEvidence || previewBytes > 4_000_000) return undefined;
    try { const url = await ctx.previewEvidence(shot); if (!url || url.length + previewBytes > 4_000_000) return undefined; previewBytes += url.length; return url; } catch { return undefined; }
  };
  const append = (row, note) => { if (note) row.notes += (row.notes ? ' | ' : '') + note; };
  for (const [index, step] of steps.entries()) {
    const row = step.tcId ? byId.get(step.tcId) : null;
    if (step.tcId && !row) throw new Error(`第 ${index + 1} 步所屬 TC 不存在`);
    const trace = { index, action: step.action, selector: step.selector || '', status: 'pending', durationMs: 0, evidence: [] };
    (row ? row.steps : sharedSteps).push(trace);
    if (step.disabled === true) { trace.status = 'disabled'; continue; }
    if (row && stopped.has(row.recordId)) { trace.status = 'blocked'; continue; }
    if (!row && (isCheck(step) || ['read', 'evidence', 'result'].includes(BLOCK_DEFS[step.action]?.category))) {
      sharedFailure = `第 ${index + 1} 步尚未指定所屬 TC`; break;
    }
    ctx.onStep?.({ index, step, recordId: row?.recordId ?? null });
    const started = Date.now();
    // Each TC's declared locators must remain unique; no silent first-match/coordinate repair.
    let result;
    try {
      const locator = await ctx.checkLocator?.(step);
      if (locator) {
        if (locator.preview) { if (previewBytes + locator.preview.length <= 4_000_000) previewBytes += locator.preview.length; else delete locator.preview; }
        trace.locator = locator;
      }
      result = await runSteps([step], { ...ctx, multiTc: true }, { state, autoScreenshot: false });
    } catch (error) {
      if (error.locator) trace.locator = error.locator;
      result = { pass: false, manual: false, error: error.message, notes: error.message, criticalFails: [error.message], warnings: [], allShotPaths: [] };
    }
    trace.durationMs = Date.now() - started;
    trace.status = !result.pass ? 'fail' : result.manual || result.warnings.length ? 'unverified' : 'pass';
    trace.notes = result.notes;
    trace.diagnostics = result.diagnostics || [];
    if (!result.pass && ctx.takeScreenshot) {
      try { const shot = await ctx.takeScreenshot(`failure_${row?.recordId || 'shared'}_${index + 1}`); if (shot) result.allShotPaths.push(shot); } catch {}
    }
    for (const shot of result.allShotPaths) {
      const evidence = { index, name: shot.split(/[\\/]/).pop(), path: shot, preview: await preview(shot) };
      trace.evidence.push(evidence);

    }
    if (!row) {
      if (!result.pass || result.manual || result.warnings.length) {
        sharedFailure = `共用步驟 ${index + 1} 失敗：${result.error || result.notes}`; break;
      }
      continue;
    }
    if (result.declaredOutcome) { row.declaredOutcome = result.declaredOutcome; row.decisionSource = '人工指定'; }
    row.durationMs += Date.now() - started;
    row.allShotPaths.push(...result.allShotPaths);
    row.criticalFails.push(...result.criticalFails);
    row.warnings.push(...result.warnings);
    append(row, `[步驟 ${index + 1}] ${result.notes}`);
    if (isCheck(step) && result.pass && !result.manual && !result.warnings.length) row.assertions++;
    if (result.manual) row.manual = true;
    if (!result.pass || result.manual) {
      if (step.onFail !== 'continue' || result.manual) stopped.add(row.recordId);
    }
  }
  for (const row of results) {
    row.sharedSteps = row === results[0] ? sharedSteps : [];
    if (row.declaredOutcome === 'fail') { row.outcome = 'fail'; row.manual = false; row.error = row.criticalFails[0] || '人工指定 FAIL';
    } else if (row.criticalFails.length) {
      row.outcome = 'fail'; row.manual = false; row.error = row.criticalFails[0];
    } else if (sharedFailure) {
      row.outcome = 'blocked'; row.manual = true; append(row, sharedFailure);
    } else if (row.manual || (!row.assertions && row.declaredOutcome !== 'pass') || row.warnings.length) {
      row.outcome = 'unverified'; row.manual = true;
      append(row, row.warnings.length ? '存在未完成或警告級檢查，待確認' : '需人工確認或沒有成功執行的檢查條件');
    } else { row.outcome = 'pass'; row.pass = true; }
  }
  return { results, sharedFailure };
}

/** Also used by tests: unverified/blocked clear both boxes; each row receives only its own evidence. */
export async function publishMultiTcResults(results, { upload, update, onError = () => {} }) {
  const failures = [];
  for (const row of results) {
    const tokens = [];
    try {
      for (const shot of [...new Set(row.allShotPaths)]) {
        const token = await upload(shot);
        if (!token) throw new Error('截圖上傳未取得 file token');
        tokens.push(token);
      }
      const outcome = row.outcome === 'pass' ? 'pass' : row.outcome === 'fail' ? 'fail' : 'manual';
      const response = await update(row.recordId, tokens, outcome);
      if (response?.code !== 0) throw new Error(response?.msg || 'Lark 回寫未確認成功');
      row.published = true;
    } catch (error) {
      const message = `${row.recordId}：${error.message}`;
      row.published = false; row.publishError = message; failures.push(message); onError(message);
    }
  }
  return failures;
}
