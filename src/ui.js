// 画面の部品：切り替えボタン・仕上がりの下見・テロップの編集・注意書き
// @ts-check

import { t, lang } from './i18n.js';
import { formatBytes, formatClock } from './progress.js';

/** @typedef {import('./types.js').Plan} Plan */
/** @typedef {import('./types.js').Cue} Cue */
/** @typedef {import('./types.js').Warning} Warning */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`画面に ${id} がありません`);
  }
  return el;
}

/**
 * 切り替えボタンの並び。押すと onChange が呼ばれる
 * @param {HTMLElement} root
 * @param {string} value
 * @param {(value: string) => void} onChange
 */
export function segment(root, value, onChange) {
  const buttons = [...root.querySelectorAll('button')];
  const paint = (v) => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  paint(value);
  root.onclick = (e) => {
    const button = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!button || !(button instanceof HTMLButtonElement) || button.disabled) {
      return;
    }
    const v = button.dataset.v || '';
    paint(v);
    onChange(v);
  };
  return { set: paint };
}

/**
 * 「名前：値」の並びを書く
 * @param {HTMLElement} el
 * @param {[string, string][]} pairs
 */
export function renderMeta(el, pairs) {
  el.innerHTML = '';
  for (const [name, value] of pairs) {
    const span = document.createElement('span');
    span.innerHTML = `${escapeHtml(name)} <b>${escapeHtml(value)}</b>`;
    el.appendChild(span);
  }
}

/**
 * 注意書きを並べる
 * @param {HTMLElement} el
 * @param {Warning[]} warnings
 */
export function renderWarnings(el, warnings) {
  el.innerHTML = '';
  for (const w of warnings) {
    const div = document.createElement('div');
    div.className = `warn ${w.level}`;
    div.textContent = t(w.code, w.args || {});
    el.appendChild(div);
  }
}

/**
 * 選んでいるテロップの編集欄
 * @param {HTMLElement} root
 * @param {import('./types.js').Cue|null} cue
 * @param {{ onChange: () => void, onRemove: () => void }} hooks
 */
export function renderCueEditor(root, cue, hooks) {
  root.innerHTML = '';
  if (!cue) {
    const empty = document.createElement('span');
    empty.className = 'small';
    empty.textContent = t('tl.none');
    root.append(empty);
    return;
  }

  const text = document.createElement('input');
  text.type = 'text';
  text.value = cue.text;
  text.placeholder = t('cap.text');
  text.oninput = () => {
    cue.text = text.value;
    hooks.onChange();
  };

  const remove = document.createElement('button');
  remove.className = 'btn';
  remove.textContent = t('cap.remove');
  remove.onclick = hooks.onRemove;

  root.append(
    text,
    styleSeg(cue, hooks.onChange),
    positionSeg(cue, hooks.onChange),
    labelled(t('cap.size'), numberInput(cue.size, 0.5, 3, (v) => {
      cue.size = v;
      hooks.onChange();
    }, 0.1)),
    labelled(t('cap.nudge'), numberInput(cue.nudge, -0.4, 0.4, (v) => {
      cue.nudge = v;
      hooks.onChange();
    }, 0.02)),
    remove,
  );
}

/**
 * テロップの見せ方を選ぶ
 * @param {Cue} cue
 * @param {() => void} onChange
 */
function styleSeg(cue, onChange) {
  const seg = document.createElement('div');
  seg.className = 'seg mint';
  for (const style of /** @type {const} */ (['outline', 'bar', 'chip'])) {
    const button = document.createElement('button');
    button.dataset.v = style;
    button.textContent = t(`style.${style}`);
    button.className = cue.style === style ? 'on' : '';
    button.onclick = () => {
      cue.style = style;
      [...seg.children].forEach((c) => c.classList.toggle('on', c === button));
      onChange();
    };
    seg.append(button);
  }
  return seg;
}

/**
 * 上・中・下を選ぶ
 * @param {Cue} cue
 * @param {() => void} onChange
 */
function positionSeg(cue, onChange) {
  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const pos of /** @type {const} */ (['top', 'middle', 'bottom'])) {
    const button = document.createElement('button');
    button.dataset.v = pos;
    button.textContent = t(`pos.${pos}`);
    button.className = cue.position === pos ? 'on' : '';
    button.onclick = () => {
      cue.position = pos;
      [...seg.children].forEach((c) => c.classList.toggle('on', c === button));
      onChange();
    };
    seg.append(button);
  }
  return seg;
}

/**
 * @param {string} name
 * @param {HTMLElement} input
 */
function labelled(name, input) {
  const wrap = document.createElement('span');
  wrap.className = 'small';
  wrap.append(name + ' ', input);
  return wrap;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {(v: number) => void} onChange
 * @param {number} [step]
 */
function numberInput(value, min, max, onChange, step = 0.1) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(Math.round(value * 100) / 100);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.style.width = '72px';
  input.onchange = () => {
    const v = Math.min(max, Math.max(min, Number(input.value)));
    input.value = String(Math.round(v * 100) / 100);
    onChange(v);
  };
  return input;
}

/**
 * 仕上がりの下見。元の動画を流しながら、出来上がりの形で描く
 */
export class Preview {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('下見を描けません');
    }
    this.ctx = ctx;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {Plan|null} */
    this.plan = null;
    /** @type {import('./captions.js').CaptionBand[]} */
    this.bands = [];
    this.running = false;
  }

  /** @param {HTMLVideoElement} video */
  setVideo(video) {
    this.video = video;
  }

  /**
   * @param {Plan} plan
   * @param {import('./captions.js').CaptionBand[]} bands
   */
  setPlan(plan, bands) {
    this.plan = plan;
    this.bands = bands;
    // 下見は長辺640までで十分（見た目は変わらず、軽い）
    const scale = Math.min(1, 640 / Math.max(plan.video.width, plan.video.height));
    this.canvas.width = Math.max(2, Math.round(plan.video.width * scale));
    this.canvas.height = Math.max(2, Math.round(plan.video.height * scale));
    this.draw();
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    const loop = () => {
      if (!this.running) {
        return;
      }
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  draw() {
    const { ctx, canvas, plan, video } = this;
    if (!plan || !video || video.readyState < 2) {
      return;
    }
    const g = plan.video.geometry;
    const k = canvas.width / plan.video.width;
    const [r, gg, b] = plan.video.padRgba;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${r * 255} ${gg * 255} ${b * 255})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 動画の要素は回転を当てた見た目で再生されるので、そのまま使える
    if (plan.video.pad === 'blur' && g.needsPad) {
      ctx.filter = `blur(${Math.max(2, plan.video.blurRadiusPx * k * 0.6)}px)`;
      drawRect(ctx, video, g.background, k);
      ctx.filter = 'none';
    }
    const uv = g.sourceUv;
    ctx.drawImage(
      video,
      uv.x * video.videoWidth, uv.y * video.videoHeight, uv.w * video.videoWidth, uv.h * video.videoHeight,
      g.foreground.x * k, g.foreground.y * k, g.foreground.w * k, g.foreground.h * k,
    );

    // 下見では、元の時刻のまま見せる（テロップの時刻も元の動画に合わせて置いている）
    const tUs = Math.round(video.currentTime * 1e6);
    for (const band of this.bands) {
      if (tUs < band.startUs || tUs >= band.endUs) {
        continue;
      }
      ctx.save();
      ctx.translate(band.rect.x * k, band.rect.y * k);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (const op of band.ops) {
        if (op.kind !== 'text') {
          continue;
        }
        ctx.font = op.font.replace(/(\d+)px/, (_, px) => `${Math.max(6, Math.round(Number(px) * k))}px`);
        if (op.stroke) {
          ctx.strokeStyle = op.stroke;
          ctx.lineWidth = Math.max(1, op.strokeWidth * k);
          ctx.strokeText(op.text, op.x * k, op.y * k);
        }
        ctx.fillStyle = op.fill;
        ctx.fillText(op.text, op.x * k, op.y * k);
      }
      ctx.restore();
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} image
 * @param {import('./types.js').Rect} rect
 * @param {number} k
 */
function drawRect(ctx, image, rect, k) {
  ctx.drawImage(image, rect.x * k, rect.y * k, rect.w * k, rect.h * k);
}

/**
 * 入れた動画の中身を、読みやすい形にする
 * @param {import('./types.js').Probe} probe
 * @returns {[string, string][]}
 */
export function describeProbe(probe) {
  const v = probe.video;
  /** @type {[string, string][]} */
  const rows = [
    [t('in.file'), probe.fileName],
    [t('in.duration'), formatClock(probe.durationUs)],
    [t('in.size'), formatBytes(probe.fileSize)],
  ];
  if (v) {
    rows.push([t('in.codec'), `${v.codec.toUpperCase()} ${v.displayWidth}×${v.displayHeight}${v.rotation ? `（${t('in.rotated')} ${v.rotation}°）` : ''}`]);
    rows.push([t('in.fps'), `${Math.round(v.fps)} fps`]);
  }
  rows.push([t('in.audio'), probe.audio ? `${probe.audio.codec.toUpperCase()} ${probe.audio.channels}ch` : t('in.none')]);
  return rows;
}

/**
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

/**
 * 秒を「0:05」の形に
 * @param {number} us
 */
export function clock(us) {
  return formatClock(us);
}

export { lang };
