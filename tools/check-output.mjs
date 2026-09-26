// 書き出した mp4 が、Xの条件を満たしているかを ffprobe で検査する
// 使い方: node tools/check-output.mjs out/foo.mp4 [--width 1920 --height 1080]
import { execFileSync } from 'node:child_process';

/**
 * @param {string} file
 * @returns {object}
 */
export function probe(file) {
  const json = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    file,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(json);
}

/**
 * @param {string} file
 * @param {{ width?: number, height?: number, maxBytes?: number, expectAudio?: boolean }} [want]
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, got: string }[], info: object }}
 */
export function checkOutput(file, want = {}) {
  const data = probe(file);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const checks = [];
  const add = (name, ok, got) => checks.push({ name, ok: !!ok, got: String(got) });

  add('映像が入っている', !!video, video ? video.codec_name : 'なし');
  if (video) {
    add('H.264 である', video.codec_name === 'h264', video.codec_name);
    add('High プロファイル', video.profile === 'High', video.profile);
    add('画素形式 yuv420p', /^yuvj?420p$/.test(video.pix_fmt), video.pix_fmt);
    const sar = video.sample_aspect_ratio || '1:1';
    add('画素比 1:1', sar === '1:1' || sar === '0:1', sar);
    add('プログレッシブ', video.field_order === undefined || video.field_order === 'progressive', video.field_order || '(記載なし)');
    const fps = evalRatio(video.avg_frame_rate);
    add('60fps 以下', fps > 0 && fps <= 60.5, fps.toFixed(3));
    const aspect = video.width / video.height;
    add('比率が 1:3〜3:1', aspect >= 1 / 3 - 1e-6 && aspect <= 3 + 1e-6, `${video.width}x${video.height} (${aspect.toFixed(3)})`);
    add('幅も高さも偶数', video.width % 2 === 0 && video.height % 2 === 0, `${video.width}x${video.height}`);
    add('回転が残っていない', !hasRotation(video), rotationOf(video));
    if (want.width) {
      add('指定どおりの幅', video.width === want.width, `${video.width} (指定 ${want.width})`);
    }
    if (want.height) {
      add('指定どおりの高さ', video.height === want.height, `${video.height} (指定 ${want.height})`);
    }
  }

  const duration = Number(data.format.duration);
  add('0.5秒以上', duration >= 0.5, duration.toFixed(3) + '秒');

  if (want.expectAudio !== undefined) {
    add(want.expectAudio ? '音声が入っている' : '音声が入っていない', !!audio === want.expectAudio, audio ? audio.codec_name : 'なし');
  }
  if (audio) {
    add('AAC である', audio.codec_name === 'aac', audio.codec_name);
    add('AAC-LC である', audio.profile === 'LC', audio.profile);
    add('1〜2チャンネル', audio.channels >= 1 && audio.channels <= 2, String(audio.channels));
    if (video) {
      const vDur = Number(video.duration || duration);
      const aDur = Number(audio.duration || duration);
      const gap = Math.abs(vDur - aDur);
      add('音と映像の長さの差が0.1秒以内', gap <= 0.1, gap.toFixed(3) + '秒');
    }
  }

  const bytes = Number(data.format.size);
  if (want.maxBytes) {
    add('目標のサイズに収まっている', bytes <= want.maxBytes, `${(bytes / 1024 / 1024).toFixed(1)}MB（目標 ${(want.maxBytes / 1024 / 1024).toFixed(1)}MB）`);
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    info: {
      size: bytes,
      duration,
      width: video?.width,
      height: video?.height,
      bitrate: Number(data.format.bit_rate),
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
    },
  };
}

function evalRatio(text) {
  if (!text) {
    return 0;
  }
  const [a, b] = String(text).split('/').map(Number);
  return b ? a / b : a;
}

function rotationOf(stream) {
  const side = (stream.side_data_list || []).find((s) => s.rotation !== undefined);
  if (side) {
    return String(side.rotation);
  }
  return stream.tags?.rotate ?? '0';
}

function hasRotation(stream) {
  return Number(rotationOf(stream)) !== 0;
}

// 直接呼ばれたときは、引数のファイルを検査して結果を出す
if (process.argv[1] && process.argv[1].endsWith('check-output.mjs')) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node tools/check-output.mjs out/foo.mp4');
    process.exit(2);
  }
  const want = {};
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    want[key] = Number(process.argv[i + 1]);
  }
  const result = checkOutput(file, want);
  for (const c of result.checks) {
    console.log(`${c.ok ? '  ok ' : '  NG '} ${c.name}: ${c.got}`);
  }
  console.log(result.ok ? 'すべて通りました' : '通らない項目があります');
  process.exit(result.ok ? 0 : 1);
}

/**
 * 四隅の色を読む。ffmpeg は取り出すときに回転を当てるので、
 * 「元のファイルを正しく表示した向き」と「書き出したファイルの向き」を比べられる
 * @param {string} file
 * @param {number} [atSec]
 * @returns {string[]} 左上・右上・左下・右下の色の名前
 */
export function quadrantColors(file, atSec = 1) {
  // 4x4 に縮めて、内側の4点だけ見る（縁の黒帯や境目を踏まないように）
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', String(atSec), '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=4:4',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1024 });
  const at = (x, y) => {
    const i = (y * 4 + x) * 3;
    return nameOfColor(raw[i], raw[i + 1], raw[i + 2]);
  };
  return [at(1, 1), at(2, 1), at(1, 2), at(2, 2)];
}

function nameOfColor(r, g, b) {
  const list = [
    ['\u8d64', 200, 30, 30], ['\u7dd1', 30, 160, 30], ['\u9752', 30, 30, 200], ['\u767d', 230, 230, 230], ['\u9ed2', 20, 20, 20],
  ];
  let best = '?';
  let bestDist = Infinity;
  for (const [name, cr, cg, cb] of list) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}
