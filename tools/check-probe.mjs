// 下調べが実際のファイルで動くかを、Chrome を動かして確かめる（開発用）
// 使い方: python3 -m http.server 8777 を走らせた上で node tools/check-probe.mjs
import { openTab } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const files = process.argv.slice(2);
if (files.length === 0) {
  files.push('samples/heavy-1080p-40s.mp4', 'samples/juppun_30s.mp4');
}

const tab = await openTab(`${BASE}/test/probe-dump.html`);
await tab.waitFor('typeof window.__probeFile === "function"');

for (const path of files) {
  const url = `${BASE}/${path}`;
  const name = path.split('/').pop();
  await tab.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(url)});
    const blob = await res.blob();
    window.__result = null;
    await window.__probeFile(new File([blob], ${JSON.stringify(name)}, { type: 'video/mp4' }));
  })()`);
  await tab.waitFor('window.__result');
  const result = await tab.evaluate('window.__result');
  const p = result.probe;
  const v = p.video;
  console.log(`\n== ${name}`);
  console.log(`  容れ物: ${p.container} / 長さ: ${(p.durationUs / 1e6).toFixed(2)}秒 / ${(p.fileSize / 1024 / 1024).toFixed(1)}MB`);
  if (v) {
    console.log(`  映像: ${v.codec} ${v.codecString} ${v.codedWidth}x${v.codedHeight} 回転${v.rotation} 表示${v.displayWidth}x${v.displayHeight}`);
    console.log(`  ${v.fps}fps / ${(v.bitrateBps / 1e6).toFixed(2)}Mbps / HDR:${v.hdr} / 復号できる:${v.decodable}`);
  }
  console.log(`  音声: ${p.audio ? `${p.audio.codec} ${p.audio.codecString} ${p.audio.channels}ch ${p.audio.sampleRate}Hz 1パケット${p.audio.packetUs}us` : 'なし'}`);
  console.log(`  計画: ${result.plan.video.width}x${result.plan.video.height} / ${(result.plan.video.bitrateBps / 1e6).toFixed(2)}Mbps / 音声:${result.plan.audio.mode}(${result.plan.audio.reason})`);
  console.log(`  使えるコーデック: ${result.codec}`);
  const warnings = result.plan.warnings.map((w) => `${w.level}:${w.code}`).join(' ');
  console.log(`  注意: ${warnings || 'なし'}`);
}

if (tab.logs.length) {
  console.log('\n-- ページの記録 --');
  console.log(tab.logs.join('\n'));
}
tab.close();
process.exit(0);
