#!/usr/bin/env python3
"""make_samples.py — 生成各格式的 camera dump 样例

用同一张参考图(彩条 + 灰阶 + 肤色块 + 高频细节)编码成各种格式,
既给查看器当测试素材,也给 selftest.js 当 ground truth:
JS 解码结果与这里的 reference.png 逐像素比,误差超阈值就算回归。

    python make_samples.py              # 默认 640x480,写到 samples/
    python make_samples.py -w 1920 -H 1080
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

# ------------------------------------------------------------------ 参考图

def make_reference(w, h):
    """造一张信息量足够的测试图:
    上 1/2 彩条(测颜色通道 / CFA)、中间灰阶(测位深与黑电平)、
    下半肤色渐变 + 高频黑白细纹(测色度抽样与去马赛克锐度)。"""
    img = np.zeros((h, w, 3), dtype=np.uint8)

    bars = [(255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0),
            (255, 0, 255), (255, 0, 0), (0, 0, 255), (0, 0, 0)]
    y1 = h // 2
    for i, c in enumerate(bars):
        x0, x1 = w * i // len(bars), w * (i + 1) // len(bars)
        img[:y1, x0:x1] = c

    # 灰阶条:横向 0->255 线性
    y2 = y1 + max(1, h // 8)
    ramp = (np.arange(w) * 255 // max(1, w - 1)).astype(np.uint8)
    img[y1:y2, :] = ramp[None, :, None]

    # 肤色渐变(YUV 色度失真在肤色上最容易看出来)
    y3 = y2 + max(1, (h - y2) // 2)
    gx = np.linspace(0, 1, w)[None, :]
    img[y2:y3, :, 0] = (215 - 55 * gx).astype(np.uint8)
    img[y2:y3, :, 1] = (170 - 60 * gx).astype(np.uint8)
    img[y2:y3, :, 2] = (150 - 65 * gx).astype(np.uint8)

    # 高频细纹:1px 竖条 + 右侧 1px 横条,4:2:2/4:2:0 的色度抽样会在这里露出来
    blk = img[y3:, :]
    if blk.size:
        bh = blk.shape[0]
        cols = (np.arange(w) % 2 == 0)
        blk[:, cols] = 255
        blk[:, ~cols] = 0
        half = w // 2
        rows = (np.arange(bh) % 2 == 0)
        blk[rows, half:] = 255
        blk[~rows, half:] = 0
        # 一小块纯红/纯蓝细纹,专门暴露 R/B 通道错位
        q = w // 8
        blk[:bh // 2, :q][cols[:q][None, :].repeat(bh // 2, 0)] = (255, 0, 0)
        blk[:bh // 2, q:2 * q] = (0, 0, 255)
    return img

# ------------------------------------------------------------------ 色彩空间

def rgb_to_yuv(rgb, matrix='bt601', full=False):
    """返回浮点 Y,U,V(U/V 已加 128 偏移),与 decoders.js 的反变换严格互逆。"""
    kr, kb = {'bt601': (0.299, 0.114),
              'bt709': (0.2126, 0.0722),
              'bt2020': (0.2627, 0.0593)}[matrix]
    kg = 1 - kr - kb
    r, g, b = rgb[..., 0] / 255.0, rgb[..., 1] / 255.0, rgb[..., 2] / 255.0
    y = kr * r + kg * g + kb * b
    u = (b - y) / (2 * (1 - kb))
    v = (r - y) / (2 * (1 - kr))
    if full:
        return y * 255, u * 255 + 128, v * 255 + 128
    return y * 219 + 16, u * 224 + 128, v * 224 + 128


def _round8(a):
    return np.clip(np.rint(a), 0, 255).astype(np.uint8)


def chroma_422(c):
    """水平 2:1 抽样 —— 取每对像素的平均(box),与解码端的复制还原互补。"""
    h, w = c.shape
    return c.reshape(h, w // 2, 2).mean(axis=2)


def chroma_420(c):
    h, w = c.shape
    return c.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))

# ------------------------------------------------------------------ 编码器

def enc_rgb565(img, swap_rb=False, big_endian=False):
    r, g, b = img[..., 0].astype(np.uint16), img[..., 1].astype(np.uint16), img[..., 2].astype(np.uint16)
    if swap_rb:
        r, b = b, r
    v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    return v.astype('>u2' if big_endian else '<u2').tobytes()


def enc_rgb888(img, swap_rb=False):
    a = img[..., ::-1] if swap_rb else img
    return np.ascontiguousarray(a).tobytes()


def enc_rgba8888(img, swap_rb=False):
    h, w, _ = img.shape
    out = np.empty((h, w, 4), dtype=np.uint8)
    out[..., :3] = img[..., ::-1] if swap_rb else img
    out[..., 3] = 255
    return out.tobytes()


def enc_packed422(img, order, matrix='bt601', full=False):
    """order: 4 字节宏像素内 [Y0,Y1,U,V] 的偏移,与 decoders.js 的 PACKED422 一致。"""
    y, u, v = rgb_to_yuv(img, matrix, full)
    h, w = y.shape
    us, vs = chroma_422(u), chroma_422(v)
    out = np.empty((h, w // 2, 4), dtype=np.uint8)
    oy0, oy1, ou, ov = order
    out[..., oy0] = _round8(y[:, 0::2])
    out[..., oy1] = _round8(y[:, 1::2])
    out[..., ou] = _round8(us)
    out[..., ov] = _round8(vs)
    return out.tobytes()


def enc_planar(img, sub, semi, swap, matrix='bt601', full=False):
    y, u, v = rgb_to_yuv(img, matrix, full)
    us = chroma_420(u) if sub == 2 else chroma_422(u)
    vs = chroma_420(v) if sub == 2 else chroma_422(v)
    us, vs = _round8(us), _round8(vs)
    buf = [_round8(y).tobytes()]
    if semi:
        ch, cw = us.shape
        inter = np.empty((ch, cw, 2), dtype=np.uint8)
        inter[..., 0] = vs if swap else us
        inter[..., 1] = us if swap else vs
        buf.append(inter.tobytes())
    else:
        buf += [vs.tobytes(), us.tobytes()] if swap else [us.tobytes(), vs.tobytes()]
    return b''.join(buf)


def enc_gray8(img, matrix='bt601', full=False):
    y, _, _ = rgb_to_yuv(img, matrix, full)
    return _round8(y).tobytes()


def to_bayer(img, cfa='rggb', bits=8):
    """按 CFA 从 RGB 抽样出 Bayer 平面(每像素只留一个通道)。"""
    idx = {'rggb': [0, 1, 1, 2], 'bggr': [2, 1, 1, 0],
           'grbg': [1, 0, 2, 1], 'gbrg': [1, 2, 0, 1]}[cfa]
    h, w, _ = img.shape
    ys, xs = np.mgrid[0:h, 0:w]
    ch = np.array(idx)[((ys & 1) << 1) | (xs & 1)]
    flat = np.take_along_axis(img, ch[..., None], axis=2)[..., 0]
    if bits == 8:
        return flat.astype(np.uint16)
    return (flat.astype(np.uint32) * ((1 << bits) - 1) // 255).astype(np.uint16)


def pack_raw10_mipi(p):
    h, w = p.shape
    g = p.reshape(h, w // 4, 4).astype(np.uint16)
    out = np.empty((h, w // 4, 5), dtype=np.uint8)
    for k in range(4):
        out[..., k] = (g[..., k] >> 2).astype(np.uint8)
    out[..., 4] = ((g[..., 0] & 3) | ((g[..., 1] & 3) << 2) |
                   ((g[..., 2] & 3) << 4) | ((g[..., 3] & 3) << 6)).astype(np.uint8)
    return out.tobytes()


def pack_raw12_mipi(p):
    h, w = p.shape
    g = p.reshape(h, w // 2, 2).astype(np.uint16)
    out = np.empty((h, w // 2, 3), dtype=np.uint8)
    out[..., 0] = (g[..., 0] >> 4).astype(np.uint8)
    out[..., 1] = (g[..., 1] >> 4).astype(np.uint8)
    out[..., 2] = ((g[..., 0] & 15) | ((g[..., 1] & 15) << 4)).astype(np.uint8)
    return out.tobytes()


def pack_raw_unpacked(p, big_endian=False, shift=0):
    return (p.astype(np.uint16) << shift).astype('>u2' if big_endian else '<u2').tobytes()

# ------------------------------------------------------------------ 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-w', '--width', type=int, default=640)
    ap.add_argument('-H', '--height', type=int, default=480)
    ap.add_argument('-o', '--out', default='samples')
    ap.add_argument('--src', help='用自己的图片代替内置测试图')
    args = ap.parse_args()

    w, h = args.width & ~3, args.height & ~1     # 宽对齐 4(RAW10 打包),高对齐 2(420)
    os.makedirs(args.out, exist_ok=True)

    if args.src:
        img = np.asarray(Image.open(args.src).convert('RGB').resize((w, h), Image.LANCZOS))
    else:
        img = make_reference(w, h)
    Image.fromarray(img).save(os.path.join(args.out, 'reference.png'))
    # selftest.js(Node)没法解 PNG,另存一份裸 RGB888 当 ground truth
    with open(os.path.join(args.out, 'reference.rgb'), 'wb') as f:
        f.write(np.ascontiguousarray(img).tobytes())

    P = lambda n: os.path.join(args.out, n)
    files = {}

    def emit(name, data, **meta):
        with open(P(name), 'wb') as f:
            f.write(data)
        files[name] = dict(bytes=len(data), width=w, height=h, **meta)
        print(f'  {name:36s} {len(data):>10,} B')

    print(f'reference {w}x{h} -> {args.out}/')

    # ---- RGB ----
    emit(f'rgb565_{w}x{h}.raw', enc_rgb565(img), fmt='rgb565')
    emit(f'rgb565be_{w}x{h}.raw', enc_rgb565(img, big_endian=True), fmt='rgb565', bigEndian=True)
    emit(f'bgr565_{w}x{h}.raw', enc_rgb565(img, swap_rb=True), fmt='bgr565')
    emit(f'rgb888_{w}x{h}.raw', enc_rgb888(img), fmt='rgb888')
    emit(f'bgr888_{w}x{h}.raw', enc_rgb888(img, swap_rb=True), fmt='bgr888')
    emit(f'rgba8888_{w}x{h}.raw', enc_rgba8888(img), fmt='rgba8888')

    # ---- YUV422 packed ----
    for fid, order in [('yuyv', (0, 2, 1, 3)), ('yvyu', (0, 2, 3, 1)),
                       ('uyvy', (1, 3, 0, 2)), ('vyuy', (1, 3, 2, 0))]:
        emit(f'{fid}_{w}x{h}.yuv', enc_packed422(img, order), fmt=fid)
    emit(f'yuyv_full_{w}x{h}.yuv', enc_packed422(img, (0, 2, 1, 3), full=True),
         fmt='yuyv', range='full')
    emit(f'yuyv_bt709_{w}x{h}.yuv', enc_packed422(img, (0, 2, 1, 3), matrix='bt709'),
         fmt='yuyv', matrix='bt709')

    # ---- YUV422 / 420 planar ----
    for fid, (sub, semi, swap) in {
        'nv16': (1, True, False), 'nv61': (1, True, True),
        'i422': (1, False, False), 'yv16': (1, False, True),
        'nv12': (2, True, False), 'nv21': (2, True, True),
        'i420': (2, False, False), 'yv12': (2, False, True),
    }.items():
        emit(f'{fid}_{w}x{h}.yuv', enc_planar(img, sub, semi, swap), fmt=fid)

    emit(f'gray8_{w}x{h}.raw', enc_gray8(img), fmt='gray8')

    # ---- RAW / Bayer ----
    b8 = to_bayer(img, 'rggb', 8)
    emit(f'raw8_rggb_{w}x{h}.raw', b8.astype(np.uint8).tobytes(), fmt='raw8', cfa='rggb')
    emit(f'raw8_bggr_{w}x{h}.raw', to_bayer(img, 'bggr', 8).astype(np.uint8).tobytes(),
         fmt='raw8', cfa='bggr')
    emit(f'raw8_grbg_{w}x{h}.raw', to_bayer(img, 'grbg', 8).astype(np.uint8).tobytes(),
         fmt='raw8', cfa='grbg')

    b10 = to_bayer(img, 'rggb', 10)
    emit(f'raw10p_rggb_{w}x{h}.raw', pack_raw10_mipi(b10), fmt='raw10p', cfa='rggb')
    emit(f'raw10u_rggb_{w}x{h}.raw', pack_raw_unpacked(b10), fmt='raw10u', cfa='rggb')
    emit(f'raw10u_msb_rggb_{w}x{h}.raw', pack_raw_unpacked(b10, shift=6),
         fmt='raw10u', cfa='rggb', msbAligned=True)

    b12 = to_bayer(img, 'rggb', 12)
    emit(f'raw12p_rggb_{w}x{h}.raw', pack_raw12_mipi(b12), fmt='raw12p', cfa='rggb')
    emit(f'raw12u_rggb_{w}x{h}.raw', pack_raw_unpacked(b12), fmt='raw12u', cfa='rggb')

    b16 = to_bayer(img, 'rggb', 16)
    emit(f'raw16_rggb_{w}x{h}.raw', pack_raw_unpacked(b16), fmt='raw16', cfa='rggb')

    # ---- JPEG ----
    Image.fromarray(img).save(P(f'jpeg_{w}x{h}.jpg'), quality=90, subsampling=1)
    files[f'jpeg_{w}x{h}.jpg'] = dict(bytes=os.path.getsize(P(f'jpeg_{w}x{h}.jpg')),
                                      width=w, height=h, fmt='jpeg')
    print(f'  jpeg_{w}x{h}.jpg{"":21s} {files[f"jpeg_{w}x{h}.jpg"]["bytes"]:>10,} B')

    # ---- 带 stride 填充的一例(真机 dump 常见:行按 64 对齐)----
    ls = ((w * 2 + 63) // 64) * 64
    if ls == w * 2:
        ls += 64          # 宽度恰好对齐时也强制留一段填充,保证这个样例真的在测 stride
    pad = bytearray()
    src = enc_rgb565(img)
    for y in range(h):
        row = src[y * w * 2:(y + 1) * w * 2]
        pad += row + bytes(ls - len(row))
    emit(f'rgb565_stride{ls}_{w}x{h}.raw', bytes(pad), fmt='rgb565', stride=ls)

    with open(P('manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'width': w, 'height': h, 'files': files}, f, indent=2, ensure_ascii=False)
    print(f'\n{len(files)} files + reference.png + manifest.json')


if __name__ == '__main__':
    main()
