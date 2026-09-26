// 人が実際に困る形の動画を ffmpeg で作る（開発用）
// 使い方: node tools/make-samples.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'samples');
fs.mkdirSync(dir, { recursive: true });

const run = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });

// 向きが分かる絵を作る（左上=赤・右上=緑・左下=青・右下=白。上の縁に黒い帯）
// 文字は使わない（ffmpeg に drawtext が入っていないことがあるため）
function makeMarker(out, w, h, seconds, extra = []) {
  const half = `${Math.floor(w / 2)}x${Math.floor(h / 2)}`;
  const band = Math.max(4, Math.floor(h / 20));
  run([
    '-f', 'lavfi', '-i', `color=c=red:s=${half}:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `color=c=green:s=${half}:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `color=c=blue:s=${half}:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `color=c=white:s=${half}:d=${seconds}:r=30`,
    '-filter_complex',
    `[0][1]hstack[top];[2][3]hstack[bottom];[top][bottom]vstack,` +
    `drawbox=x=0:y=0:w=iw:h=${band}:color=black@1:t=fill[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-t', String(seconds), ...extra, out,
  ]);
}

const tasks = {
  // iPhone の縦撮り：横で符号化され、回転情報が90度入っている
  'rot90.mp4': () => {
    const tmp = path.join(dir, '_tmp_rot.mp4');
    makeMarker(tmp, 1280, 720, 4);
    run(['-display_rotation', '90', '-i', tmp, '-c', 'copy', path.join(dir, 'rot90.mp4')]);
    fs.unlinkSync(tmp);
  },
  'rot270.mp4': () => {
    const tmp = path.join(dir, '_tmp_rot270.mp4');
    makeMarker(tmp, 1280, 720, 4);
    run(['-display_rotation', '270', '-i', tmp, '-c', 'copy', path.join(dir, 'rot270.mp4')]);
    fs.unlinkSync(tmp);
  },
  // 音つき（AAC ステレオ）。音と映像のずれを見るために、1秒ごとに鳴る音を入れる
  'with-audio.mp4': () => {
    const tmp = path.join(dir, '_tmp_audio.mp4');
    makeMarker(tmp, 1280, 720, 6);
    run([
      '-i', tmp,
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6:sample_rate=48000',
      '-filter_complex', '[1]atrim=0:6,asetpts=PTS-STARTPTS[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-profile:a', 'aac_low',
      '-ac', '2', '-b:a', '128k', path.join(dir, 'with-audio.mp4'),
    ]);
    fs.unlinkSync(tmp);
  },
  // 縦長（スマホで撮ったそのままの形）
  'portrait.mp4': () => makeMarker(path.join(dir, 'portrait.mp4'), 720, 1280, 4),
  // 4K。重さの確認用
  'uhd.mp4': () => makeMarker(path.join(dir, 'uhd.mp4'), 3840, 2160, 4),
  // 可変フレームレート
  'vfr.mp4': () => {
    const tmp = path.join(dir, '_tmp_vfr.mp4');
    makeMarker(tmp, 1280, 720, 6);
    run(['-i', tmp, '-vf', 'select=not(mod(n\\,3))+gt(random(0)\\,0.5)', '-fps_mode', 'vfr', '-c:v', 'libx264', path.join(dir, 'vfr.mp4')]);
    fs.unlinkSync(tmp);
  },
  // HEVC（iPhone の既定。X には上げられないので、直せること自体が値打ち）
  'hevc.mp4': () => {
    const tmp = path.join(dir, '_tmp_hevc.mp4');
    makeMarker(tmp, 1280, 720, 4);
    run(['-i', tmp, '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', path.join(dir, 'hevc.mp4')]);
    fs.unlinkSync(tmp);
  },
  // 超横長（Xの比率の上限を超える）
  'ultrawide.mp4': () => makeMarker(path.join(dir, 'ultrawide.mp4'), 2560, 640, 3),
};

const only = process.argv[2];
for (const [name, make] of Object.entries(tasks)) {
  if (only && !name.includes(only)) {
    continue;
  }
  const out = path.join(dir, name);
  process.stdout.write(`${name} … `);
  make();
  const size = fs.statSync(out).size;
  console.log(`${(size / 1024 / 1024).toFixed(1)}MB`);
}
