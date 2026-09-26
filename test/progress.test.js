// 残り時間の見積もりと、数値の見せ方を確かめる
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { EtaEstimator, formatBytes, formatEta, formatClock } from '../src/progress.js';
import { outputName } from '../src/convert.js';

test('一定の速さで進むと、残り時間が実際に近づく', () => {
  const eta = new EtaEstimator();
  const totalUs = 40_000_000;
  // 実時間の8倍の速さ（40秒の動画を5秒で処理する）で進める
  let last = null;
  for (let ms = 0; ms <= 4000; ms += 100) {
    last = eta.update({ mediaUs: ms * 8000, totalUs, nowMs: ms });
  }
  assert.ok(last);
  const trueLeft = (40_000_000 - 4000 * 8000) / 8000;
  assert.ok(Math.abs(last.etaMs - trueLeft) / trueLeft < 0.05, `${last.etaMs} vs ${trueLeft}`);
});

test('最初の1回では、残り時間はまだ出さない', () => {
  const eta = new EtaEstimator();
  const r = eta.update({ mediaUs: 0, totalUs: 1_000_000, nowMs: 0 });
  assert.equal(r.etaMs, null);
});

test('途中で止まっても、残り時間が負にならない', () => {
  const eta = new EtaEstimator();
  eta.update({ mediaUs: 0, totalUs: 10_000_000, nowMs: 0 });
  eta.update({ mediaUs: 5_000_000, totalUs: 10_000_000, nowMs: 1000 });
  let r = null;
  for (let ms = 1100; ms <= 4000; ms += 100) {
    r = eta.update({ mediaUs: 5_000_000, totalUs: 10_000_000, nowMs: ms });
  }
  assert.ok(r);
  assert.ok(r.etaMs === null || r.etaMs >= 0);
});

test('進み具合は 0〜1 に収まる', () => {
  const eta = new EtaEstimator();
  const r = eta.update({ mediaUs: 12_000_000, totalUs: 10_000_000, nowMs: 100 });
  assert.equal(r.ratio, 1);
});

test('バイト数の見せ方', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(30 * 1024 * 1024), '30.0 MB');
});

test('残り時間の見せ方（日本語と英語）', () => {
  assert.equal(formatEta(5000, 'ja'), '残り約5秒');
  assert.equal(formatEta(95_000, 'ja'), '残り約1分35秒');
  assert.equal(formatEta(95_000, 'en'), 'about 1m 35s left');
  assert.equal(formatEta(null, 'ja'), '計算中');
});

test('時刻の見せ方', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65_000_000), '1:05');
});

test('書き出すときの名前', () => {
  assert.equal(outputName('IMG_1234.MOV'), 'IMG_1234_x.mp4');
  assert.equal(outputName('動画.mp4'), '動画_x.mp4');
});
