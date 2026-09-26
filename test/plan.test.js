// 変換の計画づくり（ビットレート・切り出し位置・音声の可否・Xの制限）を確かめる
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bitrateForQuality,
  bitrateForTargetSize,
  estimateOutputBytes,
  planCut,
  planCuts,
  normalizeSegments,
  toOutputTimes,
  decideAudioCopy,
  h264Level,
  codecCandidates,
  parseColor,
  baseSideFor,
  buildPlan,
  X,
} from '../src/plan.js';

/** @returns {import('../src/types.js').Probe} */
function sampleProbe(over = {}) {
  return {
    fileName: 'sample.mp4',
    fileSize: 67_829_852,
    container: 'mp4',
    durationUs: 40_000_000,
    video: {
      codec: 'avc',
      codecString: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      rotation: 0,
      fps: 30,
      variableFrameRate: false,
      bitrateBps: 13_562_798,
      keyframeUs: [0, 2_000_000, 4_000_000, 6_000_000],
      hdr: false,
      bitDepth: 8,
      decodable: true,
    },
    audio: null,
    ...over,
  };
}

/** @returns {import('../src/types.js').Settings} */
function sampleSettings(over = {}) {
  return {
    shape: 'keep',
    pad: 'blur',
    padColor: '#101418',
    blurStrength: 0.5,
    resolution: '1080p',
    segments: [{ id: 's0', startUs: 0, endUs: 40_000_000 }],
    fade: false,
    sizeMode: 'quality',
    targetBytes: 30 * 1024 * 1024,
    quality: 'high',
    maxFps: 30,
    audio: 'copy',
    cues: [],
    ...over,
  };
}

test('画質優先のビットレートは、1080p30で9Mbps前後', () => {
  const bps = bitrateForQuality({ width: 1920, height: 1080, fps: 30, quality: 'high' });
  assert.ok(bps > 8_000_000 && bps < 9_500_000, `${bps}`);
  const low = bitrateForQuality({ width: 1920, height: 1080, fps: 30, quality: 'low' });
  assert.ok(low < bps);
});

test('40秒で30MBを狙うと、映像は約5.9Mbpsになる', () => {
  const r = bitrateForTargetSize({ targetBytes: 30 * 1024 * 1024, durationUs: 40_000_000, audioBitrateBps: 128_000 });
  assert.ok(Math.abs(r.videoBitrateBps - 5_900_000) < 200_000, `${r.videoBitrateBps}`);
  assert.equal(r.feasible, true);
});

test('小さすぎる目標サイズは、下限で止めて「無理」と伝える', () => {
  const r = bitrateForTargetSize({ targetBytes: 100 * 1024, durationUs: 60_000_000, audioBitrateBps: 128_000 });
  assert.equal(r.feasible, false);
  assert.equal(r.videoBitrateBps, r.floorBps);
  assert.ok(r.videoBitrateBps > 0);
});

test('見積もったサイズは、狙ったサイズに近い', () => {
  const target = 30 * 1024 * 1024;
  const r = bitrateForTargetSize({ targetBytes: target, durationUs: 40_000_000, audioBitrateBps: 128_000 });
  const bytes = estimateOutputBytes({ videoBitrateBps: r.videoBitrateBps, audioBitrateBps: 128_000, durationUs: 40_000_000 });
  assert.ok(Math.abs(bytes - target) / target < 0.05, `${bytes} vs ${target}`);
});

test('切り出しは、復号をひとつ前のキーフレームから始める', () => {
  const t = planCut({
    inUs: 5_030_000,
    outUs: 9_000_000,
    durationUs: 40_000_000,
    keyframeUs: [0, 2_000_000, 4_000_000, 6_000_000, 8_000_000],
    audioPacketUs: 21_333,
    audioFirstUs: 0,
  });
  assert.equal(t.decodeFromUs, 4_000_000);
  assert.equal(t.inUs, 5_030_000);
  assert.equal(t.outUs - t.inUs, 3_970_000);
  // 音声は切れ目に切り上げるので、必ず映像の開始以降になる
  assert.ok(t.audioInUs >= t.inUs);
  assert.ok(t.avOffsetUs >= 0 && t.avOffsetUs < 21_333);
});

test('音声がないときは、ずれもない', () => {
  const t = planCut({ inUs: 1_000_000, outUs: 2_000_000, durationUs: 5_000_000, keyframeUs: [0], audioPacketUs: 0, audioFirstUs: 0 });
  assert.equal(t.audioInUs, t.inUs);
  assert.equal(t.avOffsetUs, 0);
});

test('終わりが長さを超えていたら、長さに収める', () => {
  const t = planCut({ inUs: 0, outUs: 99_000_000, durationUs: 40_000_000, keyframeUs: [0], audioPacketUs: 0, audioFirstUs: 0 });
  assert.equal(t.outUs, 40_000_000);
  assert.equal(t.outUs - t.inUs, 40_000_000);
});

test('そのまま通せる音声は AAC-LC の1〜2チャンネルだけ', () => {
  const aac = { codec: 'aac', codecString: 'mp4a.40.2', sampleRate: 48000, channels: 2, bitrateBps: 192_000, packetUs: 21_333, firstPacketUs: 0 };
  assert.equal(decideAudioCopy(aac, 'copy').mode, 'copy');
  assert.equal(decideAudioCopy({ ...aac, channels: 6 }, 'copy').reason, 'a.multichannel');
  assert.equal(decideAudioCopy({ ...aac, codecString: 'mp4a.40.5' }, 'copy').reason, 'a.notAacLc');
  assert.equal(decideAudioCopy({ ...aac, codec: 'opus', codecString: 'opus' }, 'copy').reason, 'a.notAacLc');
  assert.equal(decideAudioCopy(aac, 'mute').mode, 'drop');
  assert.equal(decideAudioCopy(null, 'copy').reason, 'a.none');
});

test('H.264の段階は、解像度とフレームレートで上がる', () => {
  assert.equal(h264Level(1920, 1080, 30, 8_000_000), 0x28);
  assert.equal(h264Level(1080, 1920, 60, 12_000_000), 0x2a);
  assert.equal(h264Level(1280, 720, 30, 4_000_000), 0x1f);
});

test('コーデックは High → Main → Baseline の順に試す', () => {
  const list = codecCandidates({ width: 1920, height: 1080, fps: 30, bitrateBps: 8_000_000 });
  assert.deepEqual(list, ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']);
});

test('色の文字列を0〜1の値にする', () => {
  assert.deepEqual(parseColor('#ffffff'), [1, 1, 1, 1]);
  assert.deepEqual(parseColor('#000000'), [0, 0, 0, 1]);
  assert.deepEqual(parseColor('こわれた値'), [0, 0, 0, 1]);
});

test('解像度の指定から、短いほうの辺が決まる', () => {
  assert.equal(baseSideFor('720p', 1920, 1080), 720);
  assert.equal(baseSideFor('1080p', 1920, 1080), 1080);
  assert.equal(baseSideFor('source', 1920, 1080), 1080);
  assert.equal(baseSideFor('source', 640, 480), 480);
});

test('ふつうの1080p動画の計画が、そのまま作れる', () => {
  const plan = buildPlan(sampleProbe(), sampleSettings());
  assert.equal(plan.blocked, false);
  assert.deepEqual([plan.video.width, plan.video.height], [1920, 1080]);
  assert.equal(plan.audio.mode, 'drop'); // 音声トラックがないので
  assert.equal(plan.audio.reason, 'a.none');
  assert.ok(plan.video.codecCandidates[0].startsWith('avc1.6400'));
});

test('計画は Worker へそのまま渡せる（素の値だけでできている）', () => {
  const plan = buildPlan(sampleProbe(), sampleSettings());
  const copy = structuredClone(plan);
  assert.deepEqual(copy, plan);
});

test('短すぎる動画は止める', () => {
  const plan = buildPlan(sampleProbe({ durationUs: 300_000 }), sampleSettings({ segments: [{ id: 's0', startUs: 0, endUs: 300_000 }] }));
  assert.equal(plan.blocked, true);
  assert.ok(plan.warnings.some((w) => w.code === 'w.tooShort'));
});

test('2分20秒を超えると、無料アカウント向けの注意が出る（止めはしない）', () => {
  const long = 200_000_000;
  const plan = buildPlan(sampleProbe({ durationUs: long }), sampleSettings({ segments: [{ id: 's0', startUs: 0, endUs: long }] }));
  assert.equal(plan.blocked, false);
  assert.ok(plan.warnings.some((w) => w.code === 'w.durationOverFree'));
});

test('1080pで出すときは、無料アカウントの再生が720pになることを伝える', () => {
  const plan = buildPlan(sampleProbe(), sampleSettings({ resolution: '1080p' }));
  assert.ok(plan.warnings.some((w) => w.code === 'w.playback720'));
  const plan720 = buildPlan(sampleProbe(), sampleSettings({ resolution: '720p' }));
  assert.ok(!plan720.warnings.some((w) => w.code === 'w.playback720'));
});

test('縦の720p（720x1280）では、再生画質の注意を出さない', () => {
  const plan = buildPlan(sampleProbe(), sampleSettings({ shape: '9:16', resolution: '720p' }));
  assert.deepEqual([plan.video.width, plan.video.height], [720, 1280]);
  assert.ok(!plan.warnings.some((w) => w.code === 'w.playback720'));
});

test('復号できない動画は止める', () => {
  const probe = sampleProbe();
  probe.video.decodable = false;
  probe.video.codec = 'hevc';
  const plan = buildPlan(probe, sampleSettings());
  assert.equal(plan.blocked, true);
  assert.ok(plan.warnings.some((w) => w.code === 'w.cannotDecode'));
});

test('HDRの動画は、色が変わることを伝える', () => {
  const probe = sampleProbe();
  probe.video.hdr = true;
  const plan = buildPlan(probe, sampleSettings());
  assert.ok(plan.warnings.some((w) => w.code === 'w.hdr'));
});

test('Xの制限の数値が、調べたとおりに置かれている', () => {
  assert.equal(X.minDurationUs, 500_000);
  assert.equal(X.maxDurationFreeUs, 140_000_000);
  assert.equal(X.maxBytesFree, 512 * 1024 * 1024);
  assert.equal(X.maxFps, 60);
});

test('区間は、時刻の順に並べて重なりをまとめる', () => {
  const ranges = normalizeSegments([
    { id: 'b', startUs: 5_000_000, endUs: 8_000_000 },
    { id: 'a', startUs: 0, endUs: 6_000_000 },
    { id: 'c', startUs: 12_000_000, endUs: 9_000_000 },
    { id: 'd', startUs: 20_000_000, endUs: 25_000_000 },
  ], 40_000_000);
  assert.deepEqual(ranges, [
    { startUs: 0, endUs: 8_000_000 },
    { startUs: 20_000_000, endUs: 25_000_000 },
  ]);
});

test('いらないところを落とすと、出来上がりの長さが縮む', () => {
  const trim = planCuts({
    segments: [
      { id: 'a', startUs: 0, endUs: 10_000_000 },
      { id: 'b', startUs: 30_000_000, endUs: 40_000_000 },
    ],
    durationUs: 40_000_000,
    keyframeUs: [0, 10_000_000, 20_000_000, 30_000_000],
    audioPacketUs: 0,
    audioFirstUs: 0,
  });
  assert.equal(trim.cuts.length, 2);
  assert.equal(trim.durationUs, 20_000_000);
  assert.equal(trim.cuts[0].outStartUs, 0);
  assert.equal(trim.cuts[1].outStartUs, 10_000_000);
  assert.equal(trim.cuts[1].decodeFromUs, 30_000_000);
});

test('テロップの時刻は、落とした区間をまたぐと切り分けられる', () => {
  const trim = planCuts({
    segments: [
      { id: 'a', startUs: 0, endUs: 10_000_000 },
      { id: 'b', startUs: 30_000_000, endUs: 40_000_000 },
    ],
    durationUs: 40_000_000,
    keyframeUs: [0],
    audioPacketUs: 0,
    audioFirstUs: 0,
  });
  // 5秒〜35秒のテロップ → 前半（5〜10秒）と後半（30〜35秒）に分かれる
  const ranges = toOutputTimes(5_000_000, 35_000_000, trim.cuts);
  assert.deepEqual(ranges, [
    { startUs: 5_000_000, endUs: 10_000_000 },
    { startUs: 10_000_000, endUs: 15_000_000 },
  ]);
  // 落としたところだけにかかるテロップは、どこにも出ない
  assert.deepEqual(toOutputTimes(15_000_000, 20_000_000, trim.cuts), []);
});

test('区間がひとつもないと、変換を止める', () => {
  const plan = buildPlan(sampleProbe(), sampleSettings({ segments: [] }));
  assert.equal(plan.blocked, true);
  assert.ok(plan.warnings.some((w) => w.code === 'w.noRange'));
});

test('ふわっと出し入れは、短い動画では短くなる', () => {
  const short = buildPlan(sampleProbe({ durationUs: 1_200_000 }), sampleSettings({
    fade: true,
    segments: [{ id: 's0', startUs: 0, endUs: 1_200_000 }],
  }));
  assert.ok(short.video.fadeUs > 0);
  assert.ok(short.video.fadeUs <= 200_000);
  const off = buildPlan(sampleProbe(), sampleSettings({ fade: false }));
  assert.equal(off.video.fadeUs, 0);
});
