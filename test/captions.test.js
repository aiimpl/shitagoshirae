// テロップの区切り・折り返し・SRTの読み取りを確かめる
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptionTimeline,
  layoutCaptionSegment,
  wrapText,
  parseSrt,
  parseSrtTime,
  pickBand,
} from '../src/captions.js';

/** 文字幅を「1文字10px」として測るふりをする（ブラウザなしで確かめるため） */
const measure = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)?.[1] || 10);
  return [...text].length * size * 0.6;
};

/** @returns {import('../src/types.js').Cue} */
function cue(over) {
  return { id: 'a', text: 'こんにちは', startUs: 0, endUs: 3_000_000, position: 'bottom', size: 1, outline: true, ...over };
}

test('重なったテロップは、中身が変わる時点で区切られる', () => {
  const segments = buildCaptionTimeline([
    cue({ id: 'a', text: 'A', startUs: 0, endUs: 3_000_000 }),
    cue({ id: 'b', text: 'B', startUs: 2_000_000, endUs: 5_000_000, position: 'top' }),
  ]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((s) => [s.startUs, s.endUs, s.cues.length]), [
    [0, 2_000_000, 1],
    [2_000_000, 3_000_000, 2],
    [3_000_000, 5_000_000, 1],
  ]);
});

test('並びが違っても、同じ中身なら同じしるしになる', () => {
  const a = buildCaptionTimeline([cue({ id: 'x', text: 'A' }), cue({ id: 'y', text: 'B', position: 'top' })]);
  const b = buildCaptionTimeline([cue({ id: 'y', text: 'B', position: 'top' }), cue({ id: 'x', text: 'A' })]);
  assert.equal(a[0].key, b[0].key);
});

test('中身が空、または時間が逆のものは捨てる', () => {
  const segments = buildCaptionTimeline([
    cue({ text: '  ' }),
    cue({ text: 'ok', startUs: 5_000_000, endUs: 1_000_000 }),
  ]);
  assert.equal(segments.length, 0);
});

test('日本語は1文字ずつ折り返す', () => {
  const lines = wrapText('これはとても長い日本語の字幕です', 100, '700 20px sans-serif', measure);
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(''), 'これはとても長い日本語の字幕です');
});

test('英語は単語の途中で折らない', () => {
  const lines = wrapText('hello wonderful world', 130, '700 20px sans-serif', measure);
  for (const line of lines) {
    assert.ok(!/^[a-z]/.test(line) || ['hello', 'wonderful', 'world'].some((w) => line.startsWith(w)), line);
  }
  assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'hello wonderful world');
});

test('行の頭に句読点が来ないようにする', () => {
  const lines = wrapText('ここで区切る、つぎの行', 100, '700 20px sans-serif', measure);
  for (const line of lines) {
    assert.ok(!'、。'.includes(line[0]), `行頭が禁則文字: ${line}`);
  }
});

test('上と下のテロップは、別々の帯になる', () => {
  const segments = buildCaptionTimeline([
    cue({ id: 'a', text: '下のことば' }),
    cue({ id: 'b', text: '上のことば', position: 'top' }),
  ]);
  const bands = layoutCaptionSegment(segments[0], { width: 1080, height: 1920, fontFamily: 'sans-serif' }, measure);
  assert.equal(bands.length, 2);
  assert.ok(bands[0].rect.y < bands[1].rect.y);
});

test('帯の中の描き位置は、帯からはみ出さない', () => {
  const segments = buildCaptionTimeline([cue({ text: 'ここに字幕' })]);
  const out = { width: 1280, height: 720, fontFamily: 'sans-serif' };
  const [band] = layoutCaptionSegment(segments[0], out, measure);
  assert.ok(band.rect.x >= 0 && band.rect.y >= 0);
  assert.ok(band.rect.x + band.rect.w <= out.width);
  assert.ok(band.rect.y + band.rect.h <= out.height);
  for (const op of band.ops) {
    if (op.kind === 'text') {
      assert.ok(op.y >= 0 && op.y <= band.rect.h, `文字が帯の外: ${op.y}`);
    }
  }
});

test('SRT の時間を読む', () => {
  assert.equal(parseSrtTime('00:00:03,500'), 3_500_000);
  assert.equal(parseSrtTime('01:02:03.250'), (3600 + 120 + 3) * 1_000_000 + 250_000);
  assert.equal(parseSrtTime('こわれた'), null);
});

test('SRT を読む（BOM・改行コード・小数点の違いを吸収する）', () => {
  const srt = '﻿1\r\n00:00:00,000 --> 00:00:02,000\r\nはじめまして\r\n\r\n2\n00:00:02.000-->00:00:04,000\nこんにちは\nまた会いましょう\n';
  const { cues, errors } = parseSrt(srt);
  assert.equal(errors.length, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'はじめまして');
  assert.equal(cues[1].text, 'こんにちは\nまた会いましょう');
  assert.equal(cues[1].startUs, 2_000_000);
});

test('SRT の壊れた固まりは、飛ばして知らせる', () => {
  const { cues, errors } = parseSrt('1\nこわれている\n\n2\n00:00:01,000 --> 00:00:02,000\nok');
  assert.equal(cues.length, 1);
  assert.equal(errors.length, 1);
});

test('帯を探すとき、前に戻らずに進める', () => {
  const bands = [];
  for (let i = 0; i < 1000; i++) {
    bands.push({ startUs: i * 2_000_000, endUs: i * 2_000_000 + 1_000_000 });
  }
  let cursor = 0;
  let found = 0;
  for (let t = 0; t < 2_000_000_000; t += 200_000) {
    const r = pickBand(bands, t, cursor);
    cursor = r.cursor;
    if (r.index >= 0) {
      found++;
    }
  }
  assert.ok(found > 4000);
  assert.equal(pickBand(bands, 1_500_000, 0).index, -1);
});
