// 変換を1本まわす。Worker は毎回作って、終わったら必ず捨てる
// 捨てきることで、復号が詰まったときでも取り消しが必ず効く
// @ts-check

import { EtaEstimator } from './progress.js';

/** @typedef {import('./types.js').Plan} Plan */
/** @typedef {import('./types.js').CaptionBitmap} CaptionBitmap */

/**
 * @typedef {Object} ProgressView
 * @property {number} ratio          0〜1
 * @property {number|null} etaMs
 * @property {number} speed          実時間に対する倍率
 * @property {number} frames
 * @property {number} encodedBytes
 * @property {number} projectedBytes 最後まで行ったときの見込み
 */

/**
 * @typedef {Object} ConversionResult
 * @property {Blob} blob
 * @property {string} suggestedName
 * @property {number} width
 * @property {number} height
 * @property {number} durationUs
 * @property {number} frames
 * @property {number} elapsedMs
 * @property {string} codecString
 */

// 取り消しを頼んでから、返事を待つ上限。これを過ぎたら Worker ごと捨てる
const CANCEL_GRACE_MS = 1500;

/**
 * @param {{ file: File, plan: Plan, captions?: CaptionBitmap[], name?: string,
 *           onProgress?: (p: ProgressView) => void,
 *           onOpened?: (info: { codecString: string, width: number, height: number, audio: 'copy'|'drop' }) => void }} a
 * @returns {{ done: Promise<ConversionResult>, cancel: () => void }}
 */
export function startConversion(a) {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const eta = new EtaEstimator();
  const startedAt = performance.now();
  let settled = false;
  /** @type {number|undefined} */
  let killTimer;

  const finish = () => {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    worker.terminate();
  };

  const done = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'opened') {
        a.onOpened?.(msg);
        return;
      }
      if (msg.type === 'progress') {
        const view = eta.update({ mediaUs: msg.mediaUs, totalUs: msg.totalUs, nowMs: performance.now() });
        const ratio = view.ratio || 0.0001;
        a.onProgress?.({
          ratio: view.ratio,
          etaMs: view.etaMs,
          speed: view.speed,
          frames: msg.frames,
          encodedBytes: msg.encodedBytes,
          projectedBytes: Math.round(msg.encodedBytes / ratio),
        });
        return;
      }
      if (msg.type === 'done') {
        settled = true;
        finish();
        resolve({
          blob: new Blob([msg.buffer], { type: 'video/mp4' }),
          suggestedName: a.name || outputName(a.file.name),
          width: msg.width,
          height: msg.height,
          durationUs: msg.durationUs,
          frames: msg.frames,
          elapsedMs: Math.round(performance.now() - startedAt),
          codecString: msg.codecString,
        });
        return;
      }
      if (msg.type === 'cancelled') {
        settled = true;
        finish();
        reject(new CancelledError());
        return;
      }
      if (msg.type === 'error') {
        settled = true;
        finish();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      reject(new Error(event.message || '変換の途中で止まりました'));
    };
  });

  worker.postMessage({
    type: 'start',
    file: a.file,
    plan: a.plan,
    captions: a.captions || [],
  });

  const cancel = () => {
    if (settled) {
      return;
    }
    worker.postMessage({ type: 'cancel' });
    // 返事が来なければ、待たずに捨てる
    killTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
      }
    }, CANCEL_GRACE_MS);
  };

  return { done, cancel };
}

/** 取り消したときのしるし。ふつうのしくじりと見分けるために使う */
export class CancelledError extends Error {
  constructor() {
    super('取り消しました');
    this.name = 'CancelledError';
  }
}

/**
 * 元のファイル名から、書き出すときの名前を作る
 * @param {string} name
 * @returns {string}
 */
export function outputName(name) {
  const base = name.replace(/\.[^.]+$/, '') || 'video';
  return `${base}_x.mp4`;
}
