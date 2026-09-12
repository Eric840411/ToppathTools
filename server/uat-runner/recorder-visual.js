import { createRequire } from 'node:module';
let PNG;
try { ({ PNG } = createRequire(import.meta.url)('pngjs')); } catch { /* Older agents may not have visual dependencies yet. */ }

export function decodePng(data) {
  if (!PNG) throw new Error('Agent 缺少圖片依賴，請在 Agent 目錄執行 npm install pngjs@7，再重新執行');
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data).replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buffer.length > 2 * 1024 * 1024 || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('基準圖必須是 2 MB 以內 PNG');
  if (buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 4_000_000) throw new Error('PNG 最多 400 萬像素');
  return PNG.sync.read(buffer);
}

export function pngPreview(buffer, bounds) {
  const source = decodePng(buffer);
  const scale = Math.min(1, 480 / source.width, 300 / source.height);
  const out = new PNG({ width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const sx = Math.min(source.width - 1, Math.floor(x / scale)), sy = Math.min(source.height - 1, Math.floor(y / scale));
    const dest = (y * out.width + x) * 4, pos = (sy * source.width + sx) * 4;
    source.data.copy(out.data, dest, pos, pos + 4);
    if (bounds && sx >= bounds.x && sx <= bounds.x + bounds.width && sy >= bounds.y && sy <= bounds.y + bounds.height
      && (sx < bounds.x + 4 || sx > bounds.x + bounds.width - 4 || sy < bounds.y + 4 || sy > bounds.y + bounds.height - 4)) {
      out.data[dest] = 255; out.data[dest + 1] = 190; out.data[dest + 2] = 50; out.data[dest + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + PNG.sync.write(out).toString('base64');
}

export function compareRegionPng(baseline, actual, thresholdPct = 1, pixelTolerance = 20) {
  if (!baseline) throw new Error('尚未指定基準圖；請先人工確認並上傳，不會自動建立或判定通過');
  if (!Number.isFinite(thresholdPct) || thresholdPct < 0 || thresholdPct > 100 || !Number.isFinite(pixelTolerance) || pixelTolerance < 0 || pixelTolerance > 255) throw new Error('差異門檻須為 0～100%，像素容差須為 0～255');
  const expected = decodePng(baseline), current = decodePng(actual);
  if (expected.width !== current.width || expected.height !== current.height) return {
    pass: false, expected: `${expected.width} × ${expected.height}`, actual: `${current.width} × ${current.height}`, message: '圖片尺寸不同，請確認定位與執行環境',
  };
  const diff = new PNG({ width: current.width, height: current.height });
  let changed = 0;
  for (let i = 0; i < current.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      const a = expected.data[i + c] * expected.data[i + 3] / 255;
      const b = current.data[i + c] * current.data[i + 3] / 255;
      delta = Math.max(delta, Math.abs(a - b));
    }
    if (delta > pixelTolerance) { changed++; diff.data[i] = 240; diff.data[i + 1] = 60; diff.data[i + 2] = 70; }
    else for (let c = 0; c < 3; c++) diff.data[i + c] = current.data[i + c] * .35;
    diff.data[i + 3] = 255;
  }
  const differencePct = changed / (current.width * current.height) * 100;
  return { pass: differencePct <= thresholdPct, expected: `差異 ≤ ${thresholdPct}%`, actual: `${differencePct.toFixed(3)}%`, differencePct,
    message: `差異 ${differencePct.toFixed(3)}%，門檻 ${thresholdPct}%`, diffPng: PNG.sync.write(diff) };
}
