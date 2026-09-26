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

/** 先に用意しておく係。押してから読み込むと、その瞬間に回線がないと始められない @type {Worker|null} */
let warm = null;

/**
 * 変換の係を先に用意しておく。設定をいじっている間に読み込みが終わる
 */
export function warmUp() {
  if (!warm) {
    warm = makeWorker();
  }
}

/** @returns {Worker} */
function makeWorker() {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

/** 用意してあればそれを使う @returns {Worker} */
function takeWorker() {
  const found = warm;
  warm = null;
  return found || makeWorker();
}

/**
 * @param {{ file: File, plan: Plan, captions?: CaptionBitmap[], name?: string,
 *           onProgress?: (p: ProgressView) => void,
 *           onOpened?: (info: { codecString: string, width: number, height: number, audio: 'copy'|'drop' }) => void }} a
 * @returns {{ done: Promise<ConversionResult>, cancel: () => void }}
 */
export function startConversion(a) {
  const worker = takeWorker();
  const eta = new EtaEstimator();
  const startedAt = performance.now();
  let settled = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let killTimer;
  /** @type {(value: ConversionResult) => void} */
  let resolveDone = () => undefined;
  /** @type {(err: Error) => void} */
  let rejectDone = () => undefined;
  /** @type {Promise<ConversionResult>} */
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  /**
   * 結果を一度だけ返し、Worker を捨てる
   * @param {() => void} report
   */
  const settle = (report) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(killTimer);
    worker.terminate();
    report();
  };

  worker.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'opened':
        a.onOpened?.(msg);
        return;
      case 'progress': {
        const view = eta.update({ mediaUs: msg.mediaUs, totalUs: msg.totalUs, nowMs: performance.now() });
        a.onProgress?.({
          ratio: view.ratio,
          etaMs: view.etaMs,
          speed: view.speed,
          frames: msg.frames,
          encodedBytes: msg.encodedBytes,
          projectedBytes: Math.round(msg.encodedBytes / (view.ratio || 0.0001)),
        });
        return;
      }
      case 'done':
        settle(() => resolveDone({
          blob: new Blob([msg.buffer], { type: 'video/mp4' }),
          suggestedName: a.name || outputName(a.file.name),
          width: msg.width,
          height: msg.height,
          durationUs: msg.durationUs,
          frames: msg.frames,
          elapsedMs: Math.round(performance.now() - startedAt),
          codecString: msg.codecString,
        }));
        return;
      case 'cancelled':
        settle(() => rejectDone(new CancelledError()));
        return;
      case 'error':
        settle(() => rejectDone(new Error(msg.message)));
    }
  };
  worker.onerror = (event) => {
    settle(() => rejectDone(new Error(event.message || '変換の途中で止まりました')));
  };

  worker.postMessage({
    type: 'start',
    file: a.file,
    plan: a.plan,
    captions: a.captions || [],
  });

  const cancel = () => {
    if (settled || killTimer !== undefined) {
      return;
    }
    worker.postMessage({ type: 'cancel' });
    // 返事が来なければ、待たずに捨てる。そのときも取り消しとして返す（画面が変換中のまま残らないように）
    killTimer = setTimeout(() => settle(() => rejectDone(new CancelledError())), CANCEL_GRACE_MS);
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
