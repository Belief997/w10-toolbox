"use strict";
/*
 * 自制应援效果 —— web 端完整移植
 *
 * 严格照搬小程序编辑页预览的实现:
 *   文字  pages/cheer-edit/index.js
 *   背景  utils/cheer-light.js
 *
 * 两条不可动的约定:
 *   1) 预览固定 24fps,由 setTimeout 自累加帧计数驱动(不是 rAF、不读墙上时间)
 *      —— 所以速度只跟「帧数」挂钩,掉帧时动画会变慢而不是跳步,这点必须保留,
 *         否则同一段参数在设备上和这里看到的位移量不一致。
 *   2) 所有运动量按 466×466 画布定义,再乘 `预览像素 / 466`。
 *
 * 文字画在背景之后,不参与背景的缩放、遮罩、模糊、旋转。彩虹只改文字颜色。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CheerPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------- 时钟常量 ----------
  const REF          = 466;   // 基准画布边长
  const PREVIEW_FPS  = 24;
  const RAINBOW_SPEED = 295;  // 466 画布 px/s
  const ROLL_SPEED    = 215;  // 466 画布 px/s
  const MAX_LINES     = 6;
  const LINE_RATIO    = 1.35; // 行距 = 1.35 倍字号

  // ---------- 枚举 ----------
  const TEXT_FX = [
    { value: 'static',    label: '静止' },
    { value: 'scroll',    label: '走马灯' },
    { value: 'multiline', label: '滚动' },
    { value: 'blink',     label: '闪烁' },
    { value: 'rainbow',   label: '彩虹' }
  ];

  const BG_FX = [
    { value: 'none',    label: '静止', period: '不动'  },
    { value: 'breathe', label: '呼吸', period: '2 秒'  },
    { value: 'pulse',   label: '爆闪', period: '0.4 秒'},
    { value: 'open',    label: '开幕', period: '2.5 秒'},
    { value: 'blur',    label: '模糊', period: '1.5 秒'},
    { value: 'rotate',  label: '旋转', period: '2 秒'  }
  ];

  // 排版:单行把各行并成一行,多行按 \n 拆(最多 6 行)。
  // 不在原始枚举里 —— 这是预览端的对比开关,方便不改文案就看两种排法。
  const TEXT_LAYOUT = [
    { value: 'multi',  label: '多行' },
    { value: 'single', label: '单行' }
  ];

  // 圆屏两档。466 是文档的基准画布,360 是另一档设备尺寸;
  // 运动量按 size/466 等比缩放,所以 360 上看到的是同一套动画按比例缩小。
  const SCREENS = [
    { value: 466, label: '466²', note: '基准' },
    { value: 360, label: '360²', note: '' }
  ];

  // 发出前改写(设备只收到枚举)
  const BG_ALIAS = { step: 'open', shrink: 'blur', zoom: 'rotate' };

  // ---------- 小工具 ----------
  const lerp  = (a, b, t) => a + (b - a) * t;
  const wrap  = (v, period) => ((v % period) + period) % period;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // phase 的 1 个单位 = 1.5 秒
  function effectSeconds(phase, speed) {
    const t = (phase || 0) * Math.max(0.25, speed || 1);
    return t * 1.5;
  }

  function cheerLines(text) {
    return String(text || '')
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_LINES);
  }

  // 单行:把各行并成一行(空格分隔),让 lines.length === 1。
  // 不需要给各 textFx 加分支 —— 原实现本来就对 `lines.length <= 1` /
  // `> 1` 分别处理(单行走画布垂直中心、多行整块居中),所以「并成一行」
  // 就自动落到单行那条路径上。
  function layoutLines(text, layout) {
    const lines = cheerLines(text);
    if (layout !== 'single') return lines;
    const joined = lines.join(' ');
    return joined ? [joined] : [];
  }

  // ---------- 背景 ----------

  // 图片按短边居中裁成正方形
  function drawImageCover(ctx, img, size) {
    const iw = img.naturalWidth  || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const side = Math.min(iw, ih);
    ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, size, size);
  }

  function paintCover(ctx, size, opts, alpha) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    if (opts.bgImage) drawImageCover(ctx, opts.bgImage, size);
    else {
      ctx.fillStyle = opts.bgColor || '#000000';
      ctx.fillRect(0, 0, size, size);
    }
    ctx.restore();
  }

  // 绕画布中心缩放后再铺底
  function paintCoverScaled(ctx, size, opts, scale, alpha) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.translate(-size / 2, -size / 2);
    paintCover(ctx, size, opts, alpha == null ? 1 : alpha);
    ctx.restore();
  }

  // 左右黑遮罩从中线向外打开
  function drawCurtains(ctx, size, shift) {
    const edge = size / 2 - shift;
    if (edge <= 0) return;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, edge, size);
    ctx.fillRect(size - edge, 0, edge, size);
    ctx.restore();
  }

  function drawOpen(ctx, size, opts, sec) {
    const u = wrap(sec, 2.5);
    let shift = 0.5;
    let scale = 1;
    if (u < 0.5) {
      const t = u / 0.5;
      shift = lerp(0, 0.25, t);
      scale = lerp(1.5, 1.1, t);
    } else if (u < 1) {
      shift = 0.25;
      scale = 1.1;
    } else if (u < 1.5) {
      const t = (u - 1) / 0.5;
      shift = lerp(0.25, 0.5, t);
      scale = lerp(1.1, 1, t);
    }
    paintCoverScaled(ctx, size, opts, scale);
    drawCurtains(ctx, size, shift * size);
  }

  function drawBlur(ctx, size, opts, sec) {
    const u = wrap(sec, 1.5);
    let scale = 1;
    let blur = 0;
    if (u < 0.5) {
      const t = u / 0.5;
      scale = lerp(1.5, 1, t);
      blur = lerp(10, 0, t) * size / REF;   // 10 是 466 画布像素
    }
    ctx.save();
    if (blur > 0.2) {
      try { ctx.filter = `blur(${blur}px)`; } catch (err) {}
    }
    paintCoverScaled(ctx, size, opts, scale);
    try { ctx.filter = 'none'; } catch (err) {}
    ctx.restore();
  }

  // 四个同心圆从外到内裁切后各自旋转
  function drawRotate(ctx, size, opts, sec) {
    const u = wrap(sec, 2);
    const t = u < 1 ? u : 1;              // 第 1 秒转到正位,第 2 秒保持
    const odd  = (90 * (1 - t)) * Math.PI / 180;
    const even = (-90 * (1 - t)) * Math.PI / 180;
    const rings = [
      { radius: size * 0.5,   angle: even },
      { radius: size * 0.375, angle: odd  },
      { radius: size * 0.25,  angle: even },
      { radius: size * 0.125, angle: odd  }
    ];
    rings.forEach((ring) => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, ring.radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(ring.angle);
      ctx.translate(-size / 2, -size / 2);
      paintCover(ctx, size, opts, 1);
      ctx.restore();
    });
  }

  function drawCheerBackground(ctx, size, opts) {
    const effect = BG_ALIAS[opts.effect] || opts.effect;
    const sec = effectSeconds(opts.phase, opts.speed);

    // 先铺黑底
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);

    if (!effect || effect === 'none') {
      paintCover(ctx, size, opts, 1);
      return;
    }
    if (effect === 'breathe') {
      // 2 秒一轮:第 1 秒 1→0,第 2 秒 0→1
      const u = wrap(sec, 2);
      paintCover(ctx, size, opts, u < 1 ? 1 - u : u - 1);
      return;
    }
    if (effect === 'pulse') {
      // 0.4 秒一轮:前 0.2 秒画背景,后 0.2 秒留黑底
      if (wrap(sec, 0.4) < 0.2) paintCover(ctx, size, opts, 1);
      return;
    }
    if (effect === 'open')   { drawOpen(ctx, size, opts, sec);   return; }
    if (effect === 'blur')   { drawBlur(ctx, size, opts, sec);   return; }
    if (effect === 'rotate') { drawRotate(ctx, size, opts, sec); return; }

    // 不认识的值按静止全亮画
    paintCover(ctx, size, opts, 1);
  }

  // ---------- 引擎 ----------
  function CheerEngine(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.data = {
      text: '一起\n为你\n发光',
      fontSize: 96,          // 466 画布单位
      fontColor: '#ffffff',
      fontFamily: 'sans-serif',
      scrollMode: 'static',  // textFx
      bgLightEffect: 'none', // bgFx
      bgColor: '#ff2d55',
      bgImage: null,
      speed: 1,
      textLayout: 'multi',   // multi | single
      round: true            // 圆屏:把整帧(背景 + 文字)裁成内切圆
    };

    this._textPhase = 0;     // 文字帧计数(整数)
    this._scrollOffset = 0;  // CSS px 累加,绘制时乘 dpr
    this._lightPhase = 0;    // 背景 phase,1 单位 = 1.5 秒
    this._clip = null;       // 最近一帧被圆屏/画布裁掉最多的那行 {line, over}
    this._timer = null;
    this._css = REF;
    this._dpr = 1;
    this.onframe = null;
  }

  // 预览像素由 CSS 尺寸 × dpr 决定;所有 466 基准量在绘制时按 size/466 换算
  CheerEngine.prototype.resize = function (cssSize, dpr) {
    this._css = Math.max(1, cssSize);
    this._dpr = Math.max(1, dpr || 1);
    const px = Math.round(this._css * this._dpr);
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = this._css + 'px';
    this.canvas.style.height = this._css + 'px';
    this.render();
  };

  CheerEngine.prototype.set = function (patch) {
    Object.assign(this.data, patch);
    this.render();
  };

  CheerEngine.prototype.reset = function () {
    this._textPhase = 0;
    this._scrollOffset = 0;
    this._lightPhase = 0;
    this.render();
  };

  // 一帧:只推进计数器,位移量全部由计数器导出
  CheerEngine.prototype.step = function () {
    const css = this._css;
    const scrollMode = this.data.scrollMode;

    this._textPhase += 1;
    const step = css / REF / PREVIEW_FPS;
    if (scrollMode === 'scroll') this._scrollOffset += (css / 4) / PREVIEW_FPS;
    else if (scrollMode === 'rainbow')   this._scrollOffset += RAINBOW_SPEED * step;
    else if (scrollMode === 'multiline') this._scrollOffset += ROLL_SPEED * step;
    if (this.data.bgLightEffect !== 'none') this._lightPhase += (2 / 3) / PREVIEW_FPS;

    this.render();
  };

  CheerEngine.prototype.start = function () {
    if (this._timer) return;
    const tick = () => {
      this._timer = setTimeout(tick, 1000 / PREVIEW_FPS);
      this.step();
    };
    this._timer = setTimeout(tick, 1000 / PREVIEW_FPS);
  };

  CheerEngine.prototype.stop = function () {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  };

  CheerEngine.prototype.running = function () { return !!this._timer; };

  // 彩虹:整段同一颜色,饱和度 1、明度 0.5,色相每秒 +36°,10 秒转一圈
  CheerEngine.prototype._inkColor = function () {
    if (this.data.scrollMode !== 'rainbow') return this.data.fontColor;
    const hue = (((this._textPhase || 0) / PREVIEW_FPS) * 36) % 360;
    const s = 1;
    const l = 0.5;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + hue / 30) % 12;      // hue/30 是 HSL→RGB 的扇区计算,与帧率无关
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };

  CheerEngine.prototype.render = function () {
    const ctx = this.ctx;
    const d = this.data;
    const size = this.canvas.width;     // 预览像素(= css × dpr)
    const dpr = this._dpr;

    // ---- 圆屏 ----
    // 裁切只在最外层加一次,包住背景和文字:屏幕是圆的,出圈的内容物理上
    // 就不存在。注意它不参与任何运动数学 —— 位移、相位、循环间距仍按方形
    // 画布算(文档的运动量都是按 466 方形定义的),圆只是最后一道遮罩。
    ctx.save();
    ctx.clearRect(0, 0, size, size);    // 圆外留透明,露出页面上的「机身」底色
    if (d.round) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
    }

    // ---- 背景 ----
    drawCheerBackground(ctx, size, {
      effect: d.bgLightEffect,
      phase: this._lightPhase,
      speed: d.speed,
      bgColor: d.bgColor,
      bgImage: d.bgImage
    });

    // ---- 文字(画在背景之后,不参与背景的任何变换) ----
    const scaledFont = d.fontSize * size / REF;
    ctx.font = `bold ${scaledFont}px ${d.fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'middle';
    const lines = layoutLines(d.text, d.textLayout);
    const rowH = scaledFont * LINE_RATIO;
    const stackStart = lines.length <= 1
      ? size / 2
      : size / 2 - ((lines.length - 1) * rowH) / 2;

    const ink = this._inkColor();
    const drawText = (line, x, y) => {
      ctx.fillStyle = ink;
      ctx.fillText(line, x, y);
    };
    const drawCentered = (line, y) => drawText(line, (size - ctx.measureText(line).width) / 2, y);
    const drawStack = () => { lines.forEach((line, i) => drawCentered(line, stackStart + i * rowH)); };


    // 从右向左;循环间距 = 文字宽度 + 画布宽度
    const drawMarquee = (line, y, speedMul) => {
      const tw = ctx.measureText(line).width;
      const span = tw + size;
      const offset = (this._scrollOffset * dpr * (speedMul || 1)) % span;
      const x = size - offset;
      drawText(line, x, y);
      if (x + tw < size) drawText(line, x + tw + span, y);
    };

    // 整块自下而上;循环长度 = 整块高度 + 画布高度
    const drawRoll = () => {
      const blockH = Math.max(rowH, lines.length * rowH);
      const span = blockH + size;
      const offset = ((this._scrollOffset || 0) * dpr) % span;
      const startY = size - offset + rowH / 2;
      lines.forEach((line, i) => drawCentered(line, startY + i * rowH));
    };

    const scrollMode = d.scrollMode;

    // ---- 溢出诊断(只统计,不改绘制) ----
    // 原实现对超宽文字就是「居中画、超出即裁」,这里不去自动缩放(那会偏离
    // 设备行为),只把裁掉多少量出来,好在发到设备前就看见。
    // 圆屏的可用宽度是该行基线处的**弦长**而非直径:行离中心越远越窄,
    // 所以多行的首尾行比中间行更容易被切。
    const chordAt = (y) => {
      if (!d.round) return size;
      const r = size / 2;
      const dy = Math.abs(y - r);
      return dy >= r ? 0 : 2 * Math.sqrt(r * r - dy * dy);
    };
    // 走马灯 / 滚动 / 彩虹本来就跑出画布,溢出对它们没有意义
    const moving = scrollMode === 'scroll' || scrollMode === 'multiline' ||
                   scrollMode === 'rainbow';
    this._clip = null;
    if (!moving) {
      lines.forEach((line, i) => {
        const y = lines.length <= 1 ? size / 2 : stackStart + i * rowH;
        const over = ctx.measureText(line).width - chordAt(y);
        if (over > 0 && (!this._clip || over > this._clip.over)) this._clip = { line, over };
      });
    }

    if (scrollMode === 'scroll' && lines.length > 1) {
      // 多行第 i 行速度倍率 1 + i × 0.4
      lines.forEach((line, i) => drawMarquee(line, stackStart + i * rowH, 1 + i * 0.4));
    } else if (scrollMode === 'scroll') {
      drawMarquee(lines[0] || d.text, size / 2, 1);
    } else if (scrollMode === 'multiline') {
      drawRoll();
    } else if (scrollMode === 'rainbow') {
      // 各行同速,倍率都是 1
      lines.forEach((line, i) => drawMarquee(line, stackStart + i * rowH, 1));
    } else if (scrollMode === 'blink') {
      // 1 秒一个周期,透明度在 1 和 0 之间按余弦往复
      const sec = (this._textPhase || 0) / PREVIEW_FPS;
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.5 * Math.cos(Math.PI * 2 * sec);
      drawStack();
      ctx.restore();
    } else {
      // static,以及未知的 textFx
      drawStack();
    }

    ctx.restore();                      // 收掉圆屏裁切

    if (this.onframe) this.onframe(this);
  };

  return {
    REF, PREVIEW_FPS, RAINBOW_SPEED, ROLL_SPEED, MAX_LINES, LINE_RATIO,
    TEXT_FX, BG_FX, BG_ALIAS, TEXT_LAYOUT, SCREENS,
    cheerLines, layoutLines, effectSeconds, drawCheerBackground, lerp, wrap,
    Engine: CheerEngine
  };
});
