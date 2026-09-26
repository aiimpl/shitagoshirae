// 変換の本体：取り出す→復号→合成→符号化→詰め直す
// ここには postMessage を書かない（Worker でも画面側でも同じように動かせるようにするため）
// @ts-check

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
} from '../vendor/mediabunny/mediabunny.mjs';
import { Compositor } from './compositor.js';
import { VideoEncodeStream } from './encoder.js';

/** @typedef {import('./types.js').Plan} Plan */

/**
 * @typedef {Object} RunHooks
 * @property {(info: { codecString: string, width: number, height: number, audio: 'copy'|'drop' }) => void} [onOpened]
 * @property {(p: { mediaUs: number, totalUs: number, frames: number, encodedBytes: number, openFrames: number }) => void} [onProgress]
 * @property {() => boolean} isCancelled
 */

/**
 * @typedef {Object} RunResult
 * @property {ArrayBuffer|null} buffer
 * @property {boolean} cancelled
 * @property {number} frames
 * @property {number} durationUs
 * @property {number} width
 * @property {number} height
 * @property {string} codecString
 */

/**
 * 1本ぶん変換する
 * @param {File|Blob} file
 * @param {Plan} plan
 * @param {import('./types.js').CaptionBitmap[]} captions
 * @param {RunHooks} hooks
 * @returns {Promise<RunResult>}
 */
export async function run(file, plan, captions, hooks) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error('映像が入っていません');
  }
  const audioTrack = plan.audio.mode === 'copy' ? await input.getPrimaryAudioTrack() : null;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new EncodedVideoPacketSource('avc');
  // 回転はここまでに画へ焼き込んである。出力側に回転を書かない（二重に回らないように）
  output.addVideoTrack(videoSource, { rotation: 0, frameRate: plan.video.maxFps });
  const audioSource = audioTrack ? new EncodedAudioPacketSource(/** @type {any} */ (audioTrack.codec)) : null;
  if (audioSource) {
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const compositor = new Compositor({ width: plan.video.width, height: plan.video.height });
  compositor.configure(plan.video);

  let encodedBytes = 0;
  /** @type {Error|null} */
  let encodeError = null;
  /** @type {Promise<void>[]} */
  const writes = [];
  const encoder = new VideoEncodeStream(
    plan.video,
    (chunk, meta) => {
      encodedBytes += chunk.byteLength;
      writes.push(videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta));
    },
    (err) => { encodeError = err; },
  );
  const codecString = await encoder.open();
  hooks.onOpened?.({
    codecString,
    width: plan.video.width,
    height: plan.video.height,
    audio: audioSource ? 'copy' : 'drop',
  });

  const audioPump = audioTrack && audioSource
    ? new AudioCopyPump(audioTrack, audioSource, plan.trim)
    : null;
  await audioPump?.open();

  const sink = new VideoSampleSink(videoTrack);
  const totalUs = Math.max(1, plan.trim.durationUs);
  let frames = 0;
  let openFrames = 0;
  let lastOutUs = -1;
  let lastKeyUs = -Infinity;
  let lastDurationUs = 0;
  let lastReport = 0;
  let cancelled = false;

  try {
    for await (const sample of sink.samples(plan.trim.decodeFromUs / 1e6, plan.trim.outUs / 1e6)) {
      if (hooks.isCancelled()) {
        sample.close();
        cancelled = true;
        break;
      }
      if (encodeError) {
        sample.close();
        throw encodeError;
      }
      const srcUs = sample.microsecondTimestamp;
      if (srcUs < plan.trim.inUs) {
        sample.close();
        continue;
      }
      if (srcUs >= plan.trim.outUs) {
        sample.close();
        break;
      }
      const outUs = srcUs - plan.trim.inUs;
      if (outUs <= lastOutUs) {
        sample.close();
        continue;
      }
      if (frames > 0 && outUs - lastOutUs < plan.video.minFrameDeltaUs) {
        sample.close();
        continue;
      }

      const overlay = pickCaption(captions, outUs);
      const duration = sample.microsecondDuration || plan.video.minFrameDeltaUs;
      const frame = sample.toVideoFrame();
      openFrames++;
      /** @type {OffscreenCanvas} */
      let canvas;
      try {
        canvas = compositor.draw(frame, overlay);
      } finally {
        frame.close();
        openFrames--;
        sample.close();
      }

      const outFrame = new VideoFrame(canvas, { timestamp: outUs, duration });
      const keyFrame = frames === 0 || outUs - lastKeyUs >= plan.video.keyframeIntervalUs;
      await encoder.push(outFrame, keyFrame);
      outFrame.close();
      if (keyFrame) {
        lastKeyUs = outUs;
      }
      lastOutUs = outUs;
      lastDurationUs = duration;
      frames++;

      await audioPump?.pumpUntil(outUs);

      const now = performance.now();
      if (now - lastReport > 100) {
        lastReport = now;
        hooks.onProgress?.({ mediaUs: outUs, totalUs, frames, encodedBytes, openFrames: encoder.queueSize });
      }
    }

    if (cancelled) {
      encoder.abort();
      compositor.dispose();
      await output.cancel();
      input.dispose();
      return { buffer: null, cancelled: true, frames, durationUs: 0, width: plan.video.width, height: plan.video.height, codecString };
    }

    await encoder.flush();
    await Promise.all(writes);
    if (encodeError) {
      throw encodeError;
    }
    await audioPump?.finish();
    await output.finalize();
    compositor.dispose();
    encoder.abort();
    input.dispose();

    hooks.onProgress?.({ mediaUs: totalUs, totalUs, frames, encodedBytes, openFrames: 0 });
    return {
      buffer: /** @type {BufferTarget} */ (output.target).buffer,
      cancelled: false,
      frames,
      durationUs: lastOutUs + lastDurationUs,
      width: plan.video.width,
      height: plan.video.height,
      codecString,
    };
  } catch (err) {
    encoder.abort();
    compositor.dispose();
    try {
      await output.cancel();
    } catch (e) {
      // 片付けの途中の失敗は、元のしくじりを隠さないように黙って進む
    }
    input.dispose();
    throw err;
  }
}

/**
 * いまの時刻に出すテロップを探す
 * @param {import('./types.js').CaptionBitmap[]} captions
 * @param {number} tUs
 */
function pickCaption(captions, tUs) {
  for (const c of captions) {
    if (tUs >= c.startUs && tUs < c.endUs) {
      return c;
    }
  }
  return null;
}

/**
 * 元の音声パケットを、中身に触らずそのまま出力へ流す
 */
export class AudioCopyPump {
  /**
   * @param {any} track
   * @param {EncodedAudioPacketSource} sink
   * @param {import('./types.js').PlanTrim} trim
   */
  constructor(track, sink, trim) {
    this.track = track;
    this.sink = sink;
    this.trim = trim;
    /** @type {AsyncGenerator<any>|null} */
    this.packets = null;
    /** @type {any} */
    this.pending = null;
    /** @type {any} */
    this.meta = undefined;
    this.done = false;
    /** @type {Promise<void>[]} */
    this.writes = [];
  }

  async open() {
    const source = new EncodedPacketSink(this.track);
    const first = await source.getPacket(this.trim.audioInUs / 1e6);
    this.meta = { decoderConfig: await this.track.getDecoderConfig() };
    this.packets = source.packets(first ?? undefined);
    await this.advance();
  }

  async advance() {
    if (!this.packets) {
      this.done = true;
      return;
    }
    const next = await this.packets.next();
    this.pending = next.done ? null : next.value;
    if (!this.pending) {
      this.done = true;
    }
  }

  /**
   * 出力の時刻に追いつくまで流す
   * @param {number} untilUs
   */
  async pumpUntil(untilUs) {
    while (!this.done && this.pending) {
      const srcUs = Math.round(this.pending.timestamp * 1e6);
      if (srcUs < this.trim.audioInUs) {
        await this.advance();
        continue;
      }
      if (srcUs >= this.trim.audioOutUs) {
        this.done = true;
        break;
      }
      if (srcUs - this.trim.inUs > untilUs) {
        break;
      }
      this.writeShifted(this.pending, srcUs);
      await this.advance();
    }
  }

  /** 残りを全部流す */
  async finish() {
    while (!this.done && this.pending) {
      const srcUs = Math.round(this.pending.timestamp * 1e6);
      if (srcUs >= this.trim.audioOutUs) {
        break;
      }
      if (srcUs >= this.trim.audioInUs) {
        this.writeShifted(this.pending, srcUs);
      }
      await this.advance();
    }
    await Promise.all(this.writes);
  }

  /**
   * 中身のバイト列はそのままに、時刻だけずらして書く
   * @param {any} packet
   * @param {number} srcUs
   */
  writeShifted(packet, srcUs) {
    // 中身は触らず、時刻だけずらした写しを作る
    const shifted = packet.clone({ timestamp: (srcUs - this.trim.inUs) / 1e6 });
    this.writes.push(this.sink.add(shifted, this.meta));
  }
}
