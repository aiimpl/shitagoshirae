// 回転・はめ込み・切り抜きの矩形計算だけ。画素には触らない
// @ts-check

/** @typedef {import('./types.js').Rect} Rect */
/** @typedef {import('./types.js').Rotation} Rotation */
/** @typedef {import('./types.js').Geometry} Geometry */
/** @typedef {import('./types.js').UvTransform} UvTransform */
/** @typedef {import('./types.js').Shape} Shape */
/** @typedef {import('./types.js').PadMode} PadMode */

// Xが受け付ける比率の範囲（1:3 〜 3:1）
export const MIN_ASPECT = 1 / 3;
export const MAX_ASPECT = 3;

/**
 * 偶数に切り下げる。H.264 の 4:2:0 は幅も高さも偶数でないと扱えない
 * @param {number} n
 * @returns {number}
 */
export function evenFloor(n) {
  const v = Math.floor(n);
  return v - (v % 2);
}

/**
 * 回転を当てたあとの見た目の大きさ
 * @param {number} w
 * @param {number} h
 * @param {Rotation} rotation
 * @returns {{ w: number, h: number }}
 */
export function rotatedSize(w, h, rotation) {
  if (rotation === 90 || rotation === 270) {
    return { w: h, h: w };
  }
  return { w, h };
}

/**
 * 箱の中に収める（はみ出さない。余白ができる）
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} boxW
 * @param {number} boxH
 * @returns {Rect}
 */
export function containRect(srcW, srcH, boxW, boxH) {
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = evenFloor(srcW * scale);
  const h = evenFloor(srcH * scale);
  return { x: evenFloor((boxW - w) / 2), y: evenFloor((boxH - h) / 2), w, h };
}

/**
 * 箱を覆い尽くす（はみ出す。余白はできない）
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} boxW
 * @param {number} boxH
 * @returns {Rect}
 */
export function coverRect(srcW, srcH, boxW, boxH) {
  const scale = Math.max(boxW / srcW, boxH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w, h };
}

/**
 * 覆い尽くすために、元の画のどこを読むか（0〜1の割合で返す）
 * offsetX・offsetY は -1〜1。0なら真ん中、1なら端いっぱいまで寄せる
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} boxW
 * @param {number} boxH
 * @param {number} [offsetX]
 * @param {number} [offsetY]
 * @returns {Rect}
 */
export function coverCropUv(srcW, srcH, boxW, boxH, offsetX = 0, offsetY = 0) {
  const srcAspect = srcW / srcH;
  const boxAspect = boxW / boxH;
  const shift = (size, offset) => {
    const slack = (1 - size) / 2;
    return slack + slack * Math.max(-1, Math.min(1, offset));
  };
  if (srcAspect > boxAspect) {
    // 元のほうが横長：左右を捨てる
    const w = boxAspect / srcAspect;
    return { x: shift(w, offsetX), y: 0, w, h: 1 };
  }
  const h = srcAspect / boxAspect;
  return { x: 0, y: shift(h, offsetY), w: 1, h };
}

/**
 * 回転した見た目の空間の uv を、復号したままの画素の uv に移す式
 * @param {Rotation} rotation
 * @returns {UvTransform}
 */
export function uvTransform(rotation) {
  switch (rotation) {
    case 90: return { m: [0, 1, -1, 0], t: [0, 1] };
    case 180: return { m: [-1, 0, 0, -1], t: [1, 1] };
    case 270: return { m: [0, -1, 1, 0], t: [1, 0] };
    default: return { m: [1, 0, 0, 1], t: [0, 0] };
  }
}

/**
 * uv の点に式を当てる（試験と合成で同じ計算を使う）
 * @param {UvTransform} tr
 * @param {number} u
 * @param {number} v
 * @returns {{ u: number, v: number }}
 */
export function applyUv(tr, u, v) {
  return {
    u: tr.m[0] * u + tr.m[1] * v + tr.t[0],
    v: tr.m[2] * u + tr.m[3] * v + tr.t[1],
  };
}

/**
 * かたちごとの、目標とする箱の比率。keep は呼び出し側で決める
 * @param {Shape} shape
 * @returns {number|null} 幅÷高さ
 */
function shapeAspect(shape) {
  switch (shape) {
    case '16:9': return 16 / 9;
    case '1:1': return 1;
    case '9:16': return 9 / 16;
    default: return null;
  }
}

/**
 * 出力の大きさを決める。元より大きくはしない。幅も高さも偶数
 * baseSide は短いほうの辺の目安（1080p なら 1080、720p なら 720）
 * @param {{ dispW: number, dispH: number, shape: Shape, baseSide: number, pad: PadMode }} a
 * @returns {{ width: number, height: number, clampedAspect: boolean }}
 */
export function outputSize(a) {
  const { dispW, dispH, shape, baseSide, pad } = a;
  const srcAspect = dispW / dispH;
  let aspect = shapeAspect(shape);
  let clampedAspect = false;
  if (aspect === null) {
    // 元の比率のまま。ただしXが受け付ける範囲に収める
    aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, srcAspect));
    clampedAspect = aspect !== srcAspect;
  }
  // 短いほうの辺を baseSide にした箱
  let boxW = aspect >= 1 ? baseSide * aspect : baseSide;
  let boxH = aspect >= 1 ? baseSide : baseSide / aspect;
  // 元の画を引き伸ばさない。引き伸ばすことになるなら、箱ごと縮める
  const fit = pad === 'crop'
    ? Math.max(boxW / dispW, boxH / dispH)
    : Math.min(boxW / dispW, boxH / dispH);
  if (fit > 1) {
    boxW /= fit;
    boxH /= fit;
  }
  return { width: Math.max(2, evenFloor(boxW)), height: Math.max(2, evenFloor(boxH)), clampedAspect };
}

/**
 * 回転・出力の大きさ・映像を置く場所・読む範囲を、まとめて決める
 * @param {{ codedWidth: number, codedHeight: number, rotation: Rotation }} src
 * @param {{ shape: Shape, pad: PadMode, baseSide: number, cropX?: number, cropY?: number }} want
 * @returns {Geometry}
 */
export function planGeometry(src, want) {
  const disp = rotatedSize(src.codedWidth, src.codedHeight, src.rotation);
  const size = outputSize({
    dispW: disp.w,
    dispH: disp.h,
    shape: want.shape,
    baseSide: want.baseSide,
    pad: want.pad,
  });
  const outWidth = size.width;
  const outHeight = size.height;

  const crop = want.pad === 'crop';
  const sourceUv = crop
    ? coverCropUv(disp.w, disp.h, outWidth, outHeight, want.cropX || 0, want.cropY || 0)
    : { x: 0, y: 0, w: 1, h: 1 };
  const foreground = crop
    ? { x: 0, y: 0, w: outWidth, h: outHeight }
    : containRect(disp.w, disp.h, outWidth, outHeight);
  const background = coverRect(disp.w, disp.h, outWidth, outHeight);
  const needsPad = foreground.w < outWidth || foreground.h < outHeight;

  return {
    srcWidth: src.codedWidth,
    srcHeight: src.codedHeight,
    rotation: src.rotation,
    outWidth,
    outHeight,
    sourceUv,
    foreground,
    background,
    uv: uvTransform(src.rotation),
    needsPad,
    clampedAspect: size.clampedAspect,
  };
}
