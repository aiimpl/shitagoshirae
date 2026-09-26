// 進み具合から残り時間を見積もる。数値の見せ方もここにまとめる
// @ts-check

/**
 * 直近の速さを重く見る見積もり（急に速さが変わっても追随する）
 */
export class EtaEstimator {
  /**
   * @param {{ halfLifeMs?: number }} [opts] 速さの記憶が半分になるまでの時間
   */
  constructor(opts = {}) {
    this.halfLifeMs = opts.halfLifeMs ?? 2000;
    /** @type {number|null} */
    this.lastMs = null;
    this.lastMedia = 0;
    /** 1ミリ秒あたりに進む映像の長さ（マイクロ秒） */
    this.speed = 0;
  }

  /**
   * @param {{ mediaUs: number, totalUs: number, nowMs: number }} s
   * @returns {{ ratio: number, etaMs: number|null, speed: number }}
   */
  update(s) {
    const ratio = Math.max(0, Math.min(1, s.totalUs > 0 ? s.mediaUs / s.totalUs : 0));
    if (this.lastMs === null) {
      this.lastMs = s.nowMs;
      this.lastMedia = s.mediaUs;
      return { ratio, etaMs: null, speed: 0 };
    }
    const dt = s.nowMs - this.lastMs;
    if (dt <= 0) {
      return { ratio, etaMs: this.etaFrom(s), speed: this.speed };
    }
    const dMedia = Math.max(0, s.mediaUs - this.lastMedia);
    const instant = dMedia / dt;
    const weight = 1 - Math.pow(0.5, dt / this.halfLifeMs);
    this.speed = this.speed === 0 ? instant : this.speed + (instant - this.speed) * weight;
    this.lastMs = s.nowMs;
    this.lastMedia = s.mediaUs;
    return { ratio, etaMs: this.etaFrom(s), speed: this.speed };
  }

  /**
   * @param {{ mediaUs: number, totalUs: number }} s
   * @returns {number|null}
   */
  etaFrom(s) {
    if (this.speed <= 0) {
      return null;
    }
    const left = Math.max(0, s.totalUs - s.mediaUs);
    return Math.round(left / this.speed);
  }
}

/**
 * バイト数を読みやすくする
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(0)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 残り時間を読みやすくする
 * @param {number|null} ms
 * @param {'ja'|'en'} lang
 * @returns {string}
 */
export function formatEta(ms, lang) {
  if (ms === null || !isFinite(ms)) {
    return lang === 'ja' ? '計算中' : 'estimating';
  }
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (lang === 'ja') {
    return m > 0 ? `残り約${m}分${s}秒` : `残り約${s}秒`;
  }
  return m > 0 ? `about ${m}m ${s}s left` : `about ${s}s left`;
}

/**
 * 秒を 0:00 の形にする
 * @param {number} us
 * @returns {string}
 */
export function formatClock(us) {
  const total = Math.max(0, Math.round(us / 1_000_000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
