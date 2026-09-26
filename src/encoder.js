// H.264 の書き出しを包んで、詰まったら送り出しを止める
// @ts-check

/** @typedef {import('./types.js').PlanVideo} PlanVideo */

// これ以上ためない。1枚が数MBあるので、ためるとタブが落ちる
const MAX_QUEUE = 2;

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
    const base = {
      width: this.video.width,
      height: this.video.height,
      bitrate: this.video.bitrateBps,
      framerate: this.video.maxFps,
      avc: /** @type {const} */ ({ format: 'avc' }),
      latencyMode: /** @type {const} */ ('quality'),
      bitrateMode: /** @type {const} */ ('variable'),
    };
    for (const codec of this.video.codecCandidates) {
      const config = { ...base, codec };
      let supported = false;
      try {
        supported = (await VideoEncoder.isConfigSupported(config)).supported === true;
      } catch (e) {
        supported = false;
      }
      if (!supported) {
        continue;
      }
      const encoder = new VideoEncoder({
        output: (chunk, meta) => this.onChunk(chunk, meta),
        error: (err) => this.onError(err instanceof Error ? err : new Error(String(err))),
      });
      encoder.configure(config);
      encoder.ondequeue = () => this.wake();
      this.encoder = encoder;
      this.codecString = codec;
      return codec;
    }
    throw new Error('このブラウザでは H.264 の書き出しができません');
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
