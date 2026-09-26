// タイムライン：使うところを切り出し、テロップを置く
// 帯にはコマ送りの絵を並べる。時間はすべてマイクロ秒で扱う
// @ts-check

import { formatClock } from './progress.js';
import { t } from './i18n.js';

/** @typedef {import('./types.js').Cue} Cue */

// テロップの帯の色（足した順に使う）
const CUE_COLORS = ['#ff6b5e', '#16b9a6', '#ffb020', '#7c6cf0', '#f45fb0'];
// これより短いテロップは作らない
const MIN_CUE_US = 400_000;
// つまみで動かすときの刻み
const SNAP_US = 50_000;

export class Timeline {
  /**
   * @param {HTMLElement} root
   * @param {{ onTrim: (inUs: number, outUs: number) => void,
   *           onCues: () => void,
   *           onSelect: (id: string|null) => void,
   *           onSeek: (us: number) => void }} hooks
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.durationUs = 0;
    this.inUs = 0;
    this.outUs = 0;
    /** @type {Cue[]} */
    this.cues = [];
    /** @type {string|null} */
    this.selectedId = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;

    root.innerHTML = `
      <div class="tl">
        <div class="tl-strip" data-role="strip">
          <div class="tl-clip">
            <canvas class="tl-thumbs" data-role="thumbs"></canvas>
            <div class="tl-dim" data-role="dimLeft"></div>
            <div class="tl-dim" data-role="dimRight"></div>
          </div>
          <div class="tl-handle" data-role="handleIn"><i></i></div>
          <div class="tl-handle" data-role="handleOut"><i></i></div>
          <div class="tl-head" data-role="head"></div>
        </div>
        <div class="tl-lane" data-role="lane"></div>
        <div class="tl-ticks" data-role="ticks"></div>
      </div>`;
    /** @type {Record<string, HTMLElement>} */
    this.el = {};
    for (const node of root.querySelectorAll('[data-role]')) {
      this.el[/** @type {string} */ (node.getAttribute('data-role'))] = /** @type {HTMLElement} */ (node);
    }
    this.thumbs = /** @type {HTMLCanvasElement} */ (this.el.thumbs);
    this.bindDrag();
  }

  /** @param {HTMLVideoElement} video */
  setVideo(video) {
    this.video = video;
  }

  /**
   * @param {number} durationUs
   * @param {number} inUs
   * @param {number} outUs
   */
  setRange(durationUs, inUs, outUs) {
    this.durationUs = Math.max(1, durationUs);
    this.inUs = inUs;
    this.outUs = outUs;
    this.paint();
  }

  /** @param {Cue[]} cues */
  setCues(cues) {
    this.cues = cues;
    this.paintLane();
  }

  /** @param {string|null} id */
  select(id) {
    this.selectedId = id;
    this.paintLane();
  }

  /** 画面の位置（0〜1）を時刻にする @param {number} ratio */
  usAt(ratio) {
    return Math.round(Math.max(0, Math.min(1, ratio)) * this.durationUs);
  }

  /** 時刻を画面の位置（%）にする @param {number} us */
  pct(us) {
    return (us / this.durationUs) * 100;
  }

  /**
   * 押した場所の割合を返す
   * @param {PointerEvent} e
   */
  ratioOf(e) {
    const rect = this.el.strip.getBoundingClientRect();
    return (e.clientX - rect.left) / Math.max(1, rect.width);
  }

  bindDrag() {
    /** @type {{ kind: string, id?: string, grabUs?: number }|null} */
    let drag = null;

    const down = (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const handle = target.closest('[data-role=handleIn],[data-role=handleOut]');
      const block = target.closest('[data-cue]');
      if (handle) {
        drag = { kind: handle.getAttribute('data-role') === 'handleIn' ? 'in' : 'out' };
      } else if (block) {
        const id = /** @type {string} */ (block.getAttribute('data-cue'));
        this.hooks.onSelect(id);
        const edge = target.getAttribute('data-edge');
        const cue = this.cues.find((c) => c.id === id);
        drag = {
          kind: edge ? `cue-${edge}` : 'cue-move',
          id,
          grabUs: cue ? this.usAt(this.ratioOf(e)) - cue.startUs : 0,
        };
      } else if (target.closest('[data-role=strip]')) {
        drag = { kind: 'seek' };
        this.hooks.onSeek(this.usAt(this.ratioOf(e)));
      } else if (target.closest('[data-role=lane]')) {
        this.hooks.onSelect(null);
        return;
      } else {
        return;
      }
      this.root.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const move = (e) => {
      if (!drag) {
        return;
      }
      const us = snap(this.usAt(this.ratioOf(e)));
      if (drag.kind === 'seek') {
        this.hooks.onSeek(us);
        return;
      }
      if (drag.kind === 'in') {
        this.inUs = Math.min(us, this.outUs - MIN_CUE_US);
        this.inUs = Math.max(0, this.inUs);
        this.hooks.onTrim(this.inUs, this.outUs);
        this.paint();
        return;
      }
      if (drag.kind === 'out') {
        this.outUs = Math.max(us, this.inUs + MIN_CUE_US);
        this.outUs = Math.min(this.durationUs, this.outUs);
        this.hooks.onTrim(this.inUs, this.outUs);
        this.paint();
        return;
      }
      const cue = this.cues.find((c) => c.id === drag?.id);
      if (!cue) {
        return;
      }
      if (drag.kind === 'cue-move') {
        const width = cue.endUs - cue.startUs;
        cue.startUs = Math.max(0, Math.min(this.durationUs - width, us - (drag.grabUs || 0)));
        cue.endUs = cue.startUs + width;
      } else if (drag.kind === 'cue-start') {
        cue.startUs = Math.max(0, Math.min(us, cue.endUs - MIN_CUE_US));
      } else {
        cue.endUs = Math.min(this.durationUs, Math.max(us, cue.startUs + MIN_CUE_US));
      }
      this.paintLane();
      this.hooks.onCues();
    };

    const up = () => {
      drag = null;
    };

    this.root.addEventListener('pointerdown', down);
    this.root.addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  /** 全体を描き直す */
  paint() {
    const inPct = this.pct(this.inUs);
    const outPct = this.pct(this.outUs);
    this.el.dimLeft.style.width = `${inPct}%`;
    this.el.dimRight.style.left = `${outPct}%`;
    this.el.dimRight.style.width = `${Math.max(0, 100 - outPct)}%`;
    this.el.handleIn.style.left = `${inPct}%`;
    this.el.handleOut.style.left = `${outPct}%`;
    this.el.handleIn.dataset.time = formatClock(this.inUs);
    this.el.handleOut.dataset.time = formatClock(this.outUs);
    this.paintTicks();
    this.paintLane();
  }

  paintTicks() {
    const steps = 5;
    let html = '';
    for (let i = 0; i <= steps; i++) {
      html += `<span style="left:${(i / steps) * 100}%">${formatClock((this.durationUs * i) / steps)}</span>`;
    }
    this.el.ticks.innerHTML = html;
  }

  paintLane() {
    const lane = this.el.lane;
    lane.innerHTML = '';
    for (const [index, cue] of this.cues.entries()) {
      const block = document.createElement('div');
      block.className = 'tl-cue' + (cue.id === this.selectedId ? ' on' : '');
      block.dataset.cue = cue.id;
      block.style.left = `${this.pct(cue.startUs)}%`;
      block.style.width = `${Math.max(1.5, this.pct(cue.endUs - cue.startUs))}%`;
      block.style.setProperty('--c', CUE_COLORS[index % CUE_COLORS.length]);
      block.innerHTML = `<i data-edge="start"></i><span>${escapeHtml(cue.text || t('tl.empty'))}</span><i data-edge="end"></i>`;
      lane.appendChild(block);
    }
  }

  /** 再生位置の線を動かす */
  tick() {
    if (!this.video || !this.durationUs) {
      return;
    }
    const us = Math.round(this.video.currentTime * 1e6);
    this.el.head.style.left = `${this.pct(us)}%`;
  }

  /**
   * コマ送りの絵を作る。読み込み直後に一度だけ動かす
   * @param {HTMLVideoElement} video
   * @param {number} durationUs
   */
  async buildThumbnails(video, durationUs) {
    const count = 16;
    const h = 56;
    const ratio = (video.videoWidth || 16) / (video.videoHeight || 9);
    const w = Math.round(h * ratio);
    const canvas = this.thumbs;
    canvas.width = w * count;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const wasPlaying = !video.paused;
    video.pause();
    for (let i = 0; i < count; i++) {
      const t = (durationUs / 1e6) * ((i + 0.5) / count);
      try {
        await seek(video, t);
        ctx.drawImage(video, i * w, 0, w, h);
      } catch (e) {
        break;
      }
    }
    await seek(video, 0).catch(() => undefined);
    if (wasPlaying) {
      video.play().catch(() => undefined);
    }
  }
}

/**
 * @param {HTMLVideoElement} video
 * @param {number} seconds
 * @returns {Promise<void>}
 */
function seek(video, seconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('seek timeout')), 3000);
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = seconds;
  });
}

/** @param {number} us */
function snap(us) {
  return Math.round(us / SNAP_US) * SNAP_US;
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}
