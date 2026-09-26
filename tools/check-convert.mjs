// 変換をブラウザで実際に走らせ、出てきた mp4 を ffprobe で検査する（開発用）
// 使い方: node tools/serve.mjs を走らせた上で node tools/check-convert.mjs
import { openTab } from './cdp.mjs';
import { checkOutput, quadrantColors } from './check-output.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';

// 試す組み合わせ。実際に人が困る形をひととおり通す
const CASES = [
  {
    name: 'そのまま1080p',
    source: 'samples/opus5_vs_opus55_40s.mp4',
    settings: { shape: 'keep', resolution: '1080p', sizeMode: 'quality', quality: 'high' },
    want: { width: 1920, height: 1080, expectAudio: false },
  },
  {
    name: '目標30MB',
    source: 'samples/opus5_vs_opus55_40s.mp4',
    settings: { shape: 'keep', resolution: '1080p', sizeMode: 'size', targetBytes: 30 * 1024 * 1024 },
    want: { width: 1920, height: 1080, maxBytes: 33 * 1024 * 1024, expectAudio: false },
  },
  {
    name: '縦9:16・ぼかし余白',
    source: 'samples/opus5_vs_opus55_40s.mp4',
    settings: { shape: '9:16', pad: 'blur', resolution: '720p', sizeMode: 'quality', quality: 'medium' },
    want: { width: 720, height: 1280, expectAudio: false },
  },
  {
    name: '回転90（iPhoneの縦撮り）',
    source: 'samples/rot90.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium' },
    want: { width: 720, height: 1280, expectAudio: false },
    orientation: true,
  },
  {
    name: '回転270',
    source: 'samples/rot270.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium' },
    want: { width: 720, height: 1280, expectAudio: false },
    orientation: true,
  },
  {
    name: '音つき（そのまま通す）',
    source: 'samples/with-audio.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium', audio: 'copy' },
    want: { width: 1280, height: 720, expectAudio: true },
    orientation: true,
  },
  {
    name: '音を消す',
    source: 'samples/with-audio.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium', audio: 'mute' },
    want: { expectAudio: false },
  },
  {
    name: 'HEVCをH.264に直す',
    source: 'samples/hevc.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium' },
    want: { width: 1280, height: 720, expectAudio: false },
    orientation: true,
  },
  {
    name: '可変フレームレート',
    source: 'samples/vfr.mp4',
    settings: { shape: 'keep', resolution: 'source', sizeMode: 'quality', quality: 'medium' },
    want: { expectAudio: false },
  },
  {
    name: '4Kを1080pに',
    source: 'samples/uhd.mp4',
    settings: { shape: 'keep', resolution: '1080p', sizeMode: 'quality', quality: 'medium' },
    want: { width: 1920, height: 1080, expectAudio: false },
    orientation: true,
  },
  {
    name: '超横長（比率を詰める）',
    source: 'samples/ultrawide.mp4',
    settings: { shape: 'keep', pad: 'color', resolution: 'source', sizeMode: 'quality', quality: 'medium' },
    want: { expectAudio: false },
  },
  {
    name: '正方形・切り抜き',
    source: 'samples/juppun_30s.mp4',
    settings: { shape: '1:1', pad: 'crop', resolution: '720p', sizeMode: 'quality', quality: 'medium' },
    want: { width: 720, height: 720, expectAudio: false },
  },
];

const only = process.argv[2];
const tab = await openTab(`${BASE}/test/convert-dump.html`);
await tab.waitFor('typeof window.__convert === "function"');

let failed = 0;
for (const c of CASES) {
  if (only && !c.name.includes(only)) {
    continue;
  }
  const saveName = c.name.replace(/[^\w]/g, '_') + '.mp4';
  process.stdout.write(`\n== ${c.name}\n`);
  const t0 = Date.now();
  try {
    await tab.evaluate(`window.__convert(${JSON.stringify(`${BASE}/${c.source}`)}, ${JSON.stringify(c.settings)}, ${JSON.stringify(saveName)})`);
  } catch (err) {
    console.log('  変換で失敗:', String(err).split('\n')[0]);
    failed++;
    continue;
  }
  const done = await tab.evaluate('window.__done');
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${done.frames}枚 / ブラウザ内 ${(done.elapsedMs / 1000).toFixed(1)}秒 / 往復こみ ${wall}秒`);
  const result = checkOutput(`out/${saveName}`, c.want);
  for (const check of result.checks) {
    if (!check.ok) {
      console.log(`  NG ${check.name}: ${check.got}`);
    }
  }
  if (c.orientation) {
    const src = quadrantColors(c.source);
    const got = quadrantColors(`out/${saveName}`);
    const same = src.join(',') === got.join(',');
    console.log(`  向き: 元 ${src.join(',')} → 出力 ${got.join(',')} ${same ? 'ok' : 'NG'}`);
    if (!same) {
      failed++;
    }
  }
  const info = result.info;
  console.log(`  出力: ${info.width}x${info.height} ${(info.size / 1024 / 1024).toFixed(1)}MB ${(info.bitrate / 1e6).toFixed(2)}Mbps ${info.duration.toFixed(2)}秒`);
  console.log(`  検査: ${result.ok ? 'すべて通りました' : '通らない項目があります'}`);
  if (!result.ok) {
    failed++;
  }
}

if (tab.logs.length) {
  console.log('\n-- ページの記録 --');
  console.log(tab.logs.slice(-20).join('\n'));
}
tab.close();
process.exit(failed ? 1 : 0);
