// 下調べと設定から、変換の計画をぜんぶ数字にする
// ここで作る Plan は Worker へそのまま渡すので、素の値だけで組み立てる（関数やクラスを入れない）
// @ts-check

import { planGeometry, MIN_ASPECT, MAX_ASPECT } from './geometry.js';

/** @typedef {import('./types.js').Probe} Probe */
/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').Plan} Plan */
/** @typedef {import('./types.js').PlanTrim} PlanTrim */
/** @typedef {import('./types.js').PlanAudio} PlanAudio */
/** @typedef {import('./types.js').AudioProbe} AudioProbe */
/** @typedef {import('./types.js').Warning} Warning */

// ---- Xの制限（出典つき。変わったらここだけ直す） ----
// https://docs.x.com/x-api/media/quickstart/best-practices
// https://help.x.com/en/using-x/x-videos
export const X = {
  minDurationUs: 500_000,        // 0.5秒以上
  maxDurationFreeUs: 140_000_000, // 無料アカウントは2分20秒
  maxBytesFree: 512 * 1024 * 1024, // 無料アカウントは512MB
  maxFps: 60,                    // 60fps以下
  webMaxFps: 40,                 // ウェブからの投稿は40fpsまで
  minAspect: MIN_ASPECT,         // 1:3
  maxAspect: MAX_ASPECT,         // 3:1
  audioMinBitrateBps: 128_000,   // AAC-LC 128kbps以上
  // 再生画質：無料アカウントは720pまで。1080p再生はPremiumのみ
  freePlaybackHeight: 720,
};

// 映像のビットレートの下限と上限（下限を割ると見るに耐えない。上限はXが再エンコードするので無駄）
const MIN_VIDEO_BPS = 300_000;
const MAX_VIDEO_BPS = 20_000_000;
// mp4の容れ物ぶんの余裕
const CONTAINER_OVERHEAD = 0.02;

/**
 * 画質優先のときのビットレート。画素あたりのビット数から決める
 * @param {{ width: number, height: number, fps: number, quality: 'low'|'medium'|'high' }} a
 * @returns {number}
 */
export function bitrateForQuality(a) {
  const bitsPerPixel = { low: 0.06, medium: 0.09, high: 0.14 }[a.quality];
  const raw = a.width * a.height * a.fps * bitsPerPixel;
  return clampBitrate(Math.round(raw / 100_000) * 100_000);
}

/**
 * ねらいのファイルサイズから、映像のビットレートを逆算する
 * @param {{ targetBytes: number, durationUs: number, audioBitrateBps: number }} a
 * @returns {{ videoBitrateBps: number, feasible: boolean, floorBps: number }}
 */
export function bitrateForTargetSize(a) {
  const seconds = a.durationUs / 1_000_000;
  if (seconds <= 0) {
    return { videoBitrateBps: MIN_VIDEO_BPS, feasible: false, floorBps: MIN_VIDEO_BPS };
  }
  const usableBits = a.targetBytes * 8 * (1 - CONTAINER_OVERHEAD);
  const total = usableBits / seconds;
  const video = Math.round((total - a.audioBitrateBps) / 100_000) * 100_000;
  return {
    videoBitrateBps: clampBitrate(video),
    feasible: video >= MIN_VIDEO_BPS,
    floorBps: MIN_VIDEO_BPS,
  };
}

/**
 * @param {{ videoBitrateBps: number, audioBitrateBps: number, durationUs: number }} a
 * @returns {number} バイト数の見積もり
 */
export function estimateOutputBytes(a) {
  const seconds = a.durationUs / 1_000_000;
  const bits = (a.videoBitrateBps + a.audioBitrateBps) * seconds;
  return Math.round((bits / 8) * (1 + CONTAINER_OVERHEAD));
}

/**
 * @param {number} bps
 * @returns {number}
 */
function clampBitrate(bps) {
  return Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, bps));
}

/**
 * 区間ひとつぶんの切り出し位置を、音声パケットの切れ目に合わせる
 * 音声の開始は「切り上げ」にする。こうすると出力の時刻が必ず0以上になり、編集リストが要らない
 * （映像はキーフレームまで戻って復号する必要があるが、それは mediabunny の samples() が受け持つ）
 * @param {{ inUs: number, outUs: number, durationUs: number,
 *           audioPacketUs: number, audioFirstUs: number, outStartUs?: number }} a
 * @returns {import('./types.js').PlanCut}
 */
export function planCut(a) {
  const inUs = Math.max(0, Math.min(a.inUs, a.durationUs));
  const outUs = Math.max(inUs, Math.min(a.outUs, a.durationUs));
  let audioInUs = inUs;
  let audioOutUs = outUs;
  if (a.audioPacketUs > 0) {
    const first = a.audioFirstUs;
    const packets = Math.ceil((inUs - first) / a.audioPacketUs);
    audioInUs = first + Math.max(0, packets) * a.audioPacketUs;
    const endPackets = Math.floor((outUs - first) / a.audioPacketUs);
    audioOutUs = first + Math.max(0, endPackets) * a.audioPacketUs;
    if (audioOutUs < audioInUs) {
      audioOutUs = audioInUs;
    }
  }
  return {
    inUs,
    outUs,
    outStartUs: a.outStartUs || 0,
    audioInUs,
    audioOutUs,
    avOffsetUs: audioInUs - inUs,
  };
}

/**
 * 使う区間をつないだときの、全体の計画を作る
 * 重なりや前後の入れ違いはここで整える
 * @param {{ segments: import('./types.js').Segment[], durationUs: number,
 *           audioPacketUs: number, audioFirstUs: number, speed?: number }} a
 * @returns {import('./types.js').PlanTrim}
 */
export function planCuts(a) {
  const speed = a.speed && a.speed > 0 ? a.speed : 1;
  const ranges = normalizeSegments(a.segments, a.durationUs);
  /** @type {import('./types.js').PlanCut[]} */
  const cuts = [];
  let outStartUs = 0;
  let avOffsetUs = 0;
  for (const range of ranges) {
    const cut = planCut({
      inUs: range.startUs,
      outUs: range.endUs,
      durationUs: a.durationUs,
      audioPacketUs: a.audioPacketUs,
      audioFirstUs: a.audioFirstUs,
      outStartUs,
    });
    if (cut.outUs <= cut.inUs) {
      continue;
    }
    cuts.push(cut);
    // 速さを当てた長さを足していく（2倍速なら半分の長さになる）
    outStartUs += Math.round((cut.outUs - cut.inUs) / speed);
    avOffsetUs = Math.max(avOffsetUs, cut.avOffsetUs);
  }
  return { cuts, durationUs: outStartUs, avOffsetUs, speed };
}

/**
 * 区間を、時刻の順に並べて重なりをまとめる
 * @param {import('./types.js').Segment[]} segments
 * @param {number} durationUs
 * @returns {{ startUs: number, endUs: number }[]}
 */
export function normalizeSegments(segments, durationUs) {
  const clean = (segments || [])
    .map((s) => ({
      startUs: Math.max(0, Math.min(s.startUs, durationUs)),
      endUs: Math.max(0, Math.min(s.endUs, durationUs)),
    }))
    .filter((s) => s.endUs > s.startUs)
    .sort((x, y) => x.startUs - y.startUs);
  /** @type {{ startUs: number, endUs: number }[]} */
  const out = [];
  for (const s of clean) {
    const last = out[out.length - 1];
    if (last && s.startUs <= last.endUs) {
      last.endUs = Math.max(last.endUs, s.endUs);
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * 元の動画での時刻を、出来上がりでの時刻に移す
 * 落とした区間にかかっていたら、残った部分だけに切り分ける
 * @param {number} startUs
 * @param {number} endUs
 * @param {import('./types.js').PlanCut[]} cuts
 * @param {number} [speed]
 * @returns {{ startUs: number, endUs: number }[]}
 */
export function toOutputTimes(startUs, endUs, cuts, speed = 1) {
  /** @type {{ startUs: number, endUs: number }[]} */
  const out = [];
  for (const cut of cuts) {
    const from = Math.max(startUs, cut.inUs);
    const to = Math.min(endUs, cut.outUs);
    if (to <= from) {
      continue;
    }
    out.push({
      startUs: cut.outStartUs + Math.round((from - cut.inUs) / speed),
      endUs: cut.outStartUs + Math.round((to - cut.inUs) / speed),
    });
  }
  return out;
}

/**
 * テロップの時刻を、元の動画の時刻から出来上がりの時刻に移す
 * 落とした区間にかかっていたら、残ったところだけに切り分ける。文字が空のものは捨てる
 * @param {import('./types.js').Cue[]} cues
 * @param {import('./types.js').PlanCut[]} cuts
 * @param {number} [speed]
 * @returns {import('./types.js').Cue[]}
 */
export function toOutputCues(cues, cuts, speed = 1) {
  return cues
    .filter((cue) => cue.text.trim() !== '')
    .flatMap((cue) => toOutputTimes(cue.startUs, cue.endUs, cuts, speed)
      .map((range) => ({ ...cue, id: `${cue.id}@${range.startUs}`, ...range })));
}

/**
 * 出だしと終わりのふわっと具合（0＝真っ暗、1＝そのまま）
 * @param {number} fadeUs  ふわっとさせる長さ。0なら何もしない
 * @param {number} outUs
 * @param {number} totalUs
 * @returns {number}
 */
export function fadeAt(fadeUs, outUs, totalUs) {
  if (!fadeUs) {
    return 1;
  }
  const fromEdge = Math.min(outUs, totalUs - outUs);
  const k = Math.max(0, Math.min(1, fromEdge / fadeUs));
  // 始めと終わりをゆるやかにする（一定の速さで暗くなるより自然に見える）
  return k * k * (3 - 2 * k);
}

/**
 * 音声をそのまま通せるか決める。通せるのは AAC-LC の1〜2チャンネルだけ
 * @param {AudioProbe|null} audio
 * @param {'copy'|'mute'} want
 * @returns {PlanAudio}
 */
export function decideAudioCopy(audio, want) {
  if (!audio) {
    return { mode: 'drop', reason: 'a.none', bitrateBps: 0 };
  }
  if (want === 'mute') {
    return { mode: 'drop', reason: 'a.muted', bitrateBps: 0 };
  }
  if (audio.codec !== 'aac' || !audio.codecString.startsWith('mp4a.40.2')) {
    return { mode: 'drop', reason: 'a.notAacLc', bitrateBps: 0 };
  }
  if (audio.channels < 1 || audio.channels > 2) {
    return { mode: 'drop', reason: 'a.multichannel', bitrateBps: 0 };
  }
  return { mode: 'copy', reason: '', bitrateBps: audio.bitrateBps || X.audioMinBitrateBps };
}

// H.264 の段階。[level_idc, 1秒あたりのマクロブロック数, 画面のマクロブロック数, ビットレート上限(bps)]
// High プロファイルの上限（cpbBrNalFactor 1250）を使う
const H264_LEVELS = [
  [0x1e, 40_500, 1620, 12_500_000],
  [0x1f, 108_000, 3600, 17_500_000],
  [0x20, 216_000, 5120, 25_000_000],
  [0x28, 245_760, 8192, 25_000_000],
  [0x29, 245_760, 8192, 62_500_000],
  [0x2a, 522_240, 8704, 62_500_000],
  [0x32, 589_824, 22_080, 168_750_000],
  [0x33, 983_040, 36_864, 300_000_000],
];

/**
 * 解像度・フレームレート・ビットレートから H.264 の段階を決める
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {number} bitrateBps
 * @returns {number} level_idc（0x28 なら 4.0）
 */
export function h264Level(width, height, fps, bitrateBps) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbsPerSecond = frameMbs * fps;
  for (const [level, maxMbps, maxFs, maxBr] of H264_LEVELS) {
    if (mbsPerSecond <= maxMbps && frameMbs <= maxFs && bitrateBps <= maxBr) {
      return level;
    }
  }
  return 0x33;
}

/**
 * 試すコーデック文字列を、良いほうから並べる
 * @param {{ width: number, height: number, fps: number, bitrateBps: number }} a
 * @returns {string[]}
 */
export function codecCandidates(a) {
  const level = h264Level(a.width, a.height, a.fps, a.bitrateBps).toString(16).padStart(2, '0');
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

/**
 * '#rrggbb' を 0〜1 の4つ組にする
 * @param {string} hex
 * @returns {[number, number, number, number]}
 */
export function parseColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return [0, 0, 0, 1];
  }
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/**
 * Xに上げられるかを見て、注意書きを並べる
 * @param {Plan} plan
 * @param {Probe} probe
 * @param {number} estimatedBytes
 * @returns {Warning[]}
 */
export function checkXLimits(plan, probe, estimatedBytes) {
  /** @type {Warning[]} */
  const out = [];
  const durationUs = plan.trim.durationUs;
  if (durationUs < X.minDurationUs) {
    out.push({ level: 'block', code: 'w.tooShort' });
  }
  if (durationUs > X.maxDurationFreeUs) {
    out.push({ level: 'warn', code: 'w.durationOverFree', args: { seconds: Math.round(durationUs / 1e6) } });
  }
  if (estimatedBytes > X.maxBytesFree) {
    out.push({ level: 'warn', code: 'w.sizeOverFree', args: { mb: Math.round(estimatedBytes / 1024 / 1024) } });
  }
  const aspect = plan.video.width / plan.video.height;
  if (aspect < X.minAspect || aspect > X.maxAspect) {
    out.push({ level: 'block', code: 'w.aspectOut' });
  }
  if (plan.video.geometry.clampedAspect) {
    out.push({ level: 'info', code: 'w.aspectClamped' });
  }
  if (probe.video && Math.round(probe.video.fps * (plan.trim.speed || 1)) > plan.video.maxFps) {
    out.push({ level: 'info', code: 'w.fpsDropped', args: { fps: plan.video.maxFps } });
  }
  // 再生画質は短いほうの辺で決まる（縦動画の 720x1280 は「720p」）
  if (Math.min(plan.video.width, plan.video.height) > X.freePlaybackHeight) {
    out.push({ level: 'info', code: 'w.playback720' });
  }
  if (plan.audio.mode === 'drop' && plan.audio.reason !== 'a.none' && plan.audio.reason !== 'a.muted') {
    out.push({ level: 'warn', code: plan.audio.reason });
  }
  if (probe.video?.hdr) {
    out.push({ level: 'warn', code: 'w.hdr' });
  }
  if (probe.video && !probe.video.decodable) {
    out.push({ level: 'block', code: 'w.cannotDecode', args: { codec: probe.video.codec } });
  }
  if (plan.trim.cuts.length === 0) {
    out.push({ level: 'block', code: 'w.noRange' });
  }
  if (plan.trim.avOffsetUs > 5000) {
    out.push({ level: 'info', code: 'w.avOffset', args: { ms: Math.round(plan.trim.avOffsetUs / 1000) } });
  }
  return out;
}

/**
 * 書き出すフレームレートを決める
 * Xのウェブ投稿は40fpsまでなので、それを超えるときは落とす。
 * 落とすときは元を割り切れる値（60→30、50→25、48→24）にする。
 * 50→30 のように割り切れないと、捨てるコマの間隔が不ぞろいになって動きがカクつく
 * @param {number} sourceFps
 * @param {number} wantFps
 * @returns {number}
 */
export function outputFps(sourceFps, wantFps) {
  const fps = Math.min(wantFps, X.maxFps, sourceFps);
  if (fps <= X.webMaxFps) {
    return fps;
  }
  // 元のコマを n 枚に1枚使う。いちばん小さい n で40以下になるものを選ぶ
  const divisor = Math.ceil(sourceFps / X.webMaxFps);
  const even = Math.round((sourceFps / divisor) * 1000) / 1000;
  // 45fps（30fpsの1.5倍速）のように割ると半端になる値は、なめらかさを優先して30に丸める
  return even >= 24 ? even : 30;
}

/**
 * 短いほうの辺の目安を決める
 * @param {'720p'|'1080p'|'source'} resolution
 * @param {number} dispW
 * @param {number} dispH
 * @returns {number}
 */
export function baseSideFor(resolution, dispW, dispH) {
  if (resolution === '720p') {
    return 720;
  }
  if (resolution === '1080p') {
    return 1080;
  }
  return Math.min(1080, Math.min(dispW, dispH));
}

/**
 * 下調べと設定から、変換の計画を作る
 * @param {Probe} probe
 * @param {Settings} settings
 * @returns {Plan}
 */
export function buildPlan(probe, settings) {
  const v = probe.video;
  if (!v) {
    return {
      video: emptyVideoPlan(),
      audio: { mode: 'drop', reason: 'a.none', bitrateBps: 0 },
      trim: { cuts: [], durationUs: 0, avOffsetUs: 0, speed: 1 },
      warnings: [{ level: 'block', code: 'w.noVideo' }],
      blocked: true,
    };
  }

  // 速さを変えると音は作り直しになるので、この道具では音を消す
  const wantAudio = settings.speed !== 1 ? 'mute' : settings.audio;
  const audio = settings.speed !== 1 && probe.audio
    ? { mode: /** @type {const} */ ('drop'), reason: 'a.speed', bitrateBps: 0 }
    : decideAudioCopy(probe.audio, wantAudio);
  const trim = planCuts({
    speed: settings.speed || 1,
    segments: settings.segments,
    durationUs: probe.durationUs,
    audioPacketUs: audio.mode === 'copy' && probe.audio ? probe.audio.packetUs : 0,
    audioFirstUs: probe.audio ? probe.audio.firstPacketUs : 0,
  });

  const geometry = planGeometry(
    { codedWidth: v.codedWidth, codedHeight: v.codedHeight, rotation: v.rotation },
    {
      shape: settings.shape,
      pad: settings.pad,
      baseSide: baseSideFor(settings.resolution, v.displayWidth, v.displayHeight),
      cropX: settings.cropX,
      cropY: settings.cropY,
    },
  );

  // 速さを上げると、1秒あたりのコマ数も増える
  const sourceFps = Math.max(1, Math.round(v.fps * (settings.speed || 1)));
  const maxFps = outputFps(sourceFps, settings.maxFps);
  const bitrateBps = settings.sizeMode === 'size'
    ? bitrateForTargetSize({
      targetBytes: settings.targetBytes,
      durationUs: trim.durationUs,
      audioBitrateBps: audio.bitrateBps,
    }).videoBitrateBps
    : bitrateForQuality({
      width: geometry.outWidth,
      height: geometry.outHeight,
      fps: maxFps,
      quality: settings.quality,
    });

  const shortSide = Math.min(geometry.outWidth, geometry.outHeight);
  /** @type {import('./types.js').PlanVideo} */
  const video = {
    width: geometry.outWidth,
    height: geometry.outHeight,
    geometry,
    pad: settings.pad,
    padRgba: parseColor(settings.padColor),
    blurRadiusPx: Math.max(2, Math.round(shortSide * 0.02 * (0.5 + settings.blurStrength))),
    bitrateBps,
    codecCandidates: codecCandidates({
      width: geometry.outWidth,
      height: geometry.outHeight,
      fps: maxFps,
      bitrateBps,
    }),
    maxFps,
    // 元が同じフレームレートでも取りこぼさないよう、少しだけ緩める
    minFrameDeltaUs: Math.floor((1_000_000 / maxFps) * 0.95),
    keyframeIntervalUs: 2_000_000,
    // 出だしと終わりをふわっとさせる。短い動画では短くする
    fadeUs: settings.fade ? Math.min(400_000, Math.floor(trim.durationUs / 6)) : 0,
  };

  /** @type {Plan} */
  const plan = { video, audio, trim, warnings: [], blocked: false };
  const estimated = estimateOutputBytes({
    videoBitrateBps: bitrateBps,
    audioBitrateBps: audio.bitrateBps,
    durationUs: trim.durationUs,
  });
  plan.warnings = checkXLimits(plan, probe, estimated);
  plan.blocked = plan.warnings.some((w) => w.level === 'block');
  return plan;
}

/**
 * @returns {import('./types.js').PlanVideo}
 */
function emptyVideoPlan() {
  return {
    width: 2,
    height: 2,
    geometry: planGeometry({ codedWidth: 2, codedHeight: 2, rotation: 0 }, { shape: 'keep', pad: 'color', baseSide: 2 }),
    pad: 'color',
    padRgba: [0, 0, 0, 1],
    blurRadiusPx: 2,
    bitrateBps: MIN_VIDEO_BPS,
    codecCandidates: [],
    maxFps: 30,
    minFrameDeltaUs: 33_333,
    keyframeIntervalUs: 2_000_000,
    fadeUs: 0,
  };
}
