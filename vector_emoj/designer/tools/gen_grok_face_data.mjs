// gen_grok_face_data.mjs — 从参考网页（grokbot.yin.wiki）的 grok-recipes.json 生成 src/user/grok_face_data.c
//
// 用法：node tools/gen_grok_face_data.mjs <grok-recipes.json> [out.c]
// 只导出表情轮播用到的 5 个状态（idle / excited / curious / confused / drowsy）及其 clip、眼形与引擎常量。
// 数据版权归原所有者，仅供内部评估 / 学习研究，不得用于量产固件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , src, outArg] = process.argv;
if (!src) {
  console.error('usage: node gen_grok_face_data.mjs <grok-recipes.json> [out.c]');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const out = outArg ?? path.join(here, '..', 'src', 'user', 'grok_face_data.c');
const R = JSON.parse(fs.readFileSync(src, 'utf8'));
const C = R.constants;

const STATES = ['idle', 'excited', 'curious', 'confused', 'drowsy', 'computing'];   // 与 grok_expr_t 顺序一致
const SPINE_N = 21;

const exprAlias = new Map(Object.entries(R.expressionAliases));
const trackAlias = new Map(Object.entries(R.aliases.tracks));
const normFace = (v) => {
  const t = v.trim().toLowerCase(), n = exprAlias.get(t) ?? t;
  return R.expressionNames.includes(n) ? n : 'neutral';
};
const fnum = (x) => {
  let s = String(Math.round(x * 1e6) / 1e6);
  if (s === '-0') s = '0';
  return (/[.e]/.test(s) ? s : s + '.0') + 'f';
};
const cid = (s) => s.replace(/[^A-Za-z0-9]/g, '_');
const fail = (msg) => { console.error('error: ' + msg); process.exit(1); };

// ---------- 收集 clip 与表情 ----------
const clipNames = [];
for (const s of STATES) {
  if (!R.states[s]) fail(`state ${s} missing`);
  for (const c of R.states[s].clips) if (!clipNames.includes(c)) clipNames.push(c);
}
const faces = ['neutral'];
const addFace = (f) => { if (!faces.includes(f)) faces.push(f); };
for (const s of STATES) if (R.states[s].face) addFace(normFace(R.states[s].face));

const clips = clipNames.map((name) => {
  const c = R.clips.find((x) => x.name === name);
  if (!c) fail(`clip ${name} missing`);
  if ((c.body ?? 'sphere') !== 'sphere') fail(`clip ${name}: body ${c.body} not supported`);
  const tracks = {};
  for (const [k, keys] of Object.entries(c.tracks)) {
    const a = trackAlias.get(k);
    if (a !== undefined) tracks[a] = keys;
  }
  if (tracks.squash?.length) fail(`clip ${name}: squash track not supported`);
  const blinks = [], events = [];
  for (const e of tracks.expression ?? []) {
    if (e.v === 'blink') { blinks.push(e.t); continue; }
    if (e.cut === false) fail(`clip ${name}: through-blink expression not supported`);
    const face = normFace(e.v);
    addFace(face);
    events.push({ t: e.t, face });
  }
  return {
    name, duration: c.duration, restTime: c.workArea ? c.workArea.start : 0, anchor: c.squashAnchor ?? 0,
    pos: tracks.position ?? [], rot: tracks.rotation ?? [], zoom: tracks.zoom ?? [], lids: tracks.lids ?? [], blinks, events,
  };
});

for (const f of faces) {
  for (const e of R.expressions[f]) {
    if (e.pts.length !== SPINE_N) fail(`face ${f}: spine has ${e.pts.length} points`);
    if (Math.abs(e.tilt) > 1e-9 || e.lidY !== 1) fail(`face ${f}: tilt/lid not supported`);
    // 椭圆眼（calm）：原版 SDF 的 ellipseMix = smoothstep(0..0.08, min(oval))，必须是纯椭圆或纯胶囊
    const mn = Math.min(e.oval[0], e.oval[1]);
    if (mn > 1e-5 && e.ovalMix <= 1e-4 && mn < 0.08) fail(`face ${f}: partial ellipse mix not supported`);
  }
}

// ---------- 生成 C ----------
const L = [];
L.push(`/**
 * grok_face_data.c — 由 tools/gen_grok_face_data.mjs 生成，请勿手改
 *
 * 数据来源：参考网页 https://grokbot.yin.wiki/ 的 js/vendor/grok-recipes.json
 * （该网页逆向自 Grok Bot 应用，${R.meta?.extractedAt ?? ''}）。
 * 版权归原所有者，仅供内部评估 / 学习研究，不得用于量产固件。
 */
#include "grok_face_internal.h"
`);

const ease = (e) => (e?.length === 4 ? e : C.ease.nr);
const keyRow = (k, n) => {
  const v = Array.from({ length: 3 }, (_, i) => fnum(i < n ? k.v[i] : 0));
  return `    { ${fnum(k.t)}, { ${v.join(', ')} }, { ${ease(k.ease).map(fnum).join(', ')} } },`;
};
const trackRef = (c, t) => (c[t].length ? `{ k_${cid(c.name)}_${t}, ${c[t].length} }` : '{ 0, 0 }');

for (const c of clips) {
  for (const [t, n] of [['pos', 2], ['rot', 3], ['zoom', 1], ['lids', 1]]) {
    if (!c[t].length) continue;
    L.push(`static const gf_key_t k_${cid(c.name)}_${t}[] =\n{`);
    c[t].forEach((k) => L.push(keyRow(k, n)));
    L.push('};');
  }
  if (c.blinks.length) L.push(`static const float k_${cid(c.name)}_blinks[] = { ${c.blinks.map(fnum).join(', ')} };`);
  if (c.events.length) {
    L.push(`static const gf_event_t k_${cid(c.name)}_events[] =\n{`);
    c.events.forEach((e) => L.push(`    { ${fnum(e.t)}, GF_FACE_${e.face.toUpperCase()} },`));
    L.push('};');
  }
  L.push('');
}

L.push('const gf_clip_t gf_clips[GF_CLIP_COUNT] =\n{');
for (const c of clips) {
  const bl = c.blinks.length ? `k_${cid(c.name)}_blinks, ${c.blinks.length}` : '0, 0';
  const ev = c.events.length ? `k_${cid(c.name)}_events, ${c.events.length}` : '0, 0';
  L.push(`    [GF_CLIP_${cid(c.name).toUpperCase()}] = { "${c.name}", ${fnum(c.duration)}, ${fnum(c.restTime)}, ${fnum(c.anchor)},`);
  L.push(`        ${trackRef(c, 'pos')}, ${trackRef(c, 'rot')}, ${trackRef(c, 'zoom')}, ${trackRef(c, 'lids')}, ${bl}, ${ev} },`);
}
L.push('};\n');

L.push('const gf_face_t gf_faces[GF_FACE_COUNT] =\n{');
for (const f of faces) {
  L.push(`    [GF_FACE_${f.toUpperCase()}] = { "${f}", ${R.blinkBlockingExpressions.includes(f) ? 1 : 0},\n        {`);
  for (const e of R.expressions[f]) {
    const pts = e.pts.map((p) => `{ ${fnum(p[0])}, ${fnum(p[1])} }`);
    const rows = [];
    for (let i = 0; i < pts.length; i += 4) rows.push('                ' + pts.slice(i, i + 4).join(', ') + ',');
    const oval = Math.min(e.oval[0], e.oval[1]) > 1e-5 ? e.oval : [0, 0];
    L.push(`            { { ${fnum(e.off[0])}, ${fnum(e.off[1])} }, ${fnum(e.wid)}, { ${fnum(oval[0])}, ${fnum(oval[1])} },\n              {\n${rows.join('\n')}\n              } },`);
  }
  L.push('        } },');
}
L.push('};\n');

for (const s of STATES) {
  const ids = R.states[s].clips.map((c) => `GF_CLIP_${cid(c).toUpperCase()}`);
  L.push(`static const uint8_t k_pool_${cid(s)}[] = { ${ids.join(', ')} };`);
}
L.push('\nconst gf_state_t gf_states[GROK_EXPR_COUNT] =\n{');
STATES.forEach((s, i) => {
  const face = R.states[s].face ? `GF_FACE_${normFace(R.states[s].face).toUpperCase()}` : '-1';
  L.push(`    [${i}] = { "${s}", k_pool_${cid(s)}, ${R.states[s].clips.length}, ${face} },`);
});
L.push('};\n');

const B = R.eyes.basis;
L.push('/* 眼球基向量 [眼][M 中心, C 横向(朝外), T 向上] */');
L.push('const float gf_eye_basis[2][3][3] =\n{');
for (const b of B) L.push(`    { { ${b.M.map(fnum).join(', ')} }, { ${b.C.map(fnum).join(', ')} }, { ${b.T.map(fnum).join(', ')} } },`);
L.push('};\n');

const tol = C.bridge.tolerance;
L.push('const gf_consts_t gf_consts =\n{');
L.push(`    ${fnum(C.durations.blink)}, ${fnum(C.durations.blinkClose)}, ${fnum(C.durations.morph)}, ${fnum(C.bridge.duration)}, ${fnum(C.runtime.zoomDefault)},`);
L.push(`    ${fnum(C.eyes.Ab)}, ${fnum(C.eyes.Ib)}, ${fnum(C.runtime.maxAdvance)},`);
L.push(`    { ${C.ease.nr.map(fnum).join(', ')} }, { ${C.ease.tb.map(fnum).join(', ')} }, { ${C.bridge.easeFrom.map(fnum).join(', ')} },`);
L.push(`    { ${fnum(tol.rotDeg)}, ${fnum(tol.pos)}, ${fnum(tol.zoom)}, ${fnum(tol.lids)} },`);
L.push('};');

// 枚举写进同名的生成头文件，供 grok_face_internal.h 引用
const H = [`/* grok_face_ids.h — 由 tools/gen_grok_face_data.mjs 生成，请勿手改 */
#ifndef GROK_FACE_IDS_H
#define GROK_FACE_IDS_H
`];
H.push('enum\n{');
clips.forEach((c) => H.push(`    GF_CLIP_${cid(c.name).toUpperCase()},`));
H.push('    GF_CLIP_COUNT\n};\n');
H.push('enum\n{');
faces.forEach((f) => H.push(`    GF_FACE_${f.toUpperCase()},`));
H.push('    GF_FACE_COUNT\n};\n');
H.push(`#define GF_SPINE_N ${SPINE_N}\n\n#endif // GROK_FACE_IDS_H`);

fs.writeFileSync(out, L.join('\n') + '\n');
fs.writeFileSync(path.join(path.dirname(out), 'grok_face_ids.h'), H.join('\n') + '\n');
console.log(`wrote ${out}: ${clips.length} clips [${clipNames}], ${faces.length} faces [${faces}]`);
