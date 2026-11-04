/*
 * 盒体装配 —— 用面板拼出中空壳体,开门后能看见真实内腔。
 *
 *            z=-D/2(后)                    z=+D/2(前)
 *   y=+H/2  ┌──────────┬───────────────────┐  ← 顶面:后段随门掀开,前段固定
 *           │  门(顶唇)│   固定顶盖         │
 *           ├──────────┴───────────────────┤
 *           │                              │
 *           │      正面(白 + 三条色带)      │  ← 左右侧壁夹出空腔
 *           │                              │
 *   y=hingeY├──────────────────────────────┤  ← 铰链线
 *           │        固定后背               │
 *           └──────────────────────────────┘
 *
 *   挂耳在顶面左右两侧的棱上(不是开门侧、不是正面侧)
 */
import * as THREE from 'three';
import { DIM, COL, roundedBox, makeMaterials } from './core.js';
import {
  makeFrontTexture, makeSpineTexture, makePhotoTexture,
} from './artwork.js';

const R = 0.045; // 极小的倒角 —— 真盒子是硬边纸盒,只要一点点高光过渡

export function buildProduct() {
  const mats = makeMaterials(1);
  const root = new THREE.Group();
  root.name = 'product';

  const W = DIM.W, H = DIM.H, D = DIM.D, wall = DIM.wall;
  const halfW = W / 2, halfH = H / 2, halfD = D / 2;

  /* 铰链线 / 顶面分缝
   * 顶面上门四周都留边:左侧最宽(放按钮),右侧较窄,正面留一道缝。
   * 这样门不顶到正面,打开时边框还在,像真的要开舱门。 */
  const doorH = 5.6;
  const hingeY = halfH - doorH;   // 0.3
  // 留边必须满足:门洞宽 = W - marginL - marginR > 相纸宽 8.85,
  // 且放按钮的那一侧要够宽(直径 0.84 + 余量)。
  const marginL = 0.42;           // 左侧(窄边)
  const marginR = 1.45;           // 右侧(按钮侧,故意做宽)
  const marginF = 0.42;           // 前侧
  const splitZ = halfD - marginF; // 门顶唇的前沿

  // 门顶唇横向范围
  const lipX0 = -halfW + marginL;
  const lipX1 = halfW - marginR;
  const lipW = lipX1 - lipX0;
  const lipCX = (lipX0 + lipX1) / 2;

  const add = (m) => { m.castShadow = true; m.receiveShadow = true; root.add(m); return m; };

  /* ================= 1. 壳体墙面 ================= */

  // 左右侧壁(整高)
  [-1, 1].forEach((s) => {
    const m = new THREE.Mesh(roundedBox(wall, H, D, R), mats.white);
    m.position.set(s * (halfW - wall / 2), 0, 0);
    add(m);
  });

  // 底板
  const bottom = new THREE.Mesh(roundedBox(W, wall, D, R), mats.white);
  bottom.position.set(0, -halfH + wall / 2, 0);
  add(bottom);

  // 正面板(整高)
  const frontWall = new THREE.Mesh(roundedBox(W, H, wall, R), mats.white);
  frontWall.position.set(0, 0, halfD - wall / 2);
  add(frontWall);

  // 固定后背(铰链线以下,整宽)
  const lowerBackH = hingeY + halfH;
  const lowerBack = new THREE.Mesh(roundedBox(W, lowerBackH, wall, R), mats.white);
  lowerBack.position.set(0, -halfH + lowerBackH / 2, -halfD + wall / 2);
  add(lowerBack);

  /* 后背两侧的固定板(铰链线以上)。
   * 门只能盖住门洞那一截,左右这两条必须留在原地 ——
   * 合门时补住后背两侧,开门时它们是"不能动"的部分。 */
  // 各自有 R 的倒角,接缝处会各缩 R,留下楔形缝 ——
  // 每块往门洞方向多伸一点盖住它(视觉上只是一条细黑线)。
  const seamOverlap = R * 1.6;
  [[-1, lipX0 + halfW], [1, halfW - lipX1]].forEach(([s, w]) => {
    if (w <= 0.001) return;
    const ww = w + seamOverlap;
    const cx = s < 0
      ? -halfW + ww / 2
      : halfW - ww / 2;
    const side = new THREE.Mesh(roundedBox(ww, doorH, wall, R), mats.white);
    side.position.set(cx, hingeY + doorH / 2, -halfD + wall / 2);
    side.castShadow = true; side.receiveShadow = true;
    root.add(side);
  });

  /* 固定顶盖 = 顶面减去门的开口,做成四条边 */
  const yTop = halfH - wall / 2;

  // 前边框(正面到门缝之间)
  const frontBar = new THREE.Mesh(roundedBox(W, wall, halfD - splitZ, R), mats.white);
  frontBar.position.set(0, yTop, splitZ + (halfD - splitZ) / 2);
  add(frontBar);

  // 左边框(按钮所在,宽)
  const sideBarD = splitZ + halfD;             // 覆盖门开口的整个深度
  const leftBar = new THREE.Mesh(roundedBox(marginL, wall, sideBarD, R), mats.white);
  leftBar.position.set(-halfW + marginL / 2, yTop, -halfD + sideBarD / 2);
  add(leftBar);

  // 右边框(窄)
  const rightBar = new THREE.Mesh(roundedBox(marginR, wall, sideBarD, R), mats.white);
  rightBar.position.set(halfW - marginR / 2, yTop, -halfD + sideBarD / 2);
  add(rightBar);

  // 后缘不留边框:门唇直接盖到 z=-halfD,铰链就长在这条棱上。
  // 之前这里多补了一块,结果门开后顶面还残留实体。

  /* ================= 2. 印刷贴面 ================= */

  // 正面印刷(白底 + 三条竖色带 + polaroid 字标)
  const frontMat = new THREE.MeshPhysicalMaterial({
    map: makeFrontTexture(W, H), roughness: 0.56, metalness: 0.0,
    clearcoat: 0.2, clearcoatRoughness: 0.5,
  });
  const frontFace = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.998, H * 0.998), frontMat);
  frontFace.position.set(0, 0, halfD + 0.002);
  frontFace.receiveShadow = true;
  root.add(frontFace);

  // 左右书脊(五色块)
  const spineMat = new THREE.MeshStandardMaterial({ map: makeSpineTexture(D, H), roughness: 0.6 });
  [-1, 1].forEach((s) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(D * 0.998, H * 0.998), spineMat);
    p.position.set(s * (halfW + 0.002), 0, 0);
    p.rotation.y = s * Math.PI / 2;
    root.add(p);
  });

  /* ================= 3. 舱门 ================= */
  // 铰链在 (0, hingeY, -halfD)。局部坐标:y 向上,z 朝前。
  const hinge = new THREE.Group();
  hinge.name = 'hinge';
  hinge.position.set(0, hingeY, -halfD);
  root.add(hinge);

  // 门板:只有门洞那一截宽度能活动。左右两条边框固定不动,
  // 它们同时负责补住后背两侧(见下方"固定后背侧板")。
  const doorBack = new THREE.Mesh(roundedBox(lipW, doorH, wall, R), mats.white);
  doorBack.position.set(lipCX, doorH / 2, wall / 2);
  doorBack.castShadow = true; doorBack.receiveShadow = true;
  hinge.add(doorBack);

  // 顶唇:盖住顶面后段,左右留出边框
  const lipLen = splitZ + halfD - wall;
  const lip = new THREE.Mesh(roundedBox(lipW, wall, lipLen, R), mats.white);
  lip.position.set(lipCX, doorH - wall / 2, wall + lipLen / 2);
  lip.castShadow = true; lip.receiveShadow = true;
  hinge.add(lip);

  // 门内侧衬板(深灰),让开门后有层次
  const doorInner = new THREE.Mesh(
    new THREE.PlaneGeometry(lipW - 2 * 0.05, doorH - wall),
    mats.inner,
  );
  doorInner.position.set(lipCX, doorH / 2, wall + 0.001);
  hinge.add(doorInner);

  // 顶唇内侧的黑色密封条
  const seal = new THREE.Mesh(roundedBox(lipW * 0.9, 0.04, 0.20, 0.015), mats.rubber);
  seal.position.set(lipCX, doorH - wall - 0.02, wall + 0.13);
  hinge.add(seal);

  // 门顶面保持纯白:这块只有合门时才朝上,开门后完全看不见,
  // 之前贴印花反而在门唇与固定框的交界处露出一小块彩色毛边。

  /* ================= 4. 顶面细节 ================= */

  // 分缝凹槽:门左右和前三条缝
  const seamMat = mats.dark;
  // 前缝
  const seamF = new THREE.Mesh(roundedBox(lipW + 0.05, 0.012, 0.026, 0.005), seamMat);
  seamF.position.set(lipCX, halfH + 0.001, splitZ);
  root.add(seamF);
  // 左缝
  const seamL = new THREE.Mesh(roundedBox(0.026, 0.012, splitZ + halfD, 0.005), seamMat);
  seamL.position.set(lipX0, halfH + 0.001, -halfD + (splitZ + halfD) / 2);
  root.add(seamL);
  // 右缝
  const seamR = new THREE.Mesh(roundedBox(0.026, 0.012, splitZ + halfD, 0.005), seamMat);
  seamR.position.set(lipX1, halfH + 0.001, -halfD + (splitZ + halfD) / 2);
  root.add(seamR);

  /* ================= 5. 挂耳(顶面左右两侧的棱) ================= */
  // 骑在 x = ±halfW 这条棱上,位于顶面靠前的固定段。
  // 插销式挂耳:一根细圆柱从顶面垂直插进壳体,
  // 露出的圆柱头就是挂背带的地方(参考 SX-70 顶面那两颗)。
  // 挂耳:与侧棱同向(沿 Z)的水平销子,紧贴顶面棱边、嵌在侧壁里,
  // 中段露出一截悬空的销子,背带从中穿过。
  const lugs = [];
  const lugY = halfH - 0.30;        // 紧贴顶棱下方
  const lugZ = -0.15;               // 略偏后
  const pinLen = 1.55;              // 销子长度(沿 Z)
  const pinGap = 0.135;             // 销子离侧壁的净空(背带穿这里)

  [-1, 1].forEach((s) => {
    const lug = new THREE.Group();
    lug.position.set(s * halfW, lugY, lugZ);

    // 销子主体:轴沿 Z 的圆柱,悬在侧壁外侧
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.098, 0.098, pinLen, 28),
      mats.silver,
    );
    pin.rotation.x = Math.PI / 2;
    pin.position.x = s * pinGap;
    pin.castShadow = true;
    lug.add(pin);

    // 前后两个支架:从侧壁水平伸出托住销子两端
    [-1, 1].forEach((e) => {
      const arm = new THREE.Mesh(
        roundedBox(pinGap + 0.10, 0.115, 0.14, 0.035),
        mats.silver,
      );
      // 支架中心:从侧壁表面伸到销子中心
      arm.position.set(s * (pinGap / 2), 0, e * (pinLen / 2 - 0.07));
      arm.castShadow = true;
      lug.add(arm);
    });

    // 销子两端的圆头收口
    [-1, 1].forEach((e) => {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.098, 20, 12),
        mats.silver,
      );
      cap.position.set(s * pinGap, 0, e * (pinLen / 2));
      lug.add(cap);
    });

    // 侧壁上的嵌座:两小块深色,表示支架是插进壳体的
    [-1, 1].forEach((e) => {
      const boss = new THREE.Mesh(
        roundedBox(0.05, 0.20, 0.19, 0.025),
        mats.dark,
      );
      boss.position.set(s * -0.006, 0, e * (pinLen / 2 - 0.07));
      lug.add(boss);
    });

    root.add(lug);
    lugs.push(lug);
  });

  /* ================= 6. 顶面红色按钮(电子件) ================= */
  // 朝上,放在右侧那道宽边框上,位于门缝之外、右挂耳旁边
  const btn = new THREE.Group();
  btn.name = 'button';
  btn.position.set(halfW - marginR * 0.52, halfH, lugZ + 0.05);

  // 下沉的银色圆座
  const btnBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.40, 0.42, 0.10, 40),
    mats.silver,
  );
  btnBase.position.y = 0.035;
  btnBase.castShadow = true;
  btn.add(btnBase);

  // 红色按键:略微凸出顶面
  const btnCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.315, 0.325, 0.11, 40),
    mats.red,
  );
  btnCap.position.y = 0.13;
  btnCap.castShadow = true;
  btn.add(btnCap);

  // 圆润顶面
  const btnDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.315, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    mats.red,
  );
  btnDome.scale.set(1, 0.22, 1);
  btnDome.position.y = 0.175;
  btn.add(btnDome);
  root.add(btn);

  /* ================= 7. 内腔 + 相纸 ================= */
  const cavW = W - 2 * wall;

  /* 相纸:竖直站立,平面平行于正面,沿厚度(Z)方向叠放。
   * 盒体是扁砖形(9.8 × 11.8 × 2.4),相纸 8.85 × 10.75 只能竖着从顶部插进去。
   * 相纸"宽"沿 X,"高"沿 Y,厚度沿 Z。 */
  const PW = 8.85, PH = 10.75, IMG = 7.9;

  const N = 4;            // 一叠相纸的张数(示意)
  const T = 0.052;        // 每张的间距
  const stackT = (N - 1) * T + 0.028; // 整叠厚度

  const photoGroup = new THREE.Group();
  // 相纸插在腔里,顶沿露出盒口 2.6cm —— 能看见画面,又像真的插着。
  // 横向对齐门洞中心(不是盒体中心),否则开门后相纸会偏到一边。
  const photoTopY = halfH + 2.6;
  const photoCY = photoTopY - PH / 2;
  photoGroup.position.set(lipCX, photoCY, -stackT / 2);
  root.add(photoGroup);

  const cardMat = new THREE.MeshStandardMaterial({ color: 0xf1f3f5, roughness: 0.75 });

  for (let i = 0; i < N; i++) {
    const card = new THREE.Mesh(roundedBox(PW, PH, 0.028, 0.012), cardMat);
    card.position.set(0, 0, i * T);
    card.rotation.z = (i - (N - 1) / 2) * 0.003;   // 极轻微的错位,别太整齐
    photoGroup.add(card);
  }

  // 每张相纸的正面(+Z 侧)都印上画面;最靠前的那张最清楚。
  // 画面在相纸上部,下边留宽白边。
  const photoTex = makePhotoTexture(7);
  const photoMat = new THREE.MeshStandardMaterial({
    map: photoTex, roughness: 0.55, metalness: 0.0,
  });
  const imgY = PH / 2 - 0.47 - IMG / 2;   // 相对相纸中心

  for (let i = 0; i < N; i++) {
    const img = new THREE.Mesh(new THREE.PlaneGeometry(IMG, IMG), photoMat);
    img.position.set(0, imgY, i * T + 0.016);   // 贴在每张卡片正面
    photoGroup.add(img);
    // 背面也补一张,免得从后侧看是空洞
    const back = new THREE.Mesh(new THREE.PlaneGeometry(IMG, IMG), photoMat);
    back.rotation.y = Math.PI;
    back.position.set(0, imgY, i * T - 0.016);
    photoGroup.add(back);
  }

  // 内腔底板
  const cavFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(cavW, D - 2 * wall),
    mats.inner,
  );
  cavFloor.rotation.x = -Math.PI / 2;
  cavFloor.position.set(0, -halfH + wall + 0.001, 0);
  root.add(cavFloor);

  // 内壁贴一层暗色,避免纯白内腔过曝
  [-1, 1].forEach((s) => {
    const p = new THREE.Mesh(
      new THREE.PlaneGeometry(D - 2 * wall, H - 2 * wall),
      mats.inner,
    );
    p.position.set(s * (halfW - wall - 0.001), 0, 0);
    p.rotation.y = s * -Math.PI / 2;
    root.add(p);
  });

  // 内腔前板(正面墙的内侧),避免从开口看穿
  const cavFront = new THREE.Mesh(
    new THREE.PlaneGeometry(cavW, H - 2 * wall),
    mats.inner,
  );
  cavFront.position.set(0, 0, halfD - wall - 0.001);
  cavFront.rotation.y = Math.PI;
  root.add(cavFront);

  /* ================= 8. 外部细节 ================= */
  // 底部橡胶脚垫
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.07, 24), mats.rubber);
    foot.position.set(sx * halfW * 0.62, -halfH - 0.03, sz * halfD * 0.55);
    foot.castShadow = true;
    root.add(foot);
  });

  // 底部前缘出片口
  const slot = new THREE.Mesh(roundedBox(W * 0.66, 0.11, 0.09, 0.035), mats.dark);
  slot.position.set(0, -halfH + 0.62, halfD + 0.012);
  root.add(slot);

  // 状态指示灯
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 20, 12),
    new THREE.MeshStandardMaterial({
      color: 0x39d98a, emissive: 0x39d98a, emissiveIntensity: 2.4, roughness: 0.3,
    }),
  );
  led.position.set(halfW * 0.66, halfH - 0.42, halfD + 0.03);
  root.add(led);

  return { root, hinge, mats, lugs, button: btn, door: doorBack, lip, photoGroup, hingeY };
}
