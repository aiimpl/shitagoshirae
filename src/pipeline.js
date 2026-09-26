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
import { fadeAt } from './plan.js';

/** @typedef {import('./types.js').Plan} Plan */

/**
 * @typedef {Object} RunHooks
 * @property {(info: { codecString: string, width: number, height: number, audio: 'copy'|'drop' }) => void} [onOpened]
 * @property {(p: { mediaUs: number, totalUs: number, frames: number, encodedBytes: number, queued: number }) => void} [onProgress]
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
  /** @type {Output|null} */
  let output = null;
  /** @type {Compositor|null} */
  let compositor = null;
  /** @type {VideoEncodeStream|null} */
  let encoder = null;
  let finalized = false;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('映像が入っていません');
    }
    const audioTrack = plan.audio.mode === 'copy' ? await input.getPrimaryAudioTrack() : null;

    output = new Output({
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

    compositor = new Compositor({ width: plan.video.width, height: plan.video.height });
    compositor.configure(plan.video);

    let encodedBytes = 0;
    /** @type {Error|null} */
    let encodeError = null;
    /** @type {Promise<void>[]} */
    const writes = [];
    encoder = new VideoEncodeStream(
      plan.video,
      (chunk, meta) => {
        encodedBytes += chunk.byteLength;
        writes.push(videoSource.add(EncodedPacket.fromEncodedChunk(chunk), withBt709(meta)));
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

    const sink = new VideoSampleSink(videoTrack);
    const speed = plan.trim.speed || 1;
    const totalUs = Math.max(1, plan.trim.durationUs);
    let frames = 0;
    let lastOutUs = -1;
    let lastKeyUs = -Infinity;
    let lastDurationUs = 0;
    let lastReport = 0;

    // 使う区間を順につないでいく。出力の時刻は、前の区間の長さを足したもの
    for (const cut of plan.trim.cuts) {
      const pump = audioTrack && audioSource ? new AudioCopyPump(audioTrack, audioSource, cut) : null;
      await pump?.open();

      // samples() は開始の手前のキーフレームから復号し、開始より後のフレームだけを返す
      for await (const sample of sink.samples(cut.inUs / 1e6, cut.outUs / 1e6)) {
        if (hooks.isCancelled()) {
          sample.close();
          return { buffer: null, cancelled: true, frames, durationUs: 0, width: plan.video.width, height: plan.video.height, codecString };
        }
        if (encodeError) {
          sample.close();
          throw encodeError;
        }
        const srcUs = sample.microsecondTimestamp;
        const outUs = cut.outStartUs + Math.round((srcUs - cut.inUs) / speed);
        const skip = srcUs < cut.inUs
          || outUs <= lastOutUs
          || (frames > 0 && outUs - lastOutUs < plan.video.minFrameDeltaUs);
        if (skip) {
          sample.close();
          continue;
        }

        const duration = Math.round((sample.microsecondDuration || plan.video.minFrameDeltaUs) / speed);
        const frame = sample.toVideoFrame();
        /** @type {OffscreenCanvas} */
        let canvas;
        try {
          canvas = compositor.draw(frame, pickCaptions(captions, outUs), fadeAt(plan.video.fadeUs, outUs, totalUs));
        } finally {
          frame.close();
          sample.close();
        }

        const outFrame = new VideoFrame(canvas, { timestamp: outUs, duration });
        // 区間のつなぎ目は必ずキーフレームにする（切り替わりを綺麗に見せるため）
        const keyFrame = frames === 0
          || outUs - lastKeyUs >= plan.video.keyframeIntervalUs
          || outUs === cut.outStartUs;
        await encoder.push(outFrame, keyFrame);
        outFrame.close();
        if (keyFrame) {
          lastKeyUs = outUs;
        }
        lastOutUs = outUs;
        lastDurationUs = duration;
        frames++;

        await pump?.pumpUntil(outUs);

        const now = performance.now();
        if (now - lastReport > 100) {
          lastReport = now;
          hooks.onProgress?.({ mediaUs: outUs, totalUs, frames, encodedBytes, queued: encoder.queueSize });
        }
      }
      await pump?.finish();
    }

    await encoder.flush();
    await Promise.all(writes);
    if (encodeError) {
      throw encodeError;
    }
    await output.finalize();
    finalized = true;

    hooks.onProgress?.({ mediaUs: totalUs, totalUs, frames, encodedBytes, queued: 0 });
    return {
      buffer: /** @type {BufferTarget} */ (output.target).buffer,
      cancelled: false,
      frames,
      durationUs: lastOutUs + lastDurationUs,
      width: plan.video.width,
      height: plan.video.height,
      codecString,
    };
  } finally {
    // 成功・取り消し・しくじりのどれでも、ここで一度だけ片付ける
    encoder?.abort();
    compositor?.dispose();
    if (output && !finalized) {
      // 片付けの途中の失敗は、元のしくじりを隠さないように黙って進む
      await output.cancel().catch(() => undefined);
    }
    input.dispose();
  }
}

/**
 * 色の指定を BT.709 にそろえる
 * キャンバスから作ったコマは sRGB と記されるが、中の値は元の動画（BT.709）のまま。
 * sRGB と書いたままだと、再生する側が明るさの曲線を読み替えて、色が少し変わることがある
 * @param {EncodedVideoChunkMetadata|undefined} meta
 * @returns {EncodedVideoChunkMetadata|undefined}
 */
function withBt709(meta) {
  if (!meta?.decoderConfig) {
    return meta;
  }
  return {
    ...meta,
    decoderConfig: {
      ...meta.decoderConfig,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    },
  };
}

/**
 * いまの時刻に出すテロップを全部集める（上・中・下が同時に出ることがある）
 * @param {import('./types.js').CaptionBitmap[]} captions
 * @param {number} tUs
 * @returns {import('./types.js').CaptionBitmap[]}
 */
function pickCaptions(captions, tUs) {
  return captions.filter((c) => tUs >= c.startUs && tUs < c.endUs);
}

/**
 * 元の音声パケットを、中身に触らずそのまま出力へ流す
 */
export class AudioCopyPump {
  /**
   * @param {any} track
   * @param {EncodedAudioPacketSource} sink
   * @param {import('./types.js').PlanCut} trim  区間ひとつぶん
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
      if (this.outAt(srcUs) > untilUs) {
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
   * 元の時刻を、出来上がりでの時刻に移す
   * 区間をつなぐので、前の区間の長さ（outStartUs）を足す
   * @param {number} srcUs
   * @returns {number}
   */
  outAt(srcUs) {
    return this.trim.outStartUs + (srcUs - this.trim.inUs);
  }

  /**
   * 中身のバイト列はそのままに、時刻だけずらして書く
   * @param {any} packet
   * @param {number} srcUs
   */
  writeShifted(packet, srcUs) {
    // 中身は触らず、時刻だけずらした写しを作る
    const shifted = packet.clone({ timestamp: this.outAt(srcUs) / 1e6 });
    this.writes.push(this.sink.add(shifted, this.meta));
  }
}
