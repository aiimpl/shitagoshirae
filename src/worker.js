// 重い処理を走らせる係。やりとりの受け渡しだけを受け持つ（中身は pipeline.js）
// @ts-check

import { run } from './pipeline.js';

let cancelled = false;

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type !== 'start') {
    return;
  }
  cancelled = false;
  try {
    const result = await run(msg.file, msg.plan, msg.captions || [], {
      isCancelled: () => cancelled,
      onOpened: (info) => self.postMessage({ type: 'opened', ...info }),
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    if (result.cancelled || !result.buffer) {
      self.postMessage({ type: 'cancelled' });
      return;
    }
    self.postMessage({
      type: 'done',
      buffer: result.buffer,
      frames: result.frames,
      durationUs: result.durationUs,
      width: result.width,
      height: result.height,
      codecString: result.codecString,
    }, [result.buffer]);
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : '',
    });
  }
};
