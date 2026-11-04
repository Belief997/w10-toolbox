/*
 * Polaroid i-Type 显影盒 · WebGPU 3D 预览
 *
 * 真实尺寸(cm):
 *   相纸 10.75 × 8.85,画面 7.9 × 7.9
 *   卡匣 ≈ 9.4 × 11.4 × 2.0(8 张)
 * 盒子 = 卡匣 + 壁厚,立起来像一块板砖。
 */
import * as THREE from 'three';

/* ---------------- 尺寸 (单位: cm) ---------------- */
export const DIM = {
  // 宽 11.0:必须 > 相纸宽 8.85 + 两侧边框(左 1.45 放按钮 + 右 0.42),
  // 否则顶面的门洞比相纸还窄,相纸插不进去。
  W: 11.0,    // 宽
  H: 11.8,    // 高
  D: 2.4,     // 厚
  wall: 0.18, // 壳体壁厚
  openMax: THREE.MathUtils.degToRad(52), // 完全打开角度
};
DIM.cavW = DIM.W - 2 * DIM.wall; // 9.44
DIM.cavD = DIM.D - 2 * DIM.wall; // 2.04

/* ---------------- 配色 ---------------- */
export const COL = {
  white: 0xf0f0ec,   // 冷白壳体
  whiteIn: 0xcfcfca, // 内腔
  silver: 0xd8dade,  // 拉丝银
  dark: 0x2a2b2e,    // 深灰细节
  rubber: 0x1c1d20,  // 橡胶垫
  red: 0xd8202a,     // 红色按钮
  // 完整彩虹:五色(取自官方包装实测),正面竖带与顶面/书脊横带共用
  rainbow: [0x5e94d0, 0x96c253, 0xfabd31, 0xe86b3f, 0xd1372d],
  // 正面三条竖色带(官方包装正面用的是红/橙/黄这三段)
  stripe: [0xd65649, 0xef8c49, 0xffc857],
};

/* ---------------- 圆角长方体 ----------------
 * 用 Shape + ExtrudeGeometry 做出六面都带倒角的砖块,
 * 参数含义是"最终外形的整体尺寸",不是内缩尺寸。
 */
export function roundedBox(w, h, d, r = 0.06, seg = 3) {
  const b = Math.min(r, d * 0.45, w * 0.45, h * 0.45); // 倒角厚度
  const sw = w - 2 * b, sh = h - 2 * b;                 // 截面轮廓尺寸
  const rr = Math.max(0.001, r - b);                    // 轮廓圆角

  const shape = new THREE.Shape();
  const x = -sw / 2, y = -sh / 2;
  shape.moveTo(x + rr, y);
  shape.lineTo(x + sw - rr, y);
  shape.quadraticCurveTo(x + sw, y, x + sw, y + rr);
  shape.lineTo(x + sw, y + sh - rr);
  shape.quadraticCurveTo(x + sw, y + sh, x + sw - rr, y + sh);
  shape.lineTo(x + rr, y + sh);
  shape.quadraticCurveTo(x, y + sh, x, y + sh - rr);
  shape.lineTo(x, y + rr);
  shape.quadraticCurveTo(x, y, x + rr, y);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, d - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: seg,
    curveSegments: 6,
    steps: 1,
  });
  geo.translate(0, 0, -(d - 2 * b) / 2); // 居中到 z=0
  geo.computeVertexNormals();
  return geo;
}

/* 便捷:给定尺寸建 Mesh */
export function boxMesh(w, h, d, mat, r = 0.05) {
  return new THREE.Mesh(roundedBox(w, h, d, r), mat);
}

/* ---------------- 材质 ---------------- */
export function makeMaterials(envIntensity = 1) {
  const m = {};

  // 冷白外壳:哑光纸感,极轻微清漆
  m.white = new THREE.MeshPhysicalMaterial({
    color: COL.white, roughness: 0.58, metalness: 0.0,
    clearcoat: 0.18, clearcoatRoughness: 0.55,
    envMapIntensity: envIntensity,
  });

  // 内腔:更暗的哑光
  m.inner = new THREE.MeshStandardMaterial({
    color: COL.whiteIn, roughness: 0.88, metalness: 0.0,
    envMapIntensity: envIntensity * 0.5,
    side: THREE.DoubleSide,
  });

  // 拉丝银:顶盖带 / 挂耳 / 按键座
  m.silver = new THREE.MeshPhysicalMaterial({
    color: COL.silver, roughness: 0.28, metalness: 1.0,
    envMapIntensity: envIntensity * 1.25,
  });

  // 深灰塑料件
  m.dark = new THREE.MeshPhysicalMaterial({
    color: COL.dark, roughness: 0.45, metalness: 0.15,
    clearcoat: 0.3, clearcoatRoughness: 0.4,
    envMapIntensity: envIntensity,
  });

  // 橡胶 / 密封条
  m.rubber = new THREE.MeshStandardMaterial({
    color: COL.rubber, roughness: 0.92, metalness: 0.0,
    envMapIntensity: envIntensity * 0.4,
  });

  // 红色按钮:哑光塑料,轻微次表面感
  m.red = new THREE.MeshPhysicalMaterial({
    color: COL.red, roughness: 0.42, metalness: 0.0,
    clearcoat: 0.55, clearcoatRoughness: 0.3,
    sheen: 0.35, sheenColor: new THREE.Color(0xff6b6b),
    envMapIntensity: envIntensity * 1.1,
  });

  // 色带用无光照材质(不参与阴影,纯色块)
  m.stripe = COL.stripe.map((c) => new THREE.MeshStandardMaterial({
    color: c, roughness: 0.6, metalness: 0.0,
    envMapIntensity: envIntensity * 0.6,
  }));

  return m;
}

/* ---------------- 相机控件的球坐标状态 ---------------- */
export const orbit = {
  azimuth: THREE.MathUtils.degToRad(-28),
  polar: THREE.MathUtils.degToRad(74),
  distance: 26,
  target: new THREE.Vector3(0, 0.3, 0),
};
