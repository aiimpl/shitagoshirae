// 画面の進行：入れる → 調べる → 決める → 変換する → 保存する
// @ts-check

import { t, lang, setLang, applyStatic } from './i18n.js';
import { probeFile, checkBrowser } from './probe.js';
import { buildPlan, estimateOutputBytes } from './plan.js';
import { buildCaptionTimeline, layoutCaptionSegment } from './captions.js';
import { rasterizeBands, makeTextMeasurer, closeBitmaps, loadFonts } from './caption-raster.js';
import { startConversion, CancelledError, outputName, warmUp } from './convert.js';
import { saveBlob } from './save.js';
import { formatBytes, formatEta, formatClock } from './progress.js';
import { $, segment, renderMeta, renderWarnings, renderCueEditor, Preview, describeProbe } from './ui.js';
import { Timeline } from './timeline.js';

applyStatic(document);

const FONT_FAMILY = '"Zen Kaku Gothic New","Hiragino Sans",sans-serif';

/** @type {import('./types.js').Settings} */
const settings = {
  shape: 'keep',
  pad: 'blur',
  padColor: '#101418',
  blurStrength: 0.6,
  resolution: '720p',
  inUs: 0,
  outUs: 0,
  sizeMode: 'quality',
  targetBytes: 30 * 1024 * 1024,
  quality: 'high',
  maxFps: 60,
  audio: 'copy',
  cues: [],
};

/** @type {{ file: File|null, probe: import('./types.js').Probe|null, plan: import('./types.js').Plan|null }} */
const state = { file: null, probe: null, plan: null };
/** @type {{ cancel: () => void }|null} */
let job = null;
/** @type {Blob|null} */
let resultBlob = null;
let resultName = 'video_x.mp4';

const video = document.createElement('video');
video.muted = true;
video.loop = true;
video.playsInline = true;
const preview = new Preview(/** @type {HTMLCanvasElement} */ ($('pv')));
preview.setVideo(video);
const measureText = makeTextMeasurer();

/** @type {string|null} */
let selectedCueId = null;

const timeline = new Timeline($('timeline'), {
  onTrim: (inUs, outUs) => {
    settings.inUs = inUs;
    settings.outUs = outUs;
    seekPreview(inUs);
    refresh();
  },
  onCues: () => {
    drawCueEditor();
    refresh();
  },
  onSelect: (id) => {
    selectedCueId = id;
    timeline.select(id);
    drawCueEditor();
  },
  onSeek: (us) => seekPreview(us),
});
timeline.setVideo(video);

/** 下見の再生位置を動かす @param {number} us */
function seekPreview(us) {
  const probe = state.probe;
  if (!probe) {
    return;
  }
  video.currentTime = Math.max(0, Math.min(probe.durationUs - 1000, us)) / 1e6;
}

// ---- 言語 ----
$('bLang').onclick = () => {
  setLang(lang === 'ja' ? 'en' : 'ja');
  location.reload();
};

// ---- 入口 ----
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('on');
  });
}
for (const type of ['dragleave', 'dragend', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('on'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0];
  if (file) {
    load(file);
  }
});
drop.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) {
      load(file);
    }
  };
  input.click();
});

// ---- 設定の切り替え ----
segment($('segShape'), settings.shape, (v) => {
  settings.shape = /** @type {any} */ (v);
  refresh();
});
segment($('segPad'), settings.pad, (v) => {
  settings.pad = /** @type {any} */ (v);
  refresh();
});
segment($('segRes'), settings.resolution, (v) => {
  settings.resolution = /** @type {any} */ (v);
  refresh();
});
segment($('segSizeMode'), settings.sizeMode, (v) => {
  settings.sizeMode = /** @type {any} */ (v);
  $('rowQuality').hidden = v === 'size';
  $('rowTarget').hidden = v !== 'size';
  refresh();
});
segment($('segQuality'), settings.quality, (v) => {
  settings.quality = /** @type {any} */ (v);
  refresh();
});
segment($('segAudio'), settings.audio, (v) => {
  settings.audio = /** @type {any} */ (v);
  refresh();
});
/** @type {HTMLInputElement} */ ($('targetMb')).onchange = (e) => {
  const mb = Math.max(1, Number(/** @type {HTMLInputElement} */ (e.target).value) || 30);
  settings.targetBytes = Math.round(mb * 1024 * 1024);
  refresh();
};

$('bAddCue').onclick = () => {
  const probe = state.probe;
  if (!probe) {
    return;
  }
  // いま見ているところに置く
  const head = Math.round(video.currentTime * 1e6);
  const startUs = Math.max(0, Math.min(head, probe.durationUs - 2_000_000));
  const cue = {
    id: `c${Date.now()}`,
    text: '',
    startUs,
    endUs: Math.min(probe.durationUs, startUs + 2_500_000),
    position: /** @type {const} */ ('bottom'),
    size: 1,
    outline: true,
  };
  settings.cues.push(cue);
  selectedCueId = cue.id;
  timeline.setCues(settings.cues);
  timeline.select(cue.id);
  drawCueEditor();
  refresh();
};

$('bConvert').onclick = () => convert();
$('bCancel').onclick = () => job?.cancel();
$('bSave').onclick = () => save();
$('bRedo').onclick = () => show('work');
$('bAgain').onclick = () => reset();
$('bErrBack').onclick = () => reset();

// ---- 流れ ----

/**
 * @param {'drop'|'work'|'running'|'result'|'error'} name
 */
function show(name) {
  $('drop').hidden = name !== 'drop';
  $('work').hidden = name !== 'work';
  $('running').hidden = name !== 'running';
  $('result').hidden = name !== 'result';
  $('error').hidden = name !== 'error';
  if (name === 'work') {
    preview.start();
    startTick();
    // 設定をいじっている間に、変換の係を読み込んでおく（押してから読むと、回線がない場で始められない）
    warmUp();
  } else {
    preview.stop();
  }
}

/**
 * @param {string} message
 */
function fail(message) {
  $('errorBody').textContent = message;
  show('error');
}

function reset() {
  state.file = null;
  state.probe = null;
  state.plan = null;
  resultBlob = null;
  settings.cues = [];
  video.removeAttribute('src');
  show('drop');
}

/**
 * @param {File} file
 */
async function load(file) {
  const support = checkBrowser();
  if (!support.ok) {
    fail(t('err.unsupported'));
    return;
  }
  try {
    const probe = await probeFile(file);
    if (!probe.video) {
      fail(t('w.noVideo'));
      return;
    }
    state.file = file;
    state.probe = probe;
    settings.inUs = 0;
    settings.outUs = probe.durationUs;
    // 元が縦長なら、そのままの形を既定にする
    settings.shape = 'keep';
    video.src = URL.createObjectURL(file);
    video.currentTime = 0;
    await video.play().catch(() => undefined);
    renderMeta($('inmeta'), describeProbe(probe));
    selectedCueId = null;
    timeline.setRange(probe.durationUs, 0, probe.durationUs);
    timeline.setCues(settings.cues);
    drawCueEditor();
    refresh();
    show('work');
    // コマ送りの絵は、画面を出してから作る（少し時間がかかるため）
    timeline.buildThumbnails(video, probe.durationUs).catch(() => undefined);
  } catch (err) {
    console.error(err);
    fail(t('err.read'));
  }
}

function drawCueEditor() {
  const cue = settings.cues.find((c) => c.id === selectedCueId) || null;
  renderCueEditor($('cueEdit'), cue, {
    onChange: () => {
      timeline.setCues(settings.cues);
      refresh();
    },
    onRemove: () => {
      settings.cues = settings.cues.filter((c) => c.id !== selectedCueId);
      selectedCueId = null;
      timeline.setCues(settings.cues);
      drawCueEditor();
      refresh();
    },
  });
}

/** 設定が変わるたびに、計画と下見を作り直す */
function refresh() {
  const probe = state.probe;
  if (!probe) {
    return;
  }
  const plan = buildPlan(probe, settings);
  state.plan = plan;

  // ぼかしと単色は、余白ができないときには効かないので、そのことが分かるようにする
  const bands = settings.cues.length
    ? buildCaptionTimeline(settings.cues).flatMap((seg) => layoutCaptionSegment(seg, {
      width: plan.video.width,
      height: plan.video.height,
      fontFamily: FONT_FAMILY,
    }, measureText))
    : [];
  preview.setPlan(plan, bands);
  if (bands.length) {
    // 打っている間にフォントを読んでおく（変換のときに読むと、回線がない場で別の字になる）
    loadFonts(bands);
  }

  const estimated = estimateOutputBytes({
    videoBitrateBps: plan.video.bitrateBps,
    audioBitrateBps: plan.audio.bitrateBps,
    durationUs: plan.trim.durationUs,
  });
  renderMeta($('pvmeta'), [
    [t('out.title'), `${plan.video.width}×${plan.video.height}`],
    [t('in.duration'), formatClock(plan.trim.durationUs)],
    [t('in.bitrate'), `${(plan.video.bitrateBps / 1e6).toFixed(1)} Mbps`],
    [t('out.estimate'), formatBytes(estimated)],
  ]);
  $('trimLabel').textContent = `${formatClock(plan.trim.inUs)} 〜 ${formatClock(plan.trim.outUs)}（${formatClock(plan.trim.durationUs)}）`;
  $('audioNote').textContent = plan.audio.mode === 'copy' ? '' : t(plan.audio.reason);
  renderWarnings($('warns'), plan.warnings);
  /** @type {HTMLButtonElement} */ ($('bConvert')).disabled = plan.blocked;
  $('estimate').textContent = plan.blocked ? '' : `${t('out.estimate')} ${formatBytes(estimated)}`;
}

async function convert() {
  const file = state.file;
  const plan = state.plan;
  if (!file || !plan || plan.blocked) {
    return;
  }
  show('running');
  $('barFill').style.width = '0%';
  $('runinfo').textContent = '';

  /** @type {import('./types.js').CaptionBitmap[]} */
  let captions = [];
  try {
    if (settings.cues.length) {
      const bands = buildCaptionTimeline(settings.cues).flatMap((seg) => layoutCaptionSegment(seg, {
        width: plan.video.width,
        height: plan.video.height,
        fontFamily: FONT_FAMILY,
      }, measureText));
      captions = (await rasterizeBands(bands)).bitmaps;
    }
    const run = startConversion({
      file,
      plan,
      captions,
      name: outputName(file.name),
      onProgress: (p) => {
        $('barFill').style.width = `${Math.round(p.ratio * 100)}%`;
        const speed = p.speed > 0 ? (p.speed / 1000).toFixed(1) : '…';
        $('runinfo').textContent = [
          `${Math.round(p.ratio * 100)}%`,
          formatEta(p.etaMs, lang),
          t('run.speed', speed),
          formatBytes(p.encodedBytes),
        ].join('　');
      },
    });
    job = run;
    const result = await run.done;
    resultBlob = result.blob;
    resultName = result.suggestedName;
    showResult(result);
  } catch (err) {
    if (err instanceof CancelledError) {
      show('work');
      return;
    }
    console.error(err);
    fail(`${t('err.convert')} ${err instanceof Error ? err.message : ''}`);
  } finally {
    job = null;
    closeBitmaps(captions);
  }
}

/**
 * @param {import('./convert.js').ConversionResult} result
 */
function showResult(result) {
  $('resultTitle').textContent = t('run.done');
  const probe = state.probe;
  renderMeta($('resultMeta'), [
    [t('out.title'), `${result.width}×${result.height}`],
    [t('in.size'), `${probe ? formatBytes(probe.fileSize) + ' → ' : ''}${formatBytes(result.blob.size)}`],
    [t('in.duration'), formatClock(result.durationUs)],
    ['', `${(result.elapsedMs / 1000).toFixed(1)}s`],
  ]);
  const el = /** @type {HTMLVideoElement} */ ($('resultVideo'));
  if (el.src) {
    URL.revokeObjectURL(el.src);
  }
  el.src = URL.createObjectURL(result.blob);
  $('saveNote').textContent = '';
  show('result');
}

async function save() {
  if (!resultBlob) {
    return;
  }
  const how = await saveBlob(resultBlob, resultName);
  if (how !== 'cancelled') {
    $('saveNote').textContent = `${t('run.saved')} ${t('run.savedNote')}`;
  }
}

/** 再生位置の線を動かし続ける */
let ticking = false;
function startTick() {
  if (ticking) {
    return;
  }
  ticking = true;
  const loop = () => {
    if ($('work').hidden) {
      ticking = false;
      return;
    }
    timeline.tick();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

show('drop');
