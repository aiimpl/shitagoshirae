// 型だけを置く場所（実行されるコードはない）
// @ts-check

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/** @typedef {0|90|180|270} Rotation */

/** 出力のかたち。keep は元の比率のまま */
/** @typedef {'keep'|'16:9'|'1:1'|'9:16'} Shape */

/** 余白の埋め方。crop は余白を作らずに切り取る */
/** @typedef {'blur'|'color'|'crop'} PadMode */

/**
 * 回転した見た目の空間の uv を、復号したままの画素の uv に移す式。
 * u' = m[0]*u + m[1]*v + t[0] ／ v' = m[2]*u + m[3]*v + t[1]
 * @typedef {{ m: [number, number, number, number], t: [number, number] }} UvTransform
 */

/**
 * 画をどう置くかの計算結果。すべて純粋計算で決まる
 * @typedef {Object} Geometry
 * @property {number} srcWidth    復号したままの幅（回転前）
 * @property {number} srcHeight   復号したままの高さ（回転前）
 * @property {Rotation} rotation  コンテナに入っていた回転。合成のときに当てる
 * @property {number} outWidth    出力の幅（偶数）
 * @property {number} outHeight   出力の高さ（偶数）
 * @property {Rect} sourceUv      回転後の見た目の空間で、どこを読むか（0〜1）
 * @property {Rect} foreground    出力画素の座標で、くっきりした映像が乗る場所
 * @property {Rect} background    出力画素の座標で、ぼかし背景を敷く場所（はみ出す）
 * @property {UvTransform} uv     回転を当てる式
 * @property {boolean} needsPad   余白ができるか
 * @property {boolean} clampedAspect  比率が 1:3〜3:1 に収まらず、詰めたか
 */

/**
 * 入力ファイルを調べた結果
 * @typedef {Object} Probe
 * @property {string} fileName
 * @property {number} fileSize
 * @property {string} container
 * @property {number} durationUs
 * @property {VideoProbe|null} video
 * @property {AudioProbe|null} audio
 */

/**
 * @typedef {Object} VideoProbe
 * @property {string} codec            'avc' | 'hevc' | 'vp9' | 'av1' など
 * @property {string} codecString
 * @property {number} codedWidth       復号したままの幅（回転前）
 * @property {number} codedHeight
 * @property {number} displayWidth     回転を当てた、見た目の幅
 * @property {number} displayHeight
 * @property {Rotation} rotation
 * @property {number} fps              平均。可変のことがある
 * @property {boolean} variableFrameRate
 * @property {number} bitrateBps
 * @property {number[]} keyframeUs     昇順
 * @property {boolean} hdr
 * @property {number|null} bitDepth
 * @property {boolean} decodable       このブラウザで復号できるか
 */

/**
 * @typedef {Object} AudioProbe
 * @property {string} codec            'aac' | 'opus' | 'mp3' など
 * @property {string} codecString      'mp4a.40.2'
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitrateBps
 * @property {number} packetUs         1パケットの長さ（AAC 48kHz なら 21333）
 * @property {number} firstPacketUs
 */

/**
 * 画面で選んだ設定
 * @typedef {Object} Settings
 * @property {Shape} shape
 * @property {PadMode} pad
 * @property {string} padColor        '#101418' のような文字列
 * @property {number} blurStrength    0〜1
 * @property {'720p'|'1080p'|'source'} resolution
 * @property {number} inUs
 * @property {number} outUs
 * @property {'size'|'quality'} sizeMode
 * @property {number} targetBytes
 * @property {'low'|'medium'|'high'} quality
 * @property {number} maxFps
 * @property {'copy'|'mute'} audio
 * @property {Cue[]} cues
 */

/**
 * テロップ1つ
 * @typedef {Object} Cue
 * @property {string} id
 * @property {string} text
 * @property {number} startUs
 * @property {number} endUs
 * @property {'top'|'middle'|'bottom'} position
 * @property {number} size            1 が既定（出力の高さの約5%）
 * @property {boolean} outline
 * @property {string} [color]
 * @property {string} [outlineColor]
 */

/**
 * 焼き込むテロップ1枚ぶん（絵にしたもの）
 * @typedef {Object} CaptionBitmap
 * @property {string} key       同じ絵なら同じ値。読み込み直しを省くために使う
 * @property {number} startUs
 * @property {number} endUs
 * @property {Rect} rect        出力画素の座標
 * @property {ImageBitmap} bitmap
 */

/**
 * 画面に出す注意書き。level が block なら変換させない
 * @typedef {{ level: 'info'|'warn'|'block', code: string, args?: Record<string, string|number> }} Warning
 */

/**
 * 変換の計画。Worker へそのまま渡すので、素の値だけで作る（関数やクラスを入れない）
 * @typedef {Object} Plan
 * @property {PlanVideo} video
 * @property {PlanAudio} audio
 * @property {PlanTrim} trim
 * @property {Warning[]} warnings
 * @property {boolean} blocked
 */

/**
 * @typedef {Object} PlanVideo
 * @property {number} width
 * @property {number} height
 * @property {Geometry} geometry
 * @property {PadMode} pad
 * @property {[number, number, number, number]} padRgba  0〜1
 * @property {number} blurRadiusPx
 * @property {number} bitrateBps
 * @property {string[]} codecCandidates   上から順に試す
 * @property {number} maxFps
 * @property {number} minFrameDeltaUs     これより短い間隔のフレームは捨てる
 * @property {number} keyframeIntervalUs
 */

/**
 * @typedef {Object} PlanTrim
 * @property {number} inUs           映像の開始（フレーム単位で正確）
 * @property {number} outUs
 * @property {number} durationUs
 * @property {number} decodeFromUs   直前のキーフレーム。復号はここから始める
 * @property {number} audioInUs      音声パケットの切れ目に切り上げた開始
 * @property {number} audioOutUs     切れ目に切り下げた終わり
 * @property {number} avOffsetUs     audioInUs - inUs（0以上）
 */

/**
 * @typedef {Object} PlanAudio
 * @property {'copy'|'drop'} mode
 * @property {string} reason         i18n のキー。copy のときは ''
 * @property {number} bitrateBps     見積もりに使う。drop なら 0
 */

export {};
