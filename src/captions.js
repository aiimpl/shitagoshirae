// テロップ：時間で区切る・折り返す・SRTを読む。実際に描くのは caption-raster.js
// 文字幅の測り方を外から受け取るので、ブラウザなしで確かめられる
// @ts-check

/** @typedef {import('./types.js').Cue} Cue */
/** @typedef {import('./types.js').Rect} Rect */

/**
 * @typedef {{ kind: 'text', text: string, x: number, y: number, font: string,
 *             fill: string, stroke: string|null, strokeWidth: number }
 *          |{ kind: 'rect', x: number, y: number, w: number, h: number, fill: string }} DrawOp
 */

/**
 * @typedef {Object} CaptionSegment
 * @property {number} startUs
 * @property {number} endUs
 * @property {Cue[]} cues
 * @property {string} key    中身が同じなら同じ値になる
 */

/**
 * @typedef {Object} CaptionBand
 * @property {string} key
 * @property {number} startUs
 * @property {number} endUs
 * @property {Rect} rect     出力画素の座標
 * @property {DrawOp[]} ops  帯の中の座標
 */

// 行の頭に置かない文字（日本語の禁則）
const NO_LINE_START = '、。，．・）］｝」』〉》〕｠!?,.:;！？：；ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー';
// 画面の端から空ける割合
const SAFE_INSET = 0.06;

/**
 * 重なりを考えて、出す中身が変わらない区間に切り分ける
 * @param {Cue[]} cues
 * @returns {CaptionSegment[]}
 */
export function buildCaptionTimeline(cues) {
  const valid = cues.filter((c) => c.text.trim() !== '' && c.endUs > c.startUs);
  if (valid.length === 0) {
    return [];
  }
  const edges = new Set();
  for (const c of valid) {
    edges.add(c.startUs);
    edges.add(c.endUs);
  }
  const points = [...edges].sort((a, b) => a - b);
  /** @type {CaptionSegment[]} */
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const startUs = points[i];
    const endUs = points[i + 1];
    const active = valid.filter((c) => c.startUs <= startUs && c.endUs >= endUs);
    if (active.length === 0) {
      continue;
    }
    out.push({ startUs, endUs, cues: active, key: keyOf(active) });
  }
  return out;
}

/**
 * 中身から、同じ絵かどうかを見分ける文字列を作る
 * @param {Cue[]} cues
 * @returns {string}
 */
function keyOf(cues) {
  return cues
    .map((c) => `${c.position}|${c.size}|${c.outline ? 1 : 0}|${c.color || ''}|${c.outlineColor || ''}|${c.text}`)
    .sort()
    .join('');
}

/**
 * 1区間ぶんを帯に組む。位置（上・中・下）ごとに1枚になる
 * @param {CaptionSegment} segment
 * @param {{ width: number, height: number, fontFamily: string }} out
 * @param {(text: string, font: string) => number} measureText
 * @returns {CaptionBand[]}
 */
export function layoutCaptionSegment(segment, out, measureText) {
  /** @type {CaptionBand[]} */
  const bands = [];
  for (const position of /** @type {const} */ (['top', 'middle', 'bottom'])) {
    const cues = segment.cues.filter((c) => c.position === position);
    if (cues.length === 0) {
      continue;
    }
    bands.push(layoutOne(cues, position, segment, out, measureText));
  }
  return bands;
}

/**
 * @param {Cue[]} cues
 * @param {'top'|'middle'|'bottom'} position
 * @param {CaptionSegment} segment
 * @param {{ width: number, height: number, fontFamily: string }} out
 * @param {(text: string, font: string) => number} measureText
 * @returns {CaptionBand}
 */
function layoutOne(cues, position, segment, out, measureText) {
  const maxWidth = Math.round(out.width * (1 - SAFE_INSET * 2));
  /** @type {{ text: string, font: string, size: number, cue: Cue }[]} */
  const lines = [];
  for (const cue of cues) {
    const size = Math.max(14, Math.round(out.height * 0.05 * (cue.size || 1)));
    const font = `700 ${size}px ${out.fontFamily}`;
    for (const text of wrapText(cue.text, maxWidth, font, measureText)) {
      lines.push({ text, font, size, cue });
    }
  }
  const pad = Math.round(out.height * 0.012);
  let width = 0;
  let height = pad;
  for (const line of lines) {
    width = Math.max(width, Math.ceil(measureText(line.text, line.font)) + pad * 2);
    height += Math.round(line.size * 1.35);
  }
  height += pad;
  width = Math.min(out.width, Math.max(width, 2));

  const x = Math.round((out.width - width) / 2);
  const y = position === 'top'
    ? Math.round(out.height * SAFE_INSET)
    : position === 'middle'
      ? Math.round((out.height - height) / 2)
      // 下は、Xの画面で文字や操作が重なるぶんだけ上げる
      : Math.round(out.height * (1 - SAFE_INSET * 1.6) - height);

  /** @type {DrawOp[]} */
  const ops = [];
  let cursorY = pad;
  for (const line of lines) {
    const lineHeight = Math.round(line.size * 1.35);
    ops.push({
      kind: 'text',
      text: line.text,
      x: Math.round(width / 2),
      y: cursorY + Math.round(lineHeight / 2),
      font: line.font,
      fill: line.cue.color || '#ffffff',
      stroke: line.cue.outline === false ? null : (line.cue.outlineColor || '#000000'),
      strokeWidth: Math.max(2, Math.round(line.size * 0.14)),
    });
    cursorY += lineHeight;
  }

  return {
    key: `${segment.key}|${position}|${out.width}x${out.height}`,
    startUs: segment.startUs,
    endUs: segment.endUs,
    rect: { x, y: Math.max(0, y), w: width, h: height },
    ops,
  };
}

/**
 * 折り返す。日本語は1文字ずつ、英語は単語の切れ目で折る
 * @param {string} text
 * @param {number} maxWidth
 * @param {string} font
 * @param {(text: string, font: string) => number} measureText
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, font, measureText) {
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const next = line + ch;
    if (line === '' || measureText(next, font) <= maxWidth) {
      line = next;
      continue;
    }
    const lastSpace = line.lastIndexOf(' ');
    if (lastSpace > 0 && /[0-9A-Za-z]/.test(ch) && /[0-9A-Za-z]/.test(line[line.length - 1])) {
      // 英単語の途中では折らない
      lines.push(line.slice(0, lastSpace));
      line = line.slice(lastSpace + 1) + ch;
      continue;
    }
    if (NO_LINE_START.includes(ch) && line.length > 1) {
      // 行の頭に置けない文字は、ひとつ前の文字ごと次の行へ送る
      lines.push(line.slice(0, -1));
      line = line.slice(-1) + ch;
      continue;
    }
    lines.push(line);
    line = ch;
  }
  if (line !== '') {
    lines.push(line);
  }
  return lines;
}

/**
 * SRT を読む。読めない行は飛ばして、その旨を返す
 * @param {string} text
 * @returns {{ cues: Cue[], errors: string[] }}
 */
export function parseSrt(text) {
  /** @type {Cue[]} */
  const cues = [];
  /** @type {string[]} */
  const errors = [];
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = body.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) {
      continue;
    }
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) {
      errors.push(`時間の行がありません: ${lines[0].slice(0, 20)}`);
      continue;
    }
    const times = timeLine.split('-->').map((t) => parseSrtTime(t));
    if (times[0] === null || times[1] === null || times[1] <= times[0]) {
      errors.push(`時間を読めません: ${timeLine.trim()}`);
      continue;
    }
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    if (textLines.length === 0) {
      continue;
    }
    cues.push({
      id: `srt${cues.length}`,
      text: textLines.join('\n'),
      startUs: times[0],
      endUs: times[1],
      position: 'bottom',
      size: 1,
      outline: true,
    });
  }
  return { cues, errors };
}

/**
 * '00:00:03,500' をマイクロ秒にする
 * @param {string} s
 * @returns {number|null}
 */
export function parseSrtTime(s) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
  if (!m) {
    return null;
  }
  const ms = Number(m[4].padEnd(3, '0'));
  return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + ms) * 1000;
}

/**
 * いまの時刻に出す帯を探す。前へ戻らない探し方なので、1本ぶん通しても速い
 * @param {{ startUs: number, endUs: number }[]} bands
 * @param {number} tUs
 * @param {number} cursor
 * @returns {{ index: number, cursor: number }}
 */
export function pickBand(bands, tUs, cursor) {
  let i = Math.max(0, cursor);
  while (i < bands.length && bands[i].endUs <= tUs) {
    i++;
  }
  if (i < bands.length && bands[i].startUs <= tUs && tUs < bands[i].endUs) {
    return { index: i, cursor: i };
  }
  return { index: -1, cursor: i };
}
