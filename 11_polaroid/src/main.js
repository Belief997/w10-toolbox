/*
 * 入口:渲染循环 + 舱门动画 + UI
 */
import * as THREE from 'three';
import { DIM, orbit } from './core.js';
import { buildProduct } from './model.js';
import { createStage, makeCameraRig, fitCamera } from './stage.js';

const $ = (id) => document.getElementById(id);
const boot = $('boot');
const bootMsg = $('bootMsg');

function fail(msg) {
  boot.classList.add('error');
  boot.innerHTML = `<div>${msg}</div>`;
  console.error(msg);
}

/* ---------------------------------------------------------
 * 启动
 * ------------------------------------------------------- */
async function start() {
  const canvas = document.createElement('canvas');
  $('stage').appendChild(canvas);

  bootMsg.textContent = '正在初始化 WebGPU 渲染器…';

  let stage;
  try {
    stage = createStage(canvas);
    await stage.renderer.init();   // WebGPU 后端在这里才真正建立
    stage.initEnvironment();       // PMREM 必须在后端就绪之后
  } catch (e) {
    fail('WebGPU 初始化失败<br><br>' +
      '请使用 Chrome / Edge 113+ 并开启硬件加速。<br>' +
      `<span style="opacity:.5;font-size:11px">${e?.message || e}</span>`);
    return;
  }

  const { renderer, scene } = stage;

  bootMsg.textContent = '正在构建模型…';
  let product;
  try {
    product = buildProduct();
    scene.add(product.root);
  } catch (e) {
    fail('模型构建失败<br><br>' + `<span style="opacity:.5;font-size:11px">${e?.stack || e}</span>`);
    return;
  }

  const rig = makeCameraRig(stage.camera, canvas);

  /* ---------- 尺寸自适应 ---------- */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    fitCamera(stage.camera, w, h);
  }
  resize();
  addEventListener('resize', resize);

  /* ---------- 舱门动画状态 ---------- */
  const doorState = {
    t: 0,          // 当前值 0..1
    target: 0,     // 目标值
    speed: 3.4,    // 每秒逼近速度
    wobble: 0,     // 落定后的回弹
  };

  // 舱门:绕底后棱转开。负角度让顶盖向后上方掀开
  // 铰链轴平行于 X,局部 +Y 竖直向上、+Z 朝前。
  // 绕 X 负转,门顶向 -Z(后方)倒下去 —— 磁带舱门那种向后掀开。
  function applyDoor(t) {
    product.hinge.rotation.x = -DIM.openMax * t;
    // 顶唇跟着门走,不需要单独处理(它挂在 hinge 里)
    // 轻微回弹:接近 1 时给一点点过冲
    if (doorState.wobble > 0.001) {
      product.hinge.rotation.x += Math.sin(doorState.wobble * 22) * 0.012 * doorState.wobble;
    }
  }

  /* ---------- UI ---------- */
  const btnDoor = $('btnDoor');
  const slDoor = $('slDoor');
  const btnSpin = $('btnSpin');

  let uiLock = false; // 拖动滑块时不要被动画覆盖

  function setDoor(target) {
    doorState.target = target;
    btnDoor.textContent = target > 0.5 ? '关闭舱门' : '开舱门';
    if (!uiLock) slDoor.value = String(doorState.t);
  }

  btnDoor.addEventListener('click', () => {
    setDoor(doorState.target > 0.5 ? 0 : 1);
  });

  slDoor.addEventListener('input', () => {
    uiLock = true;
    doorState.t = parseFloat(slDoor.value);
    doorState.target = doorState.t;
    applyDoor(doorState.t);
    btnDoor.textContent = doorState.t > 0.5 ? '关闭舱门' : '开舱门';
  });
  slDoor.addEventListener('change', () => {
    uiLock = false;
    setDoor(doorState.t > 0.5 ? 1 : 0);
  });

  // 点击模型上的红色按钮 / 挂耳也切换舱门(电子件按钮)
  let autoSpin = true;
  btnSpin.addEventListener('click', () => {
    autoSpin = !autoSpin;
    btnSpin.classList.toggle('on', autoSpin);
  });

  // 双击画布复位视角
  canvas.addEventListener('dblclick', () => rig.reset());

  /* ---------- 渲染循环 ---------- */
  const timer = new THREE.Timer();
  let last = performance.now();

  // 调试/截图口子(见 smoke.js)
  let pauseRender = false;
  window.__polaroid = {
    stage, product, rig, doorState, orbit,
    get pauseRender() { return pauseRender; },
    set pauseRender(v) { pauseRender = !!v; },
  };

  function frame(now) {
    requestAnimationFrame(frame);
    if (pauseRender) return;   // 暂停:不更新也不重绘
    timer.update(now);

    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // 舱门缓动:指数逼近 + 落定回弹
    const before = doorState.t;
    const k = 1 - Math.exp(-doorState.speed * dt);
    doorState.t += (doorState.target - doorState.t) * k;
    if (Math.abs(doorState.target - doorState.t) < 0.0008) doorState.t = doorState.target;

    if (before !== doorState.t) {
      // 每次落定时给一次回弹脉冲
      if (Math.abs(doorState.t - doorState.target) < 0.02 &&
          Math.abs(before - doorState.target) >= 0.02) {
        doorState.wobble = 1;
      }
      applyDoor(doorState.t);
      if (!uiLock) slDoor.value = String(doorState.t);
    }

    if (doorState.wobble > 0.001) {
      doorState.wobble *= Math.exp(-6 * dt);
      applyDoor(doorState.t);
    }

    // 自动旋转
    if (autoSpin && !rig.isDragging()) {
      orbit.azimuth += dt * 0.16;
    }

    rig.update(dt);
    renderer.render(scene, productCamera());
  }

  function productCamera() { return stage.camera; }

  // window.__polaroid 已在上方定义(含 pauseRender)

  bootMsg.textContent = '就绪';
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
    boot.classList.add('done');
  });
}

// 兜底:任何未捕获异常都显示到页面上,不要只是静默卡住
addEventListener('error', (e) => {
  if (!boot.classList.contains('done')) {
    fail('未捕获异常<br><br>' +
      `<span style="opacity:.5;font-size:11px;white-space:pre-wrap">${
        (e.error && (e.error.stack || e.error.message)) || e.message}</span>`);
  }
});
addEventListener('unhandledrejection', (e) => {
  if (!boot.classList.contains('done')) {
    fail('未处理的 Promise 拒绝<br><br>' +
      `<span style="opacity:.5;font-size:11px;white-space:pre-wrap">${
        (e.reason && (e.reason.stack || e.reason.message)) || e.reason}</span>`);
  }
});

start();
