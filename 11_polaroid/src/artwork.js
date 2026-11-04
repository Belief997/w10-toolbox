/*
 * 程序化贴图:正面印刷、书脊色块、相纸画面。
 * 全部用 canvas 2D 画,不依赖任何外部图片。
 */
import * as THREE from 'three';
import { COL } from './core.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/* 正面像素密度:1 cm ≈ PPU px */
const PPU = 150;
function canvasFor(wCm, hCm) {
  const c = document.createElement('canvas');
  c.width = Math.round(wCm * PPU);
  c.height = Math.round(hCm * PPU);
  return c;
}

function toTexture(canvas, anisotropy = 8) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/* ---------------------------------------------------------
 * 正面面板
 * 参考官图:白底,左侧三条竖色带(红/橙/黄),占宽约 69%,
 * 下沿留白,右下角黑色 "polaroid" 字样。
 * ------------------------------------------------------- */
export function makeFrontTexture(wCm, hCm) {
  const c = canvasFor(wCm, hCm);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;

  // 白底
  g.fillStyle = hex(COL.white);
  g.fillRect(0, 0, W, H);

  // 五条竖色带(完整彩虹),占正面大半 —— 参考图里条纹是最主要的视觉元素
  const barX = W * 0.07;
  const barW = W * 0.56;
  const barTop = H * 0.045;
  const barH = H * 0.64;
  const each = barW / COL.rainbow.length;
  COL.rainbow.forEach((col, i) => {
    g.fillStyle = hex(col);
    g.fillRect(barX + each * i, barTop, each + 1, barH);
  });

  /* 大字 "Color i-Type Film" — 白色,压在色带上。
   * 字号按"最长的那个词能塞进色带"来反推,避免溢出。 */
  g.fillStyle = '#ffffff';
  g.textBaseline = 'top';

  const tx = barX + barW * 0.06;
  const maxW = barW * 0.84;              // 留足内边距,宁可小一点也不越界

  /* 把一组文字缩到能塞进 maxW:二分找最大可用字号,再做一次最终校验。 */
  const fitFont = (texts, weight, start, min) => {
    const widest = (size) => {
      g.font = `${weight} ${size}px "Helvetica Neue", Arial, sans-serif`;
      return Math.max(...texts.map((t) => g.measureText(t).width));
    };
    let lo = min, hi = start;
    while (hi - lo > 1) {
      const mid = (lo + hi) / 2;
      if (widest(mid) > maxW) hi = mid; else lo = mid;
    }
    // 最终校验:中文字体/回退字体度量可能不同,不满足就继续缩
    let size = lo;
    while (size > min && widest(size) > maxW) size *= 0.97;
    g.font = `${weight} ${size}px "Helvetica Neue", Arial, sans-serif`;
    return size;
  };

  // 大字 "Color i-Type Film"
  const words = ['Color', 'i-Type', 'Film'];
  const fs = fitFont(words, '600', barW * 0.42, 8);
  const lineH = fs * 1.04;
  words.forEach((w, i) => g.fillText(w, tx, barTop + barH * 0.045 + lineH * i));

  // "8 Instant Photos" 小字
  const small = '8 Instant Photos';
  const fsm = fitFont([small], '400', barW * 0.14, 6);
  g.textBaseline = 'alphabetic';
  g.fillText(small, tx, barTop + barH * 0.90);

  // 底部黑色 polaroid 字标(居中偏右)
  g.fillStyle = '#141518';
  g.textBaseline = 'alphabetic';
  g.font = `500 ${W * 0.098}px "Helvetica Neue", Arial, sans-serif`;
  g.fillText('polaroid', W * 0.30, H * 0.885);

  // 极淡的纸张纤维,避免大面积纯色发死
  g.globalAlpha = 0.035;
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    g.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
    g.fillRect(x, y, 1, 1);
  }
  g.globalAlpha = 1;

  return toTexture(c);
}

/* ---------------------------------------------------------
 * 书脊(左/右侧面):五色块堆叠
 * ------------------------------------------------------- */
export function makeSpineTexture(dCm, hCm) {
  const c = canvasFor(dCm, hCm);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;

  g.fillStyle = hex(COL.white);
  g.fillRect(0, 0, W, H);

  // 五色块从顶部起排,占高约 62%,下方留白
  const top = H * 0.0, h = H * 0.62, each = h / 5;
  COL.rainbow.forEach((col, i) => {
    g.fillStyle = hex(col);
    g.fillRect(0, top + each * i, W, each + 1);
  });

  // 留白区的黑色竖排 polaroid
  g.save();
  g.translate(W * 0.5, H * 0.83);
  g.rotate(-Math.PI / 2);
  g.fillStyle = '#141518';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `500 ${W * 0.30}px "Helvetica Neue", Arial, sans-serif`;
  g.fillText('polaroid', 0, 0);
  g.restore();

  // 块内竖排白字 "i-Type"
  g.save();
  g.translate(W * 0.5, H * 0.30);
  g.rotate(-Math.PI / 2);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 ${W * 0.34}px "Helvetica Neue", Arial, sans-serif`;
  g.fillText('i-Type', 0, 0);
  g.restore();

  return toTexture(c);
}

/* ---------------------------------------------------------
 * 顶盖印刷:窄色带 + 小字
 * ------------------------------------------------------- */
export function makeTopTexture(wCm, dCm) {
  const c = canvasFor(wCm, dCm);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;

  g.fillStyle = hex(COL.white);
  g.fillRect(0, 0, W, H);

  // 靠后缘一条细色带:五段实色,不是渐变(照官方包装的做法)
  const bandH = H * 0.10;
  const stops = ['#5e94d0', '#96c253', '#fabd31', '#e86b3f', '#d1372d'];
  const seg = W / stops.length;
  stops.forEach((s, i) => {
    g.fillStyle = s;
    g.fillRect(i * seg, H * 0.05, seg + 1, bandH);
  });

  return toTexture(c);
}

/* ---------------------------------------------------------
 * 相纸画面:程序化生成一张"宝丽来味"的照片
 * 暖调天空 + 地平线 + 太阳光斑 + 轻微漏光
 * ------------------------------------------------------- */
export function makePhotoTexture(seed = 7) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // 天空渐变(暖调,宝丽来偏青的阴影 + 偏橙的高光)
  const sky = g.createLinearGradient(0, 0, 0, S);
  sky.addColorStop(0.0, '#7fa9c4');
  sky.addColorStop(0.42, '#cfe0e2');
  sky.addColorStop(0.55, '#f5e2c0');
  sky.addColorStop(1.0, '#e7b98a');
  g.fillStyle = sky;
  g.fillRect(0, 0, S, S);

  // 太阳光斑
  const sunX = S * (0.28 + rnd() * 0.44), sunY = S * (0.30 + rnd() * 0.18);
  const sunR = S * 0.42;
  const sun = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
  sun.addColorStop(0, 'rgba(255,246,214,.95)');
  sun.addColorStop(0.28, 'rgba(255,214,150,.42)');
  sun.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, S, S);

  // 地平线与远处地景
  const horizon = S * (0.60 + rnd() * 0.08);
  g.fillStyle = 'rgba(96,88,74,.55)';
  g.beginPath();
  g.moveTo(0, horizon);
  for (let x = 0; x <= S; x += 16) {
    const y = horizon + Math.sin(x * 0.011 + rnd() * 0.4) * S * 0.018;
    g.lineTo(x, y);
  }
  g.lineTo(S, S); g.lineTo(0, S); g.closePath();
  g.fill();

  // 前景地面
  const ground = g.createLinearGradient(0, horizon + S * 0.06, 0, S);
  ground.addColorStop(0, '#8a7a5f');
  ground.addColorStop(1, '#483d2f');
  g.fillStyle = ground;
  g.fillRect(0, horizon + S * 0.05, S, S);

  // 几棵树/柱子的剪影
  const n = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const x = S * (0.05 + rnd() * 0.9);
    const h = S * (0.10 + rnd() * 0.16);
    const w = S * (0.012 + rnd() * 0.022);
    g.fillStyle = `rgba(${34 + rnd() * 30 | 0},${30 + rnd() * 26 | 0},${
      26 + rnd() * 22 | 0},.82)`;
    g.fillRect(x, horizon - h, w, h + S * 0.02);
  }

  // 轻微漏光(左侧暖橙色晕)
  const leak = g.createRadialGradient(0, S * 0.25, 0, 0, S * 0.25, S * 0.55);
  leak.addColorStop(0, 'rgba(255,170,90,.30)');
  leak.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = leak;
  g.fillRect(0, 0, S, S);

  // 胶片颗粒
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const nz = (rnd() - 0.5) * 15;
    d[i] += nz; d[i + 1] += nz; d[i + 2] += nz;
  }
  g.putImageData(img, 0, 0);

  const t = toTexture(c, 4);
  return t;
}
