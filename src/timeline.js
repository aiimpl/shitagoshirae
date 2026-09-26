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
   * @param {{ onSegments: () => void,
   *           onCues: () => void,
   *           onSelect: (kind: 'cue'|'segment'|null, id: string|null) => void,
   *           onSeek: (us: number) => void }} hooks
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.durationUs = 0;
    /** @type {import('./types.js').Segment[]} */
    this.segments = [];
    /** @type {Cue[]} */
    this.cues = [];
    /** @type {string|null} */
    this.selectedCue = null;
    /** @type {string|null} */
    this.selectedSegment = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;

    root.innerHTML = `
      <div class="tl">
        <div class="tl-strip" data-role="strip">
          <div class="tl-clip">
            <canvas class="tl-thumbs" data-role="thumbs"></canvas>
            <div data-role="gaps"></div>
          </div>
          <div data-role="handles"></div>
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
   * @param {import('./types.js').Segment[]} segments
   */
  setRange(durationUs, segments) {
    this.durationUs = Math.max(1, durationUs);
    this.segments = segments;
    this.paint();
  }

  /** @param {import('./types.js').Segment[]} segments */
  setSegments(segments) {
    this.segments = segments;
    this.paint();
  }

  /** @param {Cue[]} cues */
  setCues(cues) {
    this.cues = cues;
    this.paintLane();
  }

  /**
   * @param {'cue'|'segment'|null} kind
   * @param {string|null} id
   */
  select(kind, id) {
    this.selectedCue = kind === 'cue' ? id : null;
    this.selectedSegment = kind === 'segment' ? id : null;
    this.paint();
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
      const handle = target.closest('[data-seg]');
      const block = target.closest('[data-cue]');
      if (handle) {
        const id = /** @type {string} */ (handle.getAttribute('data-seg'));
        this.hooks.onSelect('segment', id);
        drag = { kind: handle.getAttribute('data-edge') === 'start' ? 'seg-start' : 'seg-end', id };
      } else if (block) {
        const id = /** @type {string} */ (block.getAttribute('data-cue'));
        this.hooks.onSelect('cue', id);
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
        this.hooks.onSelect(null, null);
        return;
      } else {
        return;
      }
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch (err) {
        // 押した指を捕まえられない場合（合成した出来事など）は、そのまま進める
      }
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
      if (drag.kind.startsWith('seg-')) {
        const segment = this.segments.find((x) => x.id === drag?.id);
        if (!segment) {
          return;
        }
        if (drag.kind === 'seg-start') {
          segment.startUs = Math.max(0, Math.min(us, segment.endUs - MIN_CUE_US));
        } else {
          segment.endUs = Math.min(this.durationUs, Math.max(us, segment.startUs + MIN_CUE_US));
        }
        this.paint();
        this.hooks.onSegments();
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
    this.paintSegments();
    this.paintTicks();
    this.paintLane();
  }

  /** 使う区間と、落とすところを描く */
  paintSegments() {
    const sorted = [...this.segments].sort((a, b) => a.startUs - b.startUs);
    // 使わないところに、暗い板を置く
    let gaps = '';
    let cursor = 0;
    for (const s of sorted) {
      if (s.startUs > cursor) {
        gaps += `<div class="tl-dim" style="left:${this.pct(cursor)}%;width:${this.pct(s.startUs - cursor)}%"></div>`;
      }
      cursor = Math.max(cursor, s.endUs);
    }
    if (cursor < this.durationUs) {
      gaps += `<div class="tl-dim" style="left:${this.pct(cursor)}%;width:${this.pct(this.durationUs - cursor)}%"></div>`;
    }
    this.el.gaps.innerHTML = gaps;

    let handles = '';
    for (const s of sorted) {
      const on = s.id === this.selectedSegment ? ' on' : '';
      handles += `<div class="tl-handle${on}" data-seg="${s.id}" data-edge="start" data-time="${formatClock(s.startUs)}" style="left:${this.pct(s.startUs)}%"><i></i></div>`;
      handles += `<div class="tl-handle${on}" data-seg="${s.id}" data-edge="end" data-time="${formatClock(s.endUs)}" style="left:${this.pct(s.endUs)}%"><i></i></div>`;
    }
    this.el.handles.innerHTML = handles;
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
      block.className = 'tl-cue' + (cue.id === this.selectedCue ? ' on' : '');
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
   * 下見とは別の動画要素を使う（同じものを使うと、下見の再生位置を奪ってしまう）
   * @param {string} src
   * @param {number} durationUs
   */
  async buildThumbnails(src, durationUs) {
    const video = document.createElement('video');
    video.src = src;
    video.muted = true;
    video.preload = 'auto';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('読み込めません')), 8000);
        video.addEventListener('loadeddata', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
        video.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('読み込めません'));
        }, { once: true });
      });
      await this.drawThumbnails(video, durationUs);
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {number} durationUs
   */
  async drawThumbnails(video, durationUs) {
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
    for (let i = 0; i < count; i++) {
      const at = (durationUs / 1e6) * ((i + 0.5) / count);
      try {
        await seek(video, at);
        ctx.drawImage(video, i * w, 0, w, h);
      } catch (e) {
        break;
      }
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
