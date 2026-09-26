// 入れられたファイルの中身を調べる。画素には触らない
// @ts-check

import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
} from '../vendor/mediabunny/mediabunny.mjs';

/** @typedef {import('./types.js').Probe} Probe */
/** @typedef {import('./types.js').VideoProbe} VideoProbe */
/** @typedef {import('./types.js').AudioProbe} AudioProbe */
/** @typedef {import('./types.js').Rotation} Rotation */

/** 秒（小数）をマイクロ秒（整数）にする。時刻の計算は必ず整数で行う */
export function toUs(seconds) {
  return Math.round(seconds * 1_000_000);
}

/**
 * ファイルを調べて、画面に出す材料をそろえる
 * @param {File|Blob} file
 * @returns {Promise<Probe>}
 */
export async function probeFile(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();
    const durationSec = await input.computeDuration();
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    return {
      fileName: file instanceof File ? file.name : 'video',
      fileSize: file.size,
      container: format.name,
      durationUs: toUs(durationSec),
      video: videoTrack ? await probeVideo(videoTrack) : null,
      audio: audioTrack ? await probeAudio(audioTrack) : null,
    };
  } finally {
    input.dispose?.();
  }
}

/**
 * @param {import('../vendor/mediabunny/mediabunny.mjs').InputVideoTrack} track
 * @returns {Promise<VideoProbe>}
 */
async function probeVideo(track) {
  const [codec, codecString, codedWidth, codedHeight, rotation, displayWidth, displayHeight, color, stats, decodable] =
    await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getCodedWidth(),
      track.getCodedHeight(),
      track.getRotation(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getColorSpace(),
      track.computePacketStats(120),
      track.canDecode(),
    ]);
  const fps = stats.averagePacketRate || 30;
  return {
    codec: codec || 'unknown',
    codecString: codecString || '',
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation: /** @type {Rotation} */ (rotation),
    fps: Math.round(fps * 1000) / 1000,
    bitrateBps: Math.round(stats.averageBitrate || 0),
    hdr: isHdr(color),
    decodable,
  };
}

/**
 * @param {import('../vendor/mediabunny/mediabunny.mjs').InputAudioTrack} track
 * @returns {Promise<AudioProbe>}
 */
async function probeAudio(track) {
  const [codec, codecString, channels, sampleRate, stats] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getNumberOfChannels(),
    track.getSampleRate(),
    track.computePacketStats(120),
  ]);
  const sink = new EncodedPacketSink(track);
  const first = await sink.getFirstPacket();
  const packetUs = first && first.duration > 0
    ? toUs(first.duration)
    : Math.round(1_000_000 / (stats.averagePacketRate || 47));
  return {
    codec: codec || 'unknown',
    codecString: codecString || '',
    sampleRate,
    channels,
    bitrateBps: Math.round(stats.averageBitrate || 0),
    packetUs,
    firstPacketUs: first ? toUs(first.timestamp) : 0,
  };
}

/**
 * HDR（PQ・HLG）かどうか。WebCodecs はこの色の扱いが未整備なので、検出して伝えるに留める
 * @param {VideoColorSpaceInit} color
 * @returns {boolean}
 */
function isHdr(color) {
  const transfer = /** @type {string|undefined} */ (color.transfer);
  return transfer === 'pq' || transfer === 'hlg';
}

/**
 * ブラウザが必要な機能を持っているか調べる
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkBrowser() {
  const missing = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    missing.push('webcodecs');
  }
  if (typeof OffscreenCanvas === 'undefined') {
    missing.push('offscreencanvas');
  }
  if (typeof createImageBitmap === 'undefined') {
    missing.push('imagebitmap');
  }
  return { ok: missing.length === 0, missing };
}
