// 開発用の小さなサーバー。ファイルを配るのと、書き出した動画を out/ に受け取るのに使う
// 使い方: node tools/serve.mjs [ポート]
// 公開するときは使わない（GitHub Pages はただの置き場なので、これは要らない）
//
// 127.0.0.1 にしか耳を貸さないが、動かしている間は「同じパソコンで開いている別のページ」から
// 叩けてしまう。名前を騙られないように、Host と Origin が自分のものかを見てから受ける
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8777);
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;

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

/**
 * 自分宛ての要求か。よそのページから 127.0.0.1 を叩かれても受けないようにする
 * @param {http.IncomingMessage} req
 * @param {boolean} needOrigin 書き込みのときは Origin が付いていることまで求める
 * @returns {boolean}
 */
function fromSelf(req, needOrigin) {
  if (req.headers.host !== host) {
    return false;
  }
  const from = req.headers.origin;
  if (needOrigin) {
    return from === origin;
  }
  return from === undefined || from === origin;
}

/**
 * 書き出した動画を out/ に受け取る
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
async function save(req, res, pathname) {
  if (!fromSelf(req, true)) {
    res.writeHead(403);
    res.end('よそからは受けません');
    return;
  }
  const name = path.basename(pathname.slice('/__save/'.length));
  if (!name || name === '.' || name === '..') {
    res.writeHead(400);
    res.end('名前がありません');
    return;
  }
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
}

/**
 * ファイルを配る
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
function serve(req, res, pathname) {
  if (!fromSelf(req, false)) {
    res.writeHead(403);
    res.end('よそからは受けません');
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) {
    rel += 'index.html';
  }
  const file = path.join(root, rel);
  // root そのものか、root の下か。前方一致だけだと隣のフォルダ（root + "-notes" など）を掴んでしまう
  if (file !== root && !file.startsWith(root + path.sep)) {
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
}

const server = http.createServer((req, res) => {
  // 途中で投げても、サーバーごと落とさない（Node は拾われない失敗でプロセスを終える）
  Promise.resolve()
    .then(() => {
      const url = new URL(req.url || '/', origin);
      if (req.method === 'POST' && url.pathname.startsWith('/__save/')) {
        return save(req, res, url.pathname);
      }
      return serve(req, res, url.pathname);
    })
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(400);
      }
      res.end('しくじりました');
    });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`${origin}/ で配っています（root: ${root}）`);
});
