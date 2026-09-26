// 矩形と回転の計算を、ブラウザなしで確かめる
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evenFloor,
  rotatedSize,
  containRect,
  coverRect,
  coverCropUv,
  uvTransform,
  applyUv,
  outputSize,
  planGeometry,
} from '../src/geometry.js';

test('偶数に切り下げる', () => {
  assert.equal(evenFloor(1921), 1920);
  assert.equal(evenFloor(1920), 1920);
  assert.equal(evenFloor(0.9), 0);
});

test('回転すると縦横が入れ替わる', () => {
  assert.deepEqual(rotatedSize(1920, 1080, 90), { w: 1080, h: 1920 });
  assert.deepEqual(rotatedSize(1920, 1080, 270), { w: 1080, h: 1920 });
  assert.deepEqual(rotatedSize(1920, 1080, 180), { w: 1920, h: 1080 });
  assert.deepEqual(rotatedSize(1920, 1080, 0), { w: 1920, h: 1080 });
});

test('横長の映像を縦の箱に収めると、上下に余白ができる', () => {
  const r = containRect(1920, 1080, 1080, 1920);
  assert.equal(r.w, 1080);
  assert.equal(r.h, 606);
  assert.equal(r.x, 0);
  // 上下の余白がほぼ同じ
  assert.ok(Math.abs(r.y - (1920 - r.h - r.y)) <= 2);
});

test('覆い尽くすときは箱からはみ出す', () => {
  const r = coverRect(1920, 1080, 1080, 1920);
  assert.ok(r.w >= 1080);
  assert.ok(r.h >= 1920);
  assert.ok(r.x <= 0);
  assert.ok(r.y <= 0);
});

test('切り抜きの範囲は、横長を縦にするとき左右を捨てる', () => {
  const uv = coverCropUv(1920, 1080, 1080, 1920);
  assert.equal(uv.y, 0);
  assert.equal(uv.h, 1);
  assert.ok(uv.w < 1);
  assert.ok(Math.abs(uv.x - (1 - uv.w) / 2) < 1e-9);
});

test('回転の式は、見た目の四隅を元の画の四隅に正しく移す', () => {
  // 見た目の左上→元の画のどこか、を回転ごとに確かめる（鏡像になっていないかの検査）
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  /** @type {Record<number, number[][]>} */
  const expected = {
    0: [[0, 0], [1, 0], [1, 1], [0, 1]],
    90: [[0, 1], [0, 0], [1, 0], [1, 1]],
    180: [[1, 1], [0, 1], [0, 0], [1, 0]],
    270: [[1, 0], [1, 1], [0, 1], [0, 0]],
  };
  for (const rot of /** @type {const} */ ([0, 90, 180, 270])) {
    const tr = uvTransform(rot);
    corners.forEach(([u, v], i) => {
      const got = applyUv(tr, u, v);
      assert.deepEqual([got.u, got.v], expected[rot][i], `${rot}度の${i}番目の角`);
    });
  }
});

test('1080pの16:9は1920×1080になる', () => {
  const s = outputSize({ dispW: 3840, dispH: 2160, shape: '16:9', baseSide: 1080, pad: 'blur' });
  assert.deepEqual([s.width, s.height], [1920, 1080]);
  assert.equal(s.clampedAspect, false);
});

test('720pの正方形と縦は、Xの推奨どおりになる', () => {
  const sq = outputSize({ dispW: 1920, dispH: 1080, shape: '1:1', baseSide: 720, pad: 'blur' });
  assert.deepEqual([sq.width, sq.height], [720, 720]);
  const portrait = outputSize({ dispW: 1920, dispH: 1080, shape: '9:16', baseSide: 720, pad: 'blur' });
  assert.deepEqual([portrait.width, portrait.height], [720, 1280]);
});

test('小さい映像を大きい箱に入れても、引き伸ばさない', () => {
  const s = outputSize({ dispW: 640, dispH: 480, shape: '16:9', baseSide: 1080, pad: 'blur' });
  assert.equal(s.height, 480);
  assert.equal(s.width, 852);
});

test('切り抜きのときも引き伸ばさない', () => {
  const s = outputSize({ dispW: 640, dispH: 480, shape: '16:9', baseSide: 1080, pad: 'crop' });
  assert.ok(s.width <= 640);
  assert.ok(s.height <= 480);
});

test('元の比率のままでも、1:3〜3:1に収める', () => {
  const s = outputSize({ dispW: 4000, dispH: 500, shape: 'keep', baseSide: 1080, pad: 'blur' });
  assert.equal(s.clampedAspect, true);
  assert.ok(s.width / s.height <= 3.001);
});

test('縦向きのiPhone動画（横で復号され、回転情報が90度）は、縦のまま出る', () => {
  const g = planGeometry({ codedWidth: 1920, codedHeight: 1080, rotation: 90 }, { shape: 'keep', pad: 'blur', baseSide: 1080 });
  assert.deepEqual([g.outWidth, g.outHeight], [1080, 1920]);
  assert.equal(g.needsPad, false);
  assert.equal(g.rotation, 90);
  assert.deepEqual([g.foreground.w, g.foreground.h], [1080, 1920]);
});

test('縦動画を16:9にすると、左右に余白ができる', () => {
  const g = planGeometry({ codedWidth: 1920, codedHeight: 1080, rotation: 90 }, { shape: '16:9', pad: 'blur', baseSide: 1080 });
  assert.deepEqual([g.outWidth, g.outHeight], [1920, 1080]);
  assert.equal(g.needsPad, true);
  assert.ok(g.foreground.w < g.outWidth);
  assert.equal(g.foreground.h, 1080);
  // ぼかし背景は出力をはみ出して覆う
  assert.ok(g.background.w >= g.outWidth);
  assert.ok(g.background.h >= g.outHeight);
});

test('切り抜きにすると余白なしで埋まる', () => {
  const g = planGeometry({ codedWidth: 1920, codedHeight: 1080, rotation: 0 }, { shape: '9:16', pad: 'crop', baseSide: 1080 });
  assert.equal(g.needsPad, false);
  assert.deepEqual([g.foreground.w, g.foreground.h], [g.outWidth, g.outHeight]);
  assert.ok(g.sourceUv.w < 1);
});

test('どんな入力でも、出力は偶数で正の大きさになる', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const shapes = /** @type {const} */ (['keep', '16:9', '1:1', '9:16']);
  const pads = /** @type {const} */ (['blur', 'color', 'crop']);
  for (let i = 0; i < 500; i++) {
    const w = 2 + Math.floor(rnd() * 4000);
    const h = 2 + Math.floor(rnd() * 4000);
    const rot = /** @type {import('../src/types.js').Rotation} */ ([0, 90, 180, 270][Math.floor(rnd() * 4)]);
    const g = planGeometry(
      { codedWidth: w, codedHeight: h, rotation: rot },
      { shape: shapes[Math.floor(rnd() * 4)], pad: pads[Math.floor(rnd() * 3)], baseSide: rnd() < 0.5 ? 720 : 1080 },
    );
    assert.equal(g.outWidth % 2, 0, `幅が偶数でない: ${w}x${h}`);
    assert.equal(g.outHeight % 2, 0, `高さが偶数でない: ${w}x${h}`);
    assert.ok(g.outWidth > 0 && g.outHeight > 0);
    assert.ok(g.foreground.w <= g.outWidth && g.foreground.h <= g.outHeight);
  }
});
