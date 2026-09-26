// H.264 の書き出しを包んで、詰まったら送り出しを止める
// @ts-check

/** @typedef {import('./types.js').PlanVideo} PlanVideo */

// これ以上ためない。1枚が数MBあるので、ためるとタブが落ちる
const MAX_QUEUE = 2;

/**
 * このブラウザが受け付ける H.264 の設定を、良いほうから順に探す
 * @param {PlanVideo} video
 * @returns {Promise<VideoEncoderConfig|null>} どれも使えなければ null
 */
export async function pickEncoderConfig(video) {
  for (const codec of video.codecCandidates) {
    /** @type {VideoEncoderConfig} */
    const config = {
      codec,
      width: video.width,
      height: video.height,
      bitrate: video.bitrateBps,
      framerate: video.maxFps,
      avc: { format: 'avc' },
      latencyMode: 'quality',
      bitrateMode: 'variable',
    };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) {
        return config;
      }
    } catch (e) {
      // 受け付けない設定は例外になることがある。次の候補へ進む
    }
  }
  return null;
}

export class VideoEncodeStream {
  /**
   * @param {PlanVideo} video
   * @param {(chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata|undefined) => void} onChunk
   * @param {(err: Error) => void} onError
   */
  constructor(video, onChunk, onError) {
    this.video = video;
    this.onChunk = onChunk;
    this.onError = onError;
    this.aborted = false;
    this.codecString = '';
    /** @type {VideoEncoder|null} */
    this.encoder = null;
    /** @type {(() => void)|null} */
    this.drainResolve = null;
  }

  /**
   * 使えるコーデックを良いほうから試して開く
   * @returns {Promise<string>}
   */
  async open() {
    const config = await pickEncoderConfig(this.video);
    if (!config) {
      throw new Error('このブラウザでは H.264 の書き出しができません');
    }
    const encoder = new VideoEncoder({
      output: (chunk, meta) => this.onChunk(chunk, meta),
      error: (err) => this.onError(err instanceof Error ? err : new Error(String(err))),
    });
    encoder.configure(config);
    encoder.ondequeue = () => this.wake();
    this.encoder = encoder;
    this.codecString = config.codec;
    return config.codec;
  }

  /** 送り出しの詰まりが解けたことを知らせる */
  wake() {
    if (this.drainResolve) {
      const resolve = this.drainResolve;
      this.drainResolve = null;
      resolve();
    }
  }

  /**
   * 1枚送る。たまっている間は待つ
   * @param {VideoFrame} frame
   * @param {boolean} keyFrame
   */
  async push(frame, keyFrame) {
    const encoder = this.encoder;
    if (!encoder) {
      throw new Error('開く前に送ろうとしました');
    }
    while (!this.aborted && encoder.encodeQueueSize > MAX_QUEUE) {
      await this.waitDrain();
    }
    if (this.aborted) {
      return;
    }
    encoder.encode(frame, { keyFrame });
  }

  /**
   * ondequeue が来ないブラウザでも進めるよう、短い待ちを重ねる
   * @returns {Promise<void>}
   */
  waitDrain() {
    return new Promise((resolve) => {
      this.drainResolve = resolve;
      setTimeout(() => this.wake(), 2);
    });
  }

  /** 残りを出し切る */
  async flush() {
    if (this.encoder && this.encoder.state === 'configured') {
      await this.encoder.flush();
    }
  }

  /** 捨てる（出し切らない）。何度呼んでもよい */
  abort() {
    this.aborted = true;
    this.wake();
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
    this.encoder = null;
  }

  /** いま何枚たまっているか */
  get queueSize() {
    return this.encoder ? this.encoder.encodeQueueSize : 0;
  }
}
