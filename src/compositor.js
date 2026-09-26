// ぼかし背景・余白・回転・テロップを1枚に合成する（WebGL2）
//
// 決めごと（ここを崩すと見た目の不具合が追えなくなる）
//   ・座標はすべて「出力画素・左上が原点・y は下向き」。クリップ空間への変換は頂点シェーダの1か所だけ
//   ・alpha: false / premultipliedAlpha: false / UNPACK_FLIP_Y_WEBGL は既定（false）のまま
//   ・回転は geometry.uv（2x2＋平行移動）だけで当てる。ここ以外で回転を当てない
//   ・くっきりした映像を標本化するのは1回だけ（回転と拡大縮小をまとめて当てる）
// @ts-check

/** @typedef {import('./types.js').PlanVideo} PlanVideo */
/** @typedef {import('./types.js').Rect} Rect */

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;   // 出力画素での置き場所（x, y, w, h）
uniform vec2 uOut;    // 出力の大きさ
uniform vec4 uUvRect; // 読む範囲（0〜1）
uniform float uFlip;  // 画面へ描くとき +1、テクスチャへ描くとき -1
out vec2 vUv;
void main() {
  vec2 px = uRect.xy + aPos * uRect.zw;
  // 画面は上が y=0、テクスチャは下が v=0。テクスチャへ描くときは上下を返して、
  // どの絵も「上が v=0」でそろうようにする
  vec2 ndc = vec2(px.x / uOut.x * 2.0 - 1.0, uFlip * (1.0 - px.y / uOut.y * 2.0));
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUv = uUvRect.xy + aPos * uUvRect.zw;
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform mat2 uUvM;
uniform vec2 uUvT;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 uv = uUvM * vUv + uUvT;
  vec4 c = texture(uTex, clamp(uv, 0.0, 1.0));
  outColor = vec4(c.rgb, c.a * uAlpha);
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;   // 1回ずらす量（uv 単位）
out vec4 outColor;
void main() {
  // 9点のガウスぼかし（重みは 1/16, 4/16, 6/16 の組み合わせを2回に分けたもの）
  float w[5] = float[](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  vec4 sum = texture(uTex, vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uStep * float(i);
    sum += texture(uTex, clamp(vUv + off, 0.0, 1.0)) * w[i];
    sum += texture(uTex, clamp(vUv - off, 0.0, 1.0)) * w[i];
  }
  outColor = sum;
}`;

const FRAG_SOLID = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}`;

// ぼかしは縮めた絵にかける。8分の1なら、見た目は同じで処理は64分の1で済む
const BLUR_SCALE = 8;

export class Compositor {
  /**
   * @param {{ width: number, height: number }} size
   */
  constructor(size) {
    this.width = size.width;
    this.height = size.height;
    this.canvas = new OffscreenCanvas(size.width, size.height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      desynchronized: true,
    });
    if (!gl) {
      throw new Error('WebGL2 が使えません');
    }
    this.gl = gl;
    this.blit = makeProgram(gl, VERT, FRAG_BLIT);
    this.blur = makeProgram(gl, VERT, FRAG_BLUR);
    this.solid = makeProgram(gl, VERT, FRAG_SOLID);
    this.quad = makeQuad(gl);
    this.srcTex = makeTexture(gl);
    /** 同じ絵を何度も読み込まないための控え。key → テクスチャ @type {Map<string, WebGLTexture>} */
    this.overlayTextures = new Map();
    this.blurW = Math.max(2, Math.round(size.width / BLUR_SCALE));
    this.blurH = Math.max(2, Math.round(size.height / BLUR_SCALE));
    this.fboA = makeFbo(gl, this.blurW, this.blurH);
    this.fboB = makeFbo(gl, this.blurW, this.blurH);
    /** @type {PlanVideo|null} */
    this.video = null;
  }

  /**
   * @param {PlanVideo} video
   */
  configure(video) {
    this.video = video;
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * 1枚合成する。結果は this.canvas に入る
   * （transferToImageBitmap は WebGL の面では通らない環境があるため、キャンバスのまま渡す）
   * @param {VideoFrame} frame
   * @param {{ bitmap: ImageBitmap, rect: Rect, key: string }[]} overlays  同時に出すテロップ（上・中・下）
   * @param {number} [fade] そのままなら1、真っ暗なら0（出だしと終わりに使う）
   * @returns {OffscreenCanvas}
   */
  draw(frame, overlays, fade = 1) {
    const gl = this.gl;
    const v = this.video;
    if (!v) {
      throw new Error('configure を呼ぶ前に描こうとしました');
    }
    const g = v.geometry;

    // 元の1枚を読み込む（標本化はこのあと最大2回：ぼかし用の縮小と、本体）
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    if (v.pad === 'blur' && g.needsPad) {
      this.renderBlur(g);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const [r, gg, b] = v.padRgba;
    gl.clearColor(r, gg, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (v.pad === 'blur' && g.needsPad) {
      // ぼかした縮図を、そのまま画面いっぱいに引き伸ばす
      this.drawTexture(this.fboA.tex, { x: 0, y: 0, w: this.width, h: this.height }, { x: 0, y: 0, w: 1, h: 1 }, identityUv(), 1);
    }
    // くっきりした本体。回転と切り抜きをここでまとめて当てる
    this.drawTexture(this.srcTex, g.foreground, g.sourceUv, g.uv, 1);

    for (const overlay of overlays) {
      const tex = this.overlayTexture(overlay);
      this.drawTexture(tex, overlay.rect, { x: 0, y: 0, w: 1, h: 1 }, identityUv(), 1);
    }
    if (fade < 1) {
      // 上から黒をかぶせて、ふわっと出し入れする
      gl.useProgram(this.blit.program);
      this.drawSolid([0, 0, 0, 1 - Math.max(0, Math.min(1, fade))]);
    }
    // 描いた内容を確実に出してから返す
    gl.flush();
    return this.canvas;
  }

  /**
   * 画面いっぱいを単色で塗る（ふわっと出し入れするときに使う）
   * @param {[number, number, number, number]} rgba
   */
  drawSolid(rgba) {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.solid.program);
    gl.uniform4f(this.solid.uniforms.uRect, 0, 0, this.width, this.height);
    gl.uniform2f(this.solid.uniforms.uOut, this.width, this.height);
    gl.uniform4f(this.solid.uniforms.uUvRect, 0, 0, 1, 1);
    gl.uniform1f(this.solid.uniforms.uFlip, 1);
    gl.uniform4f(this.solid.uniforms.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * 背景用に、縮めた絵をぼかす。
   * ぼかし用の面は、出力をそのまま縮めた縮図として扱う（置き場所も縮めて同じ割合にする）
   * @param {import('./types.js').Geometry} g
   */
  renderBlur(g) {
    const gl = this.gl;
    const v = /** @type {PlanVideo} */ (this.video);
    const kx = this.blurW / this.width;
    const ky = this.blurH / this.height;
    const rect = {
      x: g.background.x * kx,
      y: g.background.y * ky,
      w: g.background.w * kx,
      h: g.background.h * ky,
    };
    // 1. 縮める（このときに回転も当てる）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA.fbo);
    gl.viewport(0, 0, this.blurW, this.blurH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawTextureTo(this.blurW, this.blurH, this.srcTex, rect, { x: 0, y: 0, w: 1, h: 1 }, g.uv, 1, -1);
    // 2. 横→縦の順にぼかす。強さに応じて往復する
    const radius = Math.max(1, v.blurRadiusPx / BLUR_SCALE);
    const passes = Math.min(4, Math.max(1, Math.round(radius / 3)));
    gl.useProgram(this.blur.program);
    for (let i = 0; i < passes; i++) {
      this.blurPass(this.fboA, this.fboB, [radius / this.blurW, 0]);
      this.blurPass(this.fboB, this.fboA, [0, radius / this.blurH]);
    }
    gl.enable(gl.BLEND);
  }

  /**
   * @param {{ fbo: WebGLFramebuffer, tex: WebGLTexture }} from
   * @param {{ fbo: WebGLFramebuffer, tex: WebGLTexture }} to
   * @param {[number, number]} step
   */
  blurPass(from, to, step) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
    gl.viewport(0, 0, this.blurW, this.blurH);
    gl.useProgram(this.blur.program);
    gl.uniform4f(this.blur.uniforms.uRect, 0, 0, this.blurW, this.blurH);
    gl.uniform2f(this.blur.uniforms.uOut, this.blurW, this.blurH);
    gl.uniform4f(this.blur.uniforms.uUvRect, 0, 0, 1, 1);
    gl.uniform1f(this.blur.uniforms.uFlip, -1);
    gl.uniform2f(this.blur.uniforms.uStep, step[0], step[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(this.blur.uniforms.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * いまの描き先に1枚貼る
   * @param {WebGLTexture} tex
   * @param {Rect} rect
   * @param {Rect} uvRect
   * @param {import('./types.js').UvTransform} uv
   * @param {number} alpha
   */
  drawTexture(tex, rect, uvRect, uv, alpha) {
    this.drawTextureTo(this.width, this.height, tex, rect, uvRect, uv, alpha, 1);
  }

  /**
   * @param {number} outW
   * @param {number} outH
   * @param {WebGLTexture} tex
   * @param {Rect} rect
   * @param {Rect} uvRect
   * @param {import('./types.js').UvTransform} uv
   * @param {number} alpha
   * @param {number} flip  画面へ描くとき +1、テクスチャへ描くとき -1
   */
  drawTextureTo(outW, outH, tex, rect, uvRect, uv, alpha, flip) {
    const gl = this.gl;
    const p = this.blit;
    gl.useProgram(p.program);
    gl.uniform4f(p.uniforms.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform2f(p.uniforms.uOut, outW, outH);
    gl.uniform4f(p.uniforms.uUvRect, uvRect.x, uvRect.y, uvRect.w, uvRect.h);
    gl.uniform1f(p.uniforms.uFlip, flip);
    // GLSL の mat2 は列優先なので、[m0, m2, m1, m3] の順で渡す
    gl.uniformMatrix2fv(p.uniforms.uUvM, false, [uv.m[0], uv.m[2], uv.m[1], uv.m[3]]);
    gl.uniform2f(p.uniforms.uUvT, uv.t[0], uv.t[1]);
    gl.uniform1f(p.uniforms.uAlpha, alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.uniforms.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * テロップの絵を読み込む（同じ絵なら読み込み直さない）
   * @param {{ bitmap: ImageBitmap, key: string }} overlay
   * @returns {WebGLTexture}
   */
  overlayTexture(overlay) {
    const found = this.overlayTextures.get(overlay.key);
    if (found) {
      return found;
    }
    const gl = this.gl;
    // 控えが増えすぎないよう、古いものから捨てる
    if (this.overlayTextures.size >= 8) {
      const oldest = this.overlayTextures.keys().next().value;
      if (oldest !== undefined) {
        const tex = this.overlayTextures.get(oldest);
        if (tex) {
          gl.deleteTexture(tex);
        }
        this.overlayTextures.delete(oldest);
      }
    }
    const tex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay.bitmap);
    this.overlayTextures.set(overlay.key, tex);
    return tex;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.srcTex);
    for (const tex of this.overlayTextures.values()) {
      gl.deleteTexture(tex);
    }
    this.overlayTextures.clear();
    gl.deleteFramebuffer(this.fboA.fbo);
    gl.deleteTexture(this.fboA.tex);
    gl.deleteFramebuffer(this.fboB.fbo);
    gl.deleteTexture(this.fboB.tex);
    gl.deleteProgram(this.blit.program);
    gl.deleteProgram(this.blur.program);
    gl.deleteProgram(this.solid.program);
    gl.deleteVertexArray(this.quad);
    // 明け渡し（使い終わったことをブラウザに伝える）
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * WebGL の作成系は null を返すことがある。落ちる場所をはっきりさせるために包む
 * @template T
 * @param {T|null} value
 * @param {string} what
 * @returns {T}
 */
function must(value, what) {
  if (!value) {
    throw new Error(`${what} を作れませんでした`);
  }
  return value;
}

/** @returns {import('./types.js').UvTransform} */
function identityUv() {
  return { m: [1, 0, 0, 1], t: [0, 0] };
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 */
function makeProgram(gl, vertSrc, fragSrc) {
  const program = must(gl.createProgram(), 'シェーダの入れ物');
  for (const [type, src] of [[gl.VERTEX_SHADER, vertSrc], [gl.FRAGMENT_SHADER, fragSrc]]) {
    const shader = must(gl.createShader(/** @type {number} */ (type)), 'シェーダ');
    gl.shaderSource(shader, /** @type {string} */ (src));
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('シェーダを組み立てられません: ' + gl.getShaderInfoLog(shader));
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('シェーダをつなげられません: ' + gl.getProgramInfoLog(program));
  }
  /** @type {Record<string, WebGLUniformLocation|null>} */
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) {
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
  }
  return { program, uniforms };
}

/**
 * 0〜1 の四角ひとつ
 * @param {WebGL2RenderingContext} gl
 */
function makeQuad(gl) {
  const vao = must(gl.createVertexArray(), '頂点の並び');
  gl.bindVertexArray(vao);
  const buf = must(gl.createBuffer(), '頂点の置き場');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return vao;
}

/**
 * @param {WebGL2RenderingContext} gl
 */
function makeTexture(gl) {
  const tex = must(gl.createTexture(), '絵の置き場');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 */
function makeFbo(gl, w, h) {
  const tex = makeTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = must(gl.createFramebuffer(), '描き先');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}
