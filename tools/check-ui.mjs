// 画面を人と同じ手順で動かして確かめる（落とす→設定を変える→変換する→結果が出る）
// 使い方: node tools/serve.mjs を走らせた上で node tools/check-ui.mjs
import path from 'node:path';
import { openTab } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const SAMPLE = process.argv[2] || 'samples/rot90.mp4';

const tab = await openTab(`${BASE}/index.html`);
// about:blank の段階で進まないよう、目印の要素が出るまで待つ
await tab.waitFor('document.readyState === "complete" && !!document.getElementById("drop")');

// 1. 動画を入れる（人と同じ「クリックして選ぶ」経路。このページは通信できない設定なので、
//    ファイルはブラウザの選択の仕組みから渡す）
await tab.send('DOM.enable');
await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
const absPath = path.resolve(SAMPLE);
tab.on('Page.fileChooserOpened', (p) => {
  tab.send('DOM.setFileInputFiles', { files: [absPath], backendNodeId: p.backendNodeId });
});
// 本物の押下でないと、ファイルを選ぶ窓は開かない
const box = await tab.evaluate(`(() => {
  const r = document.getElementById('drop').getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await tab.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
await tab.waitFor('!document.getElementById("work").hidden', 30000);
console.log('落とす → 設定画面が出た');

const meta = await tab.evaluate('document.getElementById("inmeta").innerText.replace(/\\n/g, " / ")');
console.log('  読み取り:', meta);

// 2. 下見が真っ黒でないことを見る
await new Promise((r) => setTimeout(r, 900));
const pv = await tab.evaluate(`(() => {
  const c = document.getElementById('pv');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; }
  return { w: c.width, h: c.height, avg: Math.round(sum / (d.length / 4) / 3) };
})()`);
console.log(`  下見: ${pv.w}x${pv.h} 明るさ ${pv.avg} ${pv.avg > 8 ? 'ok' : 'NG（真っ黒）'}`);

// 3. かたちを縦にして、テロップを1つ足す
await tab.evaluate(`document.querySelector('#segShape button[data-v="9:16"]').click()`);
await tab.evaluate(`document.getElementById('bAddCue').click()`);
await tab.evaluate(`(() => {
  const input = document.querySelector('#cues input[type=text]');
  input.value = 'テロップの確認';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await new Promise((r) => setTimeout(r, 400));
const out = await tab.evaluate('document.getElementById("pvmeta").innerText.replace(/\\n/g, " / ")');
console.log('  設定変更後:', out);
const warns = await tab.evaluate('document.getElementById("warns").innerText.replace(/\\n/g, " | ")');
console.log('  注意書き:', warns || 'なし');

// 4. 変換のあいだ、通信が1件も出ないことを見る（この道具のいちばんの売り）
await tab.send('Network.enable');
/** @type {string[]} */
const requests = [];
tab.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));

// 5. 変換して、結果が出るまで待つ
await tab.evaluate(`document.getElementById('bConvert').click()`);
await tab.waitFor('!document.getElementById("running").hidden', 10000);
console.log('変換を始めた');
await tab.waitFor('!document.getElementById("result").hidden || !document.getElementById("error").hidden', 300000);

const failed = await tab.evaluate('!document.getElementById("error").hidden');
if (failed) {
  console.log('NG しくじりました:', await tab.evaluate('document.getElementById("errorBody").textContent'));
} else {
  const result = await tab.evaluate('document.getElementById("resultMeta").innerText.replace(/\\n/g, " / ")');
  const hasVideo = await tab.evaluate('!!document.getElementById("resultVideo").src');
  console.log('結果:', result);
  console.log('  見本の再生:', hasVideo ? 'ok' : 'NG');
}

// 自分のページのファイルを読むのは通信だが、外に何かを渡してはいない。
// 見るべきは「別の相手への通信が0件であること」
const own = new URL(BASE).origin;
const outside = requests.filter((u) => !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith(own));
const ownFiles = requests.filter((u) => u.startsWith(own));
console.log(`  変換中の外部への通信: ${outside.length}件 ${outside.length === 0 ? 'ok' : 'NG ' + outside.join(', ')}`);
console.log(`  （自分のファイルの読み込み: ${ownFiles.length}件）`);

if (tab.logs.length) {
  console.log('\n-- ページの記録 --');
  console.log(tab.logs.slice(-10).join('\n'));
}
tab.close();
process.exit(failed || outside.length ? 1 : 0);
