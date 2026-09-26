// 開発用の小さなサーバー。ファイルを配るのと、書き出した動画を out/ に受け取るのに使う
// 使い方: node tools/serve.mjs [ポート]
// 公開するときは使わない（GitHub Pages はただの置き場なので、これは要らない）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8777);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  // 書き出した動画を受け取る
  if (req.method === 'POST' && url.pathname.startsWith('/__save/')) {
    const name = path.basename(url.pathname.slice('/__save/'.length));
    const dir = path.join(root, 'out');
    fs.mkdirSync(dir, { recursive: true });
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    fs.writeFileSync(path.join(dir, name), body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ saved: `out/${name}`, bytes: body.length }));
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) {
    rel += 'index.html';
  }
  const file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end('だめです');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('ありません: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/ で配っています（root: ${root}）`);
});
