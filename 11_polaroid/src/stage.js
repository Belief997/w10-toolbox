/*
 * 场景 / 光照 / 环境 / 轨道控制
 *
 * 影棚布光参照 ref/sx70_camera.jpg:大面积柔光箱 + 顶部高光 + 地面接触阴影。
 * 环境贴图用程序化生成的 equirect 画布(顶部亮、两侧柔光、底部深),
 * 不依赖外部 HDR 文件。
 */
import * as THREE from 'three';
import { orbit } from './core.js';

/* ---------------------------------------------------------
 * 程序化环境贴图:一张 equirect 画布
 * ------------------------------------------------------- */
function makeEnvTexture() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // 基础:上亮下暗
  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0.00, '#dfe4ea'); // 天顶
  base.addColorStop(0.38, '#b9c0c9');
  base.addColorStop(0.50, '#6e747c'); // 地平
  base.addColorStop(0.62, '#2a2d33');
  base.addColorStop(1.00, '#14161a'); // 地面
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  // 主柔光箱(右前上方):一个大矩形高光
  const softbox = (cx, cy, rx, ry, intensity) => {
    g.save();
    g.translate(cx, cy);
    g.scale(rx, ry);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    rg.addColorStop(0, `rgba(255,255,255,${intensity})`);
    rg.addColorStop(0.55, `rgba(255,255,255,${intensity * 0.45})`);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill();
    g.restore();
  };

  softbox(W * 0.30, H * 0.16, W * 0.24, H * 0.22, 0.95); // 主光
  softbox(W * 0.78, H * 0.24, W * 0.20, H * 0.20, 0.55); // 辅光
  softbox(W * 0.55, H * 0.44, W * 0.30, H * 0.10, 0.35); // 地面反射

  // 几条竖条(模拟影棚立柱/反光板),让金属反射有内容
  for (let i = 0; i < 5; i++) {
    const x = W * (0.08 + i * 0.21);
    const w = W * (0.012 + (i % 2) * 0.016);
    const h = g.createLinearGradient(0, 0, 0, H * 0.62);
    h.addColorStop(0, 'rgba(255,255,255,0)');
    h.addColorStop(0.4, 'rgba(255,255,255,.28)');
    h.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = h;
    g.fillRect(x, 0, w, H * 0.62);
  }

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/* ---------------------------------------------------------
 * 搭场景
 * ------------------------------------------------------- */
export function createStage(canvas) {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    forceWebGL: false,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft 在 r187 已移除

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0f12);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);

  /* ---------- 环境 ----------
   * PMREM 依赖已初始化的后端,所以延后到 initEnvironment() 里做。
   * WebGPU 后端还有异步的 pmremTexture,这里统一走 PMREMGenerator。
   */
  let envRT = null;
  function initEnvironment() {
    const envTex = makeEnvTexture();
    const pmrem = new THREE.PMREMGenerator(renderer);
    envRT = pmrem.fromEquirectangular(envTex);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.62;   // 压低环境光,让主光有对比
    envTex.dispose();
    pmrem.dispose();
  }

  /* ---------- 灯光 ---------- */
  const key = new THREE.DirectionalLight(0xfff4e6, 3.4);
  key.position.set(9, 14, 11);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 60;
  const sc = 14;
  key.shadow.camera.left = -sc; key.shadow.camera.right = sc;
  key.shadow.camera.top = sc; key.shadow.camera.bottom = -sc;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.85);
  fill.position.set(-12, 6, -7);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.5);
  rim.position.set(-4, 5, -14);
  scene.add(rim);

  const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x1a1c20, 0.32);
  scene.add(hemi);

  /* ---------- 地面(接收阴影,渐隐到背景) ---------- */
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.42 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6.35;
  floor.receiveShadow = true;
  scene.add(floor);

  // 地台:一块很淡的圆形,给产品一个"落点"
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(11, 64),
    new THREE.MeshStandardMaterial({
      color: 0x1a1c21, roughness: 0.85, metalness: 0.0,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -6.351;
  disc.receiveShadow = true;
  scene.add(disc);

  return { renderer, scene, camera, key, fill, rim, hemi, floor, initEnvironment };
}

/* ---------------------------------------------------------
 * 相机:球坐标 + 简单阻尼
 * ------------------------------------------------------- */
export function makeCameraRig(camera, dom) {
  let dragging = false;
  let lastX = 0, lastY = 0;

  const vel = { az: 0, po: 0 };

  function apply() {
    const { azimuth, polar, distance, target } = orbit;
    const sp = Math.sin(polar), cp = Math.cos(polar);
    camera.position.set(
      target.x + distance * sp * Math.sin(azimuth),
      target.y + distance * cp,
      target.z + distance * sp * Math.cos(azimuth),
    );
    camera.lookAt(target);
  }

  function clamp() {
    orbit.polar = THREE.MathUtils.clamp(orbit.polar, 0.12, Math.PI / 2 + 0.22);
    orbit.distance = THREE.MathUtils.clamp(orbit.distance, 14, 58);
  }

  dom.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
    vel.az = vel.po = 0;
  });

  dom.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    vel.az = -dx * 0.0052;
    vel.po = -dy * 0.0042;
    orbit.azimuth += vel.az;
    orbit.polar += vel.po;
    clamp();
  });

  const end = (e) => {
    dragging = false;
    if (dom.hasPointerCapture?.(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);

  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.distance *= Math.exp(e.deltaY * 0.0011);
    clamp();
  }, { passive: false });

  return {
    apply,
    update(dt) {
      // 惯性
      if (!dragging) {
        if (Math.abs(vel.az) > 1e-4 || Math.abs(vel.po) > 1e-4) {
          orbit.azimuth += vel.az;
          orbit.polar += vel.po;
          vel.az *= 0.93; vel.po *= 0.93;
          clamp();
        }
      }
      apply();
    },
    isDragging: () => dragging,
    reset() {
      orbit.azimuth = THREE.MathUtils.degToRad(-28);
      orbit.polar = THREE.MathUtils.degToRad(74);
      orbit.distance = 26;
    },
  };
}

/* 让相机视角适配画布比例 */
export function fitCamera(camera, w, h) {
  const aspect = w / h;
  camera.aspect = aspect;
  camera.fov = aspect < 1 ? 42 : 32; // 窄屏拉大视角,保证产品完整
  camera.updateProjectionMatrix();
}
