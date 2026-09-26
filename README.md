# したごしらえ

X に上げる動画を、投稿に向いた形に整えるブラウザの道具です。縦横のかたちを変え、余白をぼかしで埋め、長さを切り、目標のサイズに収め、テロップを焼き込みます。
**動画はどこにも送りません。** 読み込みも、ぼかしも、書き出しも、すべてあなたのブラウザの中だけで終わります。

**ブラウザで使う：https://aiimpl.github.io/shitagoshirae/**

（English: the tool picks your browser's language automatically, and there is a switch at the top right. See [English](#english) below.）

## できること
- **かたちを変える**：そのまま／横16:9／正方形／縦9:16。余白は**ぼかした背景**・単色・切り抜きから選べます
- **いらないところを落とす**：タイムラインで切って、区間ごと落とせます。残りはつないで1本になります
- **出だしと終わりをふわっと**：真っ暗から入って、真っ暗に抜けます
- **画質とサイズ**：画質で決めるか、目標のサイズ（例：30MB）から逆算するか
- **音はそのまま**：音声は作り直さずに詰め替えるので、劣化しません。消すこともできます
- **テロップを焼き込む**：文字・出す時間・位置（上/中/下）・大きさ・色・上下の微調整。見せ方は3つ（白文字＋フチ／黒帯／色帯）。**SRT（字幕ファイル）をまとめて読み込めます**。Xは音を出さずに再生されることが多いので、ここが効きます
- **iPhone の動画を直す**：HEVC（iPhoneの既定）を H.264 に、縦撮りの回転を正しい向きに直します

## 使い方
1. 動画を落とす（またはクリックして選ぶ）
2. 右側でかたちや画質を決める。左側に仕上がりがそのまま出ます
3. タイムラインで整える
   - 帯をクリックすると、そこへ飛びます
   - 黄色いつまみを引くと、使うところの端が動きます
   - 「ここで切る」で区間を2つに割り、いらないほうを選んで「この区間を落とす」
   - 「ここに足す」でテロップを置き、色の帯をつかんで動かします。字幕ファイルがあるなら「SRTを読む」でまとめて置けます
4. 「変換する」を押す。途中でやめられます
5. 「保存する」を押して、出来たファイルを保存します

手元で動かす場合は、ESモジュールを読み込むためローカルサーバー経由で開いてください（例：`python3 -m http.server` → http://localhost:8000 、または `node tools/serve.mjs`）。

## 対応ブラウザ
| ブラウザ | 変換 | 音声 |
|---|---|---|
| Chrome / Edge（PC・Android） | ○ | そのまま通す・消す ともに可 |
| Safari 26 以降（Mac・iPhone） | ○ | 同上 |
| Safari 16.4〜18 | ○ | 同上（音声を作り直す機能は元々使っていません） |
| Firefox（PC） | ○ | 同上 |
| Firefox（Android） | **×** | WebCodecs がないため動きません |

対応していないブラウザで開くと、その場で「何ができないか」を出します。黙って失敗することはありません。

速さの目安（M5 の Mac、Chrome 153 での実測）：40秒・1920×1080 の動画を 1080p で書き出して約5秒、720×1280 に変換して約2秒。実時間の8〜18倍の速さです。

## Xの仕様に合わせている部分
出典：[X の開発者ドキュメント](https://docs.x.com/x-api/media/quickstart/best-practices)、[X ヘルプセンター](https://help.x.com/en/using-x/x-videos)（2026年9月時点）。数値は `src/plan.js` の先頭にまとめてあります。

- 映像は **H.264 High プロファイル**、画素形式 yuv420p、画素比 1:1、プログレッシブで書き出します
- 音声は **AAC-LC のモノラルかステレオ**のときだけそのまま通します。それ以外は音なしになります（画面でお知らせします）
- 比率は **1:3〜3:1** に収めます。外れる動画は余白を足して収めます
- フレームレートは **40fps まで**にします（ウェブからの投稿の上限）。落とすときは元を割り切れる値（60→30、50→25、48→24）にして、動きがカクつかないようにします
- 色は **BT.709** と記して書き出します（元の動画と同じ扱いになり、再生する側で色が変わらないように）
- 長さが2分20秒を超えるとき、サイズが512MBを超えるときは、無料アカウントでは上げられないとお知らせします
- **無料アカウントの再生は720pまで**です。1080pで書き出すときはその旨を出します

## うまくいかないこと
- **HDRの動画**は、SDRへの変換の仕方がブラウザ任せで、色が変わることがあります。検出してお知らせしたうえで変換します
- **Xは必ず再エンコードします**。この道具で綺麗に整えても、Xの側で画質は落ちます。元を綺麗に渡すほうが結果は良くなりますが、元のままにはなりません
- 音声を作り直す機能はありません（Firefox に AAC を書き出す機能がないため）。音量をそろえる機能は今のところありません
- 複数のファイルをまとめて変換することはできません

## 仕組み
- 大きさを変えるときは、横と縦に分けて lanczos2 で拾い直します。そのまま間引くと、細い線がギザつき、動く場面でちらつくためです
- ぼかし背景は少し暗く、色を薄くして、手前の映像を引き立てます。縮めてぼかした絵は、B-spline でなめらかに引き伸ばします
- テロップは行の長さをそろえて折り返し、カタカナの言葉の途中では折りません。フチ文字にはうっすら影を付けます
- 復号・合成・符号化は **WebCodecs**、mp4 の読み書きは **mediabunny**。どちらもブラウザの中で動きます。サーバーはありません
- 重い処理は Web Worker に置いています。画面は止まりませんし、途中でやめられます
- かたちの計算・ビットレート・切り出し位置は純粋な計算に切り出してあり、ブラウザなしで検証できます（`npm test`）
- 回転は合成のときに画へ焼き込み、出力には回転情報を残しません（二重に回るのを防ぐため）
- **外へ送る処理は、コードのどこにも書いてありません。** `src/` を `fetch`・`XMLHttpRequest`・`WebSocket`・`sendBeacon` で探しても1件も出ません。変換中の通信が0件であることは開発者ツールの通信タブで確かめられます
- 加えて HTML の先頭の `Content-Security-Policy`（`connect-src 'none'`）で、画面側からの通信を止めてあります。厳密にはこの指定が効くのは画面そのものだけで、Web Worker は配信元が返すヘッダに従います（GitHub Pages はヘッダを付けられません）。**証拠はコードと通信タブのほうで、CSP は念押し**という順です

## 直したい人へ
- `node tools/serve.mjs` で開いて、`npm test`（計算の検証）と `npx -y -p typescript@5.7 tsc --noEmit -p jsconfig.json`（型の検査）が通ることを確かめてください
- 実機での確認は `node tools/make-samples.mjs`（試験素材を作る）→ `node tools/check-convert.mjs`（変換して ffprobe で検査）→ `node tools/check-ui.mjs`（画面を操作して通す）
- ライブラリを足すときは **MIT / BSD / Apache-2.0 / MPL-2.0（無改変）** のみにしてください。GPL・LGPL のものは入れません。README の表と `vendor/*/LICENSE` も更新してください
- `tools/serve.mjs` は手元専用です。127.0.0.1 にしか耳を貸さず、`Host` と `Origin` が自分のものかを見てから受けます（動かしている間、同じパソコンで開いている別のページから叩かれないように）
- `test/` と `tools/` は `_config.yml` で公開対象から外しています。置き場に上げる意味がなく、`test/*.html` には CSP を書いていないためです

## 同梱しているもの（サードパーティ）
| 内容 | 場所 | ライセンス |
|---|---|---|
| mediabunny 1.60.0 | `vendor/mediabunny/` | MPL-2.0（`vendor/mediabunny/LICENSE`。無改変で同梱しています） |
| Zen Kaku Gothic New | `fonts/zen-kaku-gothic-new/` | SIL Open Font License 1.1（同フォルダの `LICENSE`） |

フォントは @fontsource 配布のファイルを改変せずに置き、打たれた文字に必要な分だけブラウザが読み込みます。

## English
**Shitagoshirae** gets a video ready to post on X — reshape it, pad it with a blurred background, trim it, hit a target file size, and burn in captions. **Your video is never uploaded.** Everything happens inside your browser.

- **Use it:** https://aiimpl.github.io/shitagoshirae/ — no sign-up, no server, nothing to install.
- **What it does:** shape (keep / 16:9 / 1:1 / 9:16) with blurred, solid or cropped padding; a timeline where you split the clip and drop the parts you do not want; fade in/out; quality or target-size encoding; audio carried through untouched (or muted); burned-in captions in three styles (outlined, black bar, colour chip), typed in or loaded from an SRT file. It also converts iPhone HEVC to H.264 and bakes in rotation, which is what usually breaks portrait phone videos.
- **Browsers:** Chrome, Edge, Safari 26+, and desktop Firefox. Firefox on Android has no WebCodecs and cannot run it. The page tells you plainly when it cannot work.
- **Speed:** a 40-second 1920×1080 clip takes about 5 seconds to re-encode at 1080p on an M5 Mac in Chrome — roughly 8× faster than real time.
- **How it works:** WebCodecs for decode/encode, [mediabunny](https://github.com/Vanilagy/mediabunny) for MP4 reading and writing, WebGL2 for the blur and layout, all inside a Web Worker. No server, no API, no upload.
- **It does not phone home:** there is no `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` anywhere in `src/` — grep it — and the network tab stays empty while converting. The page also carries a `Content-Security-Policy` with `connect-src 'none'`; note that a `<meta>` CSP governs the document, not a Worker loaded over https (GitHub Pages cannot send headers), so the code and the network tab are the evidence and the CSP is the belt-and-braces.
- **Known limits:** HDR to SDR conversion is left to the browser and can shift colors; X always re-encodes what you upload, so some quality is lost on their side no matter what; audio is never re-encoded (Firefox cannot encode AAC), so formats other than AAC-LC become silent.

Built with Claude Opus 5.5.
