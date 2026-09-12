/** Validate references before opening a browser; ignore disabled steps. */
export function stepDependencyIssues(steps) {
  const available = new Set();
  const issues = [];
  for (const [index, step] of steps.entries()) {
    if (!step || step.disabled === true) continue;
    const refs = ['assert_filled', 'assert_sorted'].includes(step.action)
      ? [step.from]
      : step.action === 'assert_equals'
        ? [step.left, step.right].filter(ref => /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(String(ref))) : [];
    for (const ref of refs) {
      const name = String(ref || '').split('.')[0];
      if (name && !available.has(name)) issues.push({ index, name,
        message: `第 ${index + 1} 步引用「${name}」，但前面沒有啟用的讀取步驟。請補上讀取、移到檢查之前，或修正來源變數。` });
    }
    if (step.action === 'read_block' && !String(step.selector || '').trim()) issues.push({ index, name: String(step.as || ''), message: `第 ${index + 1} 步尚未填入區塊 selector，請重新錄製來源元素或填入定位。` });
    if (['read_block', 'read_table'].includes(step.action) && typeof step.as === 'string') available.add(step.as);
  }
  return issues;
}
