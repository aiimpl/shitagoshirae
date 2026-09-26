// テロップの帯を Canvas2D で絵にして、あとは貼るだけにする
// 絵にするのは画面側。こうすると Worker の中でフォントを読む必要がない
// @ts-check

/** @typedef {import('./captions.js').CaptionBand} CaptionBand */
/** @typedef {import('./types.js').CaptionBitmap} CaptionBitmap */

// 絵にしてよい量の上限。これを超えたら、超えたぶんは出さない（メモリを守る）
const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * 文字幅を測る関数を作る
 * @returns {(text: string, font: string) => number}
 */
export function makeTextMeasurer() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('文字を測れません');
  }
  return (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/**
 * 帯を絵にする
 * @param {CaptionBand[]} bands
 * @param {{ byteBudget?: number }} [opts]
 * @returns {Promise<{ bitmaps: CaptionBitmap[], dropped: number }>}
 */
export async function rasterizeBands(bands, opts = {}) {
  const budget = opts.byteBudget ?? DEFAULT_BUDGET_BYTES;
  await loadFonts(bands);
  /** @type {Map<string, ImageBitmap>} */
  const cache = new Map();
  /** @type {CaptionBitmap[]} */
  const bitmaps = [];
  let used = 0;
  let dropped = 0;
  for (const band of bands) {
    const cached = cache.get(band.key);
    if (cached) {
      bitmaps.push({ key: band.key, startUs: band.startUs, endUs: band.endUs, rect: band.rect, bitmap: cached });
      continue;
    }
    const cost = band.rect.w * band.rect.h * 4;
    if (used + cost > budget) {
      dropped++;
      continue;
    }
    const bitmap = await drawBand(band);
    cache.set(band.key, bitmap);
    used += cost;
    bitmaps.push({ key: band.key, startUs: band.startUs, endUs: band.endUs, rect: band.rect, bitmap });
  }
  return { bitmaps, dropped };
}

/**
 * 帯1枚を描く
 * @param {CaptionBand} band
 * @returns {Promise<ImageBitmap>}
 */
async function drawBand(band) {
  const canvas = new OffscreenCanvas(Math.max(1, band.rect.w), Math.max(1, band.rect.h));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('テロップを描けません');
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (const op of band.ops) {
    if (op.kind === 'rect') {
      ctx.fillStyle = op.fill;
      ctx.fillRect(op.x, op.y, op.w, op.h);
      continue;
    }
    ctx.font = op.font;
    if (op.stroke) {
      ctx.strokeStyle = op.stroke;
      ctx.lineWidth = op.strokeWidth;
      ctx.strokeText(op.text, op.x, op.y);
    }
    ctx.fillStyle = op.fill;
    ctx.fillText(op.text, op.x, op.y);
  }
  return createImageBitmap(canvas);
}

/**
 * 使う文字ぶんのフォントを先に読み込む。待たないと、最初の数枚だけ別のフォントで焼き込まれる
 * @param {CaptionBand[]} bands
 */
async function loadFonts(bands) {
  if (!document.fonts) {
    return;
  }
  /** @type {Map<string, string>} */
  const need = new Map();
  for (const band of bands) {
    for (const op of band.ops) {
      if (op.kind !== 'text') {
        continue;
      }
      need.set(op.font, (need.get(op.font) || '') + op.text);
    }
  }
  await Promise.all([...need].map(([font, text]) => document.fonts.load(font, text).catch(() => [])));
  await document.fonts.ready;
}

/**
 * 使い終わった絵を片付ける
 * @param {CaptionBitmap[]} bitmaps
 */
export function closeBitmaps(bitmaps) {
  const seen = new Set();
  for (const b of bitmaps) {
    if (seen.has(b.bitmap)) {
      continue;
    }
    seen.add(b.bitmap);
    b.bitmap.close();
  }
}
