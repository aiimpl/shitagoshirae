// 編集（区間の切り落とし・テロップの見せ方・ふわっと）が、書き出しに効いているかを確かめる
// 使い方: node tools/serve.mjs を走らせた上で node tools/check-edit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openTab } from './cdp.mjs';
import { checkOutput, quadrantColors } from './check-output.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const SAMPLE = 'samples/with-audio.mp4';

const tab = await openTab(`${BASE}/index.html`);
await tab.waitFor('document.readyState === "complete" && !!document.getElementById("drop")');
await tab.send('DOM.enable');
await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
tab.on('Page.fileChooserOpened', (p) => {
  tab.send('DOM.setFileInputFiles', { files: [path.resolve(SAMPLE)], backendNodeId: p.backendNodeId });
});
const box = await tab.evaluate(`(() => {
  const r = document.getElementById('drop').getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await tab.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
await tab.waitFor('!document.getElementById("work").hidden', 30000);
console.log('読み込みました（6秒の動画）');

// 真ん中の2秒を落とす：2秒で切って、4秒で切って、真ん中を落とす
await tab.evaluate('window.__seek = (s) => { document.querySelector("video") ; }');
const splitAt = async (seconds) => {
  await tab.evaluate(`(() => {
    const strip = document.querySelector('.tl-strip').getBoundingClientRect();
    const x = strip.left + strip.width * ${seconds} / 6;
    document.querySelector('[data-role=strip]').dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: strip.top + 10, bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await tab.evaluate('document.getElementById("bSplit").click()');
  await new Promise((r) => setTimeout(r, 250));
};
await splitAt(2);
await splitAt(4);
const segs = await tab.evaluate('document.querySelectorAll("[data-seg][data-edge=start]").length');
console.log(`区間の数: ${segs}`);

// 真ん中（2秒〜4秒）を選んで落とす
await tab.evaluate(`(() => {
  const handles = [...document.querySelectorAll('[data-seg][data-edge=start]')];
  const middle = handles[1];
  middle.dispatchEvent(new PointerEvent('pointerdown', { clientX: middle.getBoundingClientRect().x + 2, clientY: middle.getBoundingClientRect().y + 20, bubbles: true }));
})()`);
await new Promise((r) => setTimeout(r, 300));
await tab.evaluate('document.getElementById("bDropSeg").click()');
await new Promise((r) => setTimeout(r, 400));
console.log('真ん中を落としました →', await tab.evaluate('document.getElementById("trimLabel").textContent'));

// テロップを黒帯で足して、ふわっとも入れる
await tab.evaluate('document.getElementById("bAddCue").click()');
await tab.evaluate(`(() => {
  const input = document.querySelector('#cueEdit input[type=text]');
  input.value = '黒帯のテロップ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#cueEdit .seg.mint button[data-v=bar]').click();
  document.querySelector('#segFade button[data-v=on]').click();
})()`);
await new Promise((r) => setTimeout(r, 400));

// 書き出して、長さが縮んでいることを確かめる
await tab.evaluate('document.getElementById("bConvert").click()');
await tab.waitFor('!document.getElementById("result").hidden || !document.getElementById("error").hidden', 300000);
const failed = await tab.evaluate('!document.getElementById("error").hidden');
if (failed) {
  console.log('NG', await tab.evaluate('document.getElementById("errorBody").textContent'));
  tab.close();
  process.exit(1);
}
const meta = await tab.evaluate('document.getElementById("resultMeta").innerText.replace(/\\n/g, " / ")');
console.log('結果:', meta);

// 「保存する」を押して、出てきたファイルを ffprobe で検査する
// （このページは通信できない設定なので、受け取りはブラウザの取り込みの仕組みを使う）
const outDir = path.resolve('out');
fs.mkdirSync(outDir, { recursive: true });
const saved = path.join(outDir, 'with-audio_x.mp4');
fs.rmSync(saved, { force: true });
await tab.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
await tab.evaluate('document.getElementById("bSave").click()');
for (let i = 0; i < 40 && !fs.existsSync(saved); i++) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!fs.existsSync(saved)) {
  console.log('NG 保存できませんでした');
  tab.close();
  process.exit(1);
}
console.log('保存できました:', path.relative(process.cwd(), saved));
const result = checkOutput(saved, { width: 1280, height: 720, expectAudio: true });
for (const c of result.checks) {
  if (!c.ok) {
    console.log(`  NG ${c.name}: ${c.got}`);
  }
}
console.log(`  検査: ${result.ok ? 'すべて通りました' : '通らない項目があります'}`);
console.log(`  長さ: ${result.info.duration.toFixed(2)}秒（元は6秒。真ん中の2秒を落としたので4秒になるはず）`);
console.log(`  音と映像: ${result.info.audioCodec || 'なし'} / ${result.info.videoCodec}`);
if (Math.abs(result.info.duration - 4) > 0.3) {
  console.log('  NG 長さが合いません');
  process.exitCode = 1;
}
if (tab.logs.length) {
  console.log(tab.logs.slice(-6).join('\n'));
}
tab.close();
process.exit(0);
