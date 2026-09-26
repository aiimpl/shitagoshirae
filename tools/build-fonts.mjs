// フォントを @fontsource から取ってきて fonts/ に置く
// 使い方: node tools/build-fonts.mjs
//
// この道具では、利用者が好きな文字をテロップに打てる。だから「使う文字だけ抜き出す」やり方は使えない。
// @fontsource の分割ファイル（unicode-range つき）をそのまま同梱して、
// 打たれた文字に必要な分だけブラウザが読む形にする。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAMILIES = [
  { pkg: 'zen-kaku-gothic-new', family: 'Zen Kaku Gothic New', weights: [400, 700] },
];

let css = '/* Zen Kaku Gothic New — SIL Open Font License 1.1（各フォルダの LICENSE を見てください）。'
  + '@fontsource 配布のファイルを改変せずに置いています。 */\n';
let total = 0;
let count = 0;
/** @type {Map<string, Set<string>>} */
const keep = new Map();

for (const F of FAMILIES) {
  const dir = path.join(root, 'fonts', F.pkg);
  fs.mkdirSync(dir, { recursive: true });
  keep.set(F.pkg, new Set());
  for (const weight of F.weights) {
    const base = `https://cdn.jsdelivr.net/npm/@fontsource/${F.pkg}@5/`;
    const text = await (await fetch(`${base}${weight}.css`)).text();
    for (const block of text.split('@font-face').slice(1)) {
      const file = block.match(/files\/([^)]+\.woff2)/)?.[1];
      const range = block.match(/unicode-range:\s*([^;}\n]+)/)?.[1];
      if (!file || !range) {
        continue;
      }
      const buf = Buffer.from(await (await fetch(base + 'files/' + file)).arrayBuffer());
      fs.writeFileSync(path.join(dir, file), buf);
      keep.get(F.pkg)?.add(file);
      total += buf.length;
      count++;
      css += `@font-face{font-family:'${F.family}';font-style:normal;font-display:swap;`
        + `font-weight:${weight};src:url(./${F.pkg}/${file}) format('woff2');unicode-range:${range.trim()};}\n`;
    }
  }
}

// 取り直しが全部うまくいってから、古いファイルを片付ける（途中で失敗したときに消さないため）
for (const F of FAMILIES) {
  const dir = path.join(root, 'fonts', F.pkg);
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.woff2') && !keep.get(F.pkg)?.has(file)) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}
fs.writeFileSync(path.join(root, 'fonts', 'fonts.css'), css);
console.log(`${count}個 / ${(total / 1024 / 1024).toFixed(2)}MB`);
console.log('LICENSE は各フォルダに置いてください（@fontsource の配布物に入っています）');
