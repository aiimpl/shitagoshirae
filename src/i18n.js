// 画面に出る文字（日本語・英語）。ブラウザの言語で自動で選び、右上のボタンで切り替えられる
// @ts-check

/** @type {Record<string, [string, string]>} */
const S = {
  // ---- 見出しと入口 ----
  title: ['したごしらえ', 'Shitagoshirae'],
  tagline: [
    'Xに上げる動画を、ブラウザの中だけで整えます。<b>ファイルはどこにも送りません。</b>',
    'Get your video ready for X, entirely inside your browser. <b>Your file is never uploaded.</b>',
  ],
  'drop.title': ['動画をここに落とす', 'Drop a video here'],
  'drop.sub': ['またはクリックして選ぶ（mp4・mov）', 'or click to choose a file (mp4, mov)'],
  'drop.note': [
    '動画はどこにも送られません。読み込みも変換も、この端末の中だけで終わります。',
    'Your video is not sent anywhere. Reading and converting both happen on your device.',
  ],
  'btn.lang': ['English', '日本語'],

  // ---- 読み取った中身 ----
  'in.title': ['入れた動画', 'Your video'],
  'in.size': ['大きさ', 'Size'],
  'in.duration': ['長さ', 'Length'],
  'in.fps': ['フレームレート', 'Frame rate'],
  'in.bitrate': ['ビットレート', 'Bitrate'],
  'in.file': ['ファイル', 'File'],
  'in.codec': ['形式', 'Format'],
  'in.audio': ['音声', 'Audio'],
  'in.none': ['なし', 'none'],
  'in.rotated': ['回転あり', 'rotated'],

  // ---- 設定 ----
  'set.shape': ['かたち', 'Shape'],
  'shape.keep': ['そのまま', 'Keep'],
  'shape.16:9': ['横 16:9', 'Wide 16:9'],
  'shape.1:1': ['正方形', 'Square'],
  'shape.9:16': ['縦 9:16', 'Tall 9:16'],
  'set.pad': ['余白の埋め方', 'Padding'],
  'pad.blur': ['ぼかし', 'Blurred'],
  'pad.color': ['単色', 'Solid'],
  'pad.crop': ['切り抜く', 'Crop'],
  'set.resolution': ['解像度', 'Resolution'],
  'res.720p': ['720p（無料アカウント向け）', '720p (free accounts)'],
  'res.1080p': ['1080p（Premium向け）', '1080p (Premium)'],
  'res.source': ['元のまま', 'Same as source'],
  'set.trim': ['長さを切る', 'Trim'],
  'tl.title': ['タイムライン', 'Timeline'],
  'tl.hint': [
    'つまみを動かすと、使うところを切り出せます。下の帯をつかむとテロップを動かせます。',
    'Drag the handles to trim. Drag the blocks below to move your captions.',
  ],
  'tl.cueLane': ['テロップ', 'Captions'],
  'tl.trimLane': ['使うところ', 'In use'],
  'tl.selected': ['選んでいるテロップ', 'Selected caption'],
  'tl.none': ['テロップを足すと、ここに出ます', 'Add a caption and it will appear here'],
  'tl.loadSrt': ['SRTを読む', 'Load SRT'],
  'tl.srtLoaded': ['{n}本のテロップを読みました', 'Loaded {n} captions'],
  'tl.srtNone': ['読めるテロップがありませんでした', 'No readable captions in that file'],
  'tl.srtSkipped': ['（{n}か所は読めずに飛ばしました）', '({n} block(s) skipped)'],
  'tl.newCue': ['ここに足す', 'Add here'],
  'tl.empty': ['（文字を入れる）', '(type your text)'],
  'tl.split': ['ここで切る', 'Split here'],
  'tl.drop': ['この区間を落とす', 'Drop this part'],
  'tl.one': ['書き出す長さ {0}', 'Output length {0}'],
  'tl.cuts': ['{0}つの区間をつなぐ（合わせて {1}）', 'Joining {0} parts ({1} total)'],
  'set.fade': ['出だしと終わり', 'Fade'],
  'set.speed': ['速さ', 'Speed'],
  'speed.1': ['そのまま', 'Normal'],
  'speed.15': ['1.5倍', '1.5×'],
  'speed.2': ['2倍', '2×'],
  'set.cropPos': ['切り抜く位置', 'Crop position'],
  'a.speed': ['速さを変えると音は消えます。', 'Changing the speed removes the sound.'],
  'cap.color': ['色', 'Colour'],
  'fade.on': ['ふわっと', 'Fade in/out'],
  'fade.off': ['そのまま', 'None'],
  'cap.style': ['見せ方', 'Style'],
  'style.outline': ['白文字＋フチ', 'Outlined'],
  'style.bar': ['黒帯', 'Black bar'],
  'style.chip': ['色帯', 'Color chip'],
  'cap.nudge': ['上下', 'Offset'],
  'set.size': ['画質とサイズ', 'Quality and size'],
  'size.quality': ['画質で決める', 'By quality'],
  'size.size': ['サイズで決める', 'By file size'],
  'quality.low': ['軽さ優先', 'Smaller'],
  'quality.medium': ['ふつう', 'Balanced'],
  'quality.high': ['画質優先', 'Sharper'],
  'set.target': ['目標のサイズ', 'Target size'],
  'set.audio': ['音', 'Sound'],
  'audio.copy': ['そのまま', 'Keep'],
  'audio.mute': ['消す', 'Mute'],
  'set.captions': ['テロップ', 'Captions'],
  'cap.add': ['＋ テロップを足す', '+ Add a caption'],
  'cap.text': ['文字', 'Text'],
  'cap.from': ['出す', 'From'],
  'cap.to': ['消す', 'To'],
  'cap.position': ['位置', 'Place'],
  'pos.top': ['上', 'Top'],
  'pos.middle': ['中', 'Middle'],
  'pos.bottom': ['下', 'Bottom'],
  'cap.size': ['大きさ', 'Size'],
  'cap.remove': ['消す', 'Remove'],
  'cap.note': [
    'Xは音を出さずに再生されることが多いので、大事なことは文字でも出しておくと伝わります。',
    'On X, video usually autoplays muted — captions carry what the sound would say.',
  ],

  // ---- 出来上がりの見込み ----
  'out.title': ['書き出すもの', 'Output'],
  'out.estimate': ['見込みのサイズ', 'Estimated size'],
  'out.preview': ['仕上がりの見え方', 'Preview'],
  'btn.convert': ['変換する', 'Convert'],
  'btn.cancel': ['やめる', 'Cancel'],
  'btn.save': ['保存する', 'Save'],
  'btn.again': ['別の動画を入れる', 'Convert another'],
  'btn.redo': ['設定を変えてやり直す', 'Change settings'],

  // ---- 進み具合と結果 ----
  'run.working': ['変換しています', 'Converting'],
  'run.speed': ['実時間の{0}倍の速さ', '{0}× faster than real time'],
  'run.done': ['できました', 'Done'],
  'run.doneNote': ['{0} → {1}（{2}秒）', '{0} → {1} ({2}s)'],
  'run.cancelled': ['やめました', 'Cancelled'],
  'run.saved': ['保存しました', 'Saved'],
  'run.savedNote': [
    'このままXに上げられます。',
    'It is ready to upload to X.',
  ],

  // ---- 注意書き ----
  'w.tooShort': ['0.5秒より短い動画はXに上げられません。', 'X does not accept videos shorter than 0.5 seconds.'],
  'w.durationOverFree': [
    '長さが{seconds}秒あります。無料アカウントで上げられるのは2分20秒までです（Premiumなら上げられます）。',
    'This is {seconds}s long. Free accounts can post up to 2m20s (Premium can post longer).',
  ],
  'w.sizeOverFree': [
    '見込みのサイズが{mb}MBあります。無料アカウントの上限は512MBです。',
    'The estimated size is {mb}MB. The limit for free accounts is 512MB.',
  ],
  'w.aspectOut': ['この比率はXに上げられません（1:3〜3:1）。', 'X only accepts aspect ratios between 1:3 and 3:1.'],
  'w.aspectClamped': ['比率がXの範囲を超えていたので、余白を足して収めました。', 'The aspect ratio was outside what X accepts, so it was padded to fit.'],
  'w.fpsDropped': [
    '{fps}fps で書き出します（Xのウェブ投稿は40fpsまでのため、それを超える分は落としています）。',
    'Writing at {fps}fps — uploads from the web cap at 40fps, so anything above that is dropped.',
  ],
  'w.playback720': [
    '1080pで書き出しますが、無料アカウントでは720pで再生されます。',
    'This writes 1080p, but free accounts play back at 720p.',
  ],
  'w.hdr': [
    'HDRの動画です。SDRに変換すると色が変わることがあります（ブラウザまかせの部分です）。',
    'This is an HDR video. Converting to SDR can shift the colors — that part is up to the browser.',
  ],
  'w.vfr': ['フレームの間隔がそろっていない動画です。時刻はそのまま保ちます。', 'This video has a variable frame rate. Timestamps are carried through as they are.'],
  'w.cannotDecode': ['この形式（{codec}）は、このブラウザでは読めません。', 'This browser cannot decode {codec}.'],
  'w.avOffset': ['音の頭が{ms}ミリ秒ずれます（音の区切りに合わせているため）。', 'Audio starts {ms}ms later, because it is cut on a packet boundary.'],
  'w.noVideo': ['映像が入っていません。', 'There is no video track in this file.'],
  'a.none': ['音声が入っていません。', 'This file has no audio.'],
  'a.muted': ['音は消します。', 'The sound will be removed.'],
  'a.notAacLc': [
    'この音声はそのまま通せない形式です。音なしで書き出します。',
    'This audio format cannot be carried through, so the output will be silent.',
  ],
  'a.multichannel': [
    'チャンネル数が多い音声です（Xはモノラルかステレオのみ）。音なしで書き出します。',
    'This audio has too many channels (X takes mono or stereo only), so the output will be silent.',
  ],

  // ---- しくじり ----
  'err.title': ['うまくいきませんでした', 'Something went wrong'],
  'err.read': ['この動画を読めませんでした。別のファイルで試してください。', 'Could not read this video. Please try another file.'],
  'err.convert': ['変換の途中で止まりました。', 'The conversion stopped partway.'],
  'err.unsupported': [
    'このブラウザでは動きません。パソコンの Chrome・Edge・Safari 26以降・Firefox でお試しください。',
    'This browser cannot run the converter. Please try Chrome, Edge, Safari 26+, or Firefox on a computer.',
  ],
  'err.noEncoder': [
    'このブラウザでは H.264 を書き出せません。Chrome か Edge でお試しください。',
    'This browser cannot encode H.264. Please try Chrome or Edge.',
  ],

  // ---- 説明 ----
  'about.title': ['この道具について', 'About this tool'],
  'about.body': [
    '動画はサーバーに送りません。読み込みも、ぼかしも、書き出しも、すべてこのページの中だけで行います。'
    + 'このページには、自分のファイル（プログラムとフォント）を読む以外の通信を禁じる設定を入れてあります'
    + '（HTMLの先頭に書いてある Content-Security-Policy がそれです）。'
    + 'コードのどこにも外へ送る処理は書いていないので、開発者ツールの通信タブで実際に確かめられます。',
    'Your video is never sent to a server. Reading, blurring and encoding all happen inside this page. '
    + 'The page carries a Content-Security-Policy (at the top of the HTML) that forbids every request except loading '
    + 'its own files — the code and the fonts. There is no code anywhere that sends anything out, and you can '
    + 'confirm that in the network tab.',
  ],
  'about.repo': ['コードはすべて公開しています', 'All of the code is public'],
};

/** @returns {'ja'|'en'} */
function pick() {
  try {
    const saved = localStorage.getItem('sg:lang');
    if (saved === 'ja' || saved === 'en') {
      return saved;
    }
  } catch (e) {
    // localStorage が使えない環境でも動かす
  }
  return String(navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export let lang = pick();

/** @param {'ja'|'en'} value */
export function setLang(value) {
  lang = value;
  try {
    localStorage.setItem('sg:lang', value);
  } catch (e) {
    // 覚えられなくても、そのときの切り替えは効く
  }
}

/**
 * t('run.speed', 8) → '実時間の8倍の速さ'
 * 名前つきの差し込みもできる： t('w.hdr', { ms: 20 })
 * @param {string} key
 * @param {...(string|number|Record<string, string|number>)} args
 * @returns {string}
 */
export function t(key, ...args) {
  const row = S[key];
  if (!row) {
    return key;
  }
  let text = row[lang === 'ja' ? 0 : 1];
  const named = args.length === 1 && typeof args[0] === 'object' ? args[0] : null;
  if (named) {
    for (const [name, value] of Object.entries(named)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }
  return text.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

// 中に印（<b> など）を含んでよい文。ここに挙げたものだけ HTML として流し込む。
// t() の差し込みは escape しないので、それ以外は必ず文字として入れる
const MARKUP_OK = new Set(['tagline']);

/**
 * HTML の data-t（中身）と data-tp（入力欄のヒント）を差し替える
 * @param {Document|HTMLElement} scope
 */
export function applyStatic(scope) {
  if (scope instanceof Document) {
    scope.documentElement.lang = lang;
  }
  for (const el of scope.querySelectorAll('[data-t]')) {
    const key = /** @type {string} */ (el.getAttribute('data-t'));
    if (MARKUP_OK.has(key)) {
      el.innerHTML = t(key);
    } else {
      el.textContent = t(key);
    }
  }
  for (const el of scope.querySelectorAll('[data-tp]')) {
    /** @type {HTMLInputElement} */ (el).placeholder = t(/** @type {string} */ (el.getAttribute('data-tp')));
  }
}
