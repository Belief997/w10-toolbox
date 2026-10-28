#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJPEG — PNG ->「baseline JPEG (YUV 4:2:0) + 尾部 RLE 压缩 alpha 通道」

做四件事:
  1. 把 PNG 拆成 RGB 和 A 两份。RGB 编成 YUV420 的 baseline JPEG,质量可调。
  2. A 按 8bit/像素取出,逐行做 RLE 压缩。RLE 节点格式与 HoneyGUI
     image-converter 的 rle.ts 一致:[len:1][byte:1],行内独立、run 上限 255。
     如果 RLE 反而比裸数据大(alpha 噪点多的图),自动退回 RAW 存储。
  3. 把 A 块拼到 JPEG 的 EOI 之后,文件后缀仍然是 .jpg。A 块自带 header +
     行偏移表,解码端不需要额外参数就能还原 alpha。
  4. 统计压缩率 / 画质(PSNR / SSIM),把结果喂给 ajpeg-compare.html。

文件布局:
    [0 .. J)                baseline JPEG,YUV 4:2:0,以 FF D9 结束
    [J .. J+16)             alpha 块头 (16 B,见下面的 struct)
    [J+16 .. J+16+4(h+1))   行偏移表,(h+1) × u32 LE,相对 payload 起点
    [... )                  payload:RLE 节点流(len:1 + byte:1)或裸 alpha
    [末尾 12)               尾部索引:jpeg_size u32 | block_size u32 | 'AJP1'

    alpha 块头(16 B):
        +0  'AJP1'           magic
        +4  u16 width
        +6  u16 height
        +8  u8  algo          0 = RLE, 1 = RAW
        +9  u8  feature_1     RLE 参数(与参考实现对齐,恒为 0)
        +10 u8  feature_2
        +11 u8  flags         bit0 = has_alpha(图里存在 <255 的像素)
        +12 u32 payload_size

用法:
    python make_ajpeg.py --make-samples                  # 生成 samples/ 下的演示图
    python make_ajpeg.py -s samples/alpha_soft.png       # 单张
    python make_ajpeg.py -s samples -q 70,85,95          # 整个文件夹
    python make_ajpeg.py -s samples -q 90 --no-html      # 只出 .jpg,不生成查看器
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from scipy.ndimage import gaussian_filter
    _HAS_SCIPY = True
except ImportError:  # pragma: no cover
    _HAS_SCIPY = False

MAGIC = b"AJP1"
HEADER_SIZE = 16
FOOTER_SIZE = 12

ALGO_RLE = 0
ALGO_RAW = 1

SUBSAMPLING = {  # PIL 的 subsampling 编号 -> libjpeg 采样
    "444": 0,
    "422": 1,
    "420": 2,
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tga", ".gif"}


# --------------------------------------------------------------------------- #
# RLE:与 honeygui-design/tools/image-converter/compress/rle.ts 同格式
# --------------------------------------------------------------------------- #

def rle_encode_line(line: bytes) -> bytearray:
    """一行 alpha -> [len][byte] 节点流。与 rle.ts 的 compressLine 逐字节一致。"""
    out = bytearray()
    i, n = 0, len(line)
    while i < n:
        b = line[i]
        run = 1
        j = i + 1
        while j < n and run < 255 and line[j] == b:
            run += 1
            j += 1
        out.append(run)
        out.append(b)
        i = j
    return out


def rle_encode(alpha: bytes, width: int, height: int):
    """整图逐行 RLE。返回 (payload, 行偏移表(含末尾偏移), 节点数)。"""
    payload = bytearray()
    offsets: list[int] = []
    nodes = 0
    for y in range(height):
        offsets.append(len(payload))
        row = alpha[y * width:(y + 1) * width]
        nodes += (len(rle_encode_line(row)) // 2)
        payload += rle_encode_line(row)
    offsets.append(len(payload))
    return bytes(payload), offsets, nodes


def rle_decode(payload: bytes, offsets, height: int) -> bytes:
    out = bytearray()
    for y in range(height):
        p, end = offsets[y], offsets[y + 1]
        while p < end:
            run, val = payload[p], payload[p + 1]
            out += bytes((val,)) * run
            p += 2
    return bytes(out)


def raw_offsets(width: int, height: int):
    return [y * width for y in range(height)] + [width * height]


# --------------------------------------------------------------------------- #
# JPEG 码流解析(用来验证真的是 4:2:0 / baseline)
# --------------------------------------------------------------------------- #

SOF_NAMES = {0xC0: "SOF0", 0xC1: "SOF1", 0xC2: "SOF2", 0xC3: "SOF3",
             0xC5: "SOF5", 0xC6: "SOF6", 0xC7: "SOF7",
             0xC9: "SOF9", 0xCA: "SOF10", 0xCB: "SOF11"}
SOF_MARKERS = set(SOF_NAMES)


def jpeg_end(data: bytes) -> int:
    """返回 EOI 之后的下标(即 JPEG 码流真实长度)。"""
    if data[:2] != b"\xff\xd8":
        raise ValueError("不是 JPEG 码流")
    i, n = 2, len(data)
    while i < n - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        m = data[i]
        i += 1
        if m == 0xD9:                       # EOI
            return i
        if m == 0x01 or 0xD0 <= m <= 0xD7:  # 无长度字段
            continue
        if m == 0xDA:                       # SOS:后面是熵编码数据
            seg_len = int.from_bytes(data[i:i + 2], "big")
            i += seg_len
            while i < n - 1:
                if data[i] == 0xFF:
                    nxt = data[i + 1]
                    if nxt == 0x00 or nxt == 0xFF or 0xD0 <= nxt <= 0xD7:
                        i += 2
                        continue
                    break
                i += 1
            continue
        if i + 2 > n:
            break
        i += int.from_bytes(data[i:i + 2], "big")
    raise ValueError("没有找到 EOI")


def parse_jpeg(data: bytes) -> dict:
    """扫 SOF,取出帧类型、各分量采样因子、量化表号,以及 DQT 表数。"""
    info = {"sof": None, "progressive": False, "components": [], "dqt": 0}
    i, n = 2, jpeg_end(data)
    while i < n - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:
            i += 1
        m = data[i]
        i += 1
        if m == 0xD9:
            break
        if m == 0x01 or 0xD0 <= m <= 0xD7:
            continue
        if m == 0xDA:
            break
        seg_len = int.from_bytes(data[i:i + 2], "big")
        seg = data[i + 2:i + seg_len]
        i += seg_len
        if m == 0xDB:
            info["dqt"] += 1
        if m in SOF_MARKERS:
            info["sof"] = SOF_NAMES[m]
            info["progressive"] = m in (0xC2, 0xC6, 0xCA)
            nf = seg[5]
            for k in range(nf):
                cid, hv, tq = seg[6 + k * 3], seg[7 + k * 3], seg[8 + k * 3]
                info["components"].append({
                    "id": cid, "h": hv >> 4, "v": hv & 0x0F, "tq": tq,
                })
    return info


def sampling_label(info: dict) -> str:
    """把各分量采样因子翻译成 4:2:0 / 4:2:2 / 4:4:4。"""
    comps = info["components"]
    if not comps:
        return "?"
    y = comps[0]
    if y["h"] == 1 and y["v"] == 1:
        return "4:4:4"
    if y["h"] == 2 and y["v"] == 1:
        return "4:2:2"
    if y["h"] == 2 and y["v"] == 2:
        return "4:2:0"
    return f"{y['h']}x{y['v']}"


# --------------------------------------------------------------------------- #
# AJPEG 组装 / 拆解
# --------------------------------------------------------------------------- #

def build_alpha_block(alpha: bytes, width: int, height: int,
                      mode: str = "best") -> tuple[bytes, dict]:
    """生成 alpha 块。mode: 'best' 自动择优 | 'rle' 强制 RLE | 'raw' 强制裸存。"""
    payload_rle, off_rle, nodes = rle_encode(alpha, width, height)
    raw = alpha

    if mode == "rle":
        algo, payload, offsets = ALGO_RLE, payload_rle, off_rle
    elif mode == "raw":
        algo, payload, offsets = ALGO_RAW, raw, raw_offsets(width, height)
    else:
        if len(payload_rle) <= len(raw):
            algo, payload, offsets = ALGO_RLE, payload_rle, off_rle
        else:
            algo, payload, offsets = ALGO_RAW, raw, raw_offsets(width, height)

    header = bytearray(HEADER_SIZE)
    header[0:4] = MAGIC
    struct.pack_into("<HH", header, 4, width, height)
    header[8] = algo
    header[9] = 0                                    # feature_1(RLE 参数)
    header[10] = 0                                   # feature_2
    header[11] = 1 if any(a != 255 for a in alpha) else 0   # bit0 has_alpha
    struct.pack_into("<I", header, 12, len(payload))

    table = b"".join(struct.pack("<I", o) for o in offsets)
    block = bytes(header) + table + payload

    return block, {
        "algo": "RLE" if algo == ALGO_RLE else "RAW",
        "algo_id": algo,
        "rle_bytes": len(payload_rle),
        "rle_nodes": nodes,
        "raw_bytes": len(raw),
        "payload_bytes": len(payload),
        "table_bytes": len(table),
        "block_bytes": len(block),
        "has_alpha": header[11] == 1,
    }


def build_ajpeg(jpeg: bytes, alpha_block: bytes) -> bytes:
    jpeg_size = jpeg_end(jpeg)
    jpeg = jpeg[:jpeg_size]
    footer = struct.pack("<II4s", jpeg_size, len(alpha_block), MAGIC)
    return jpeg + alpha_block + footer


def parse_ajpeg(blob: bytes) -> dict:
    """从 .jpg 尾巴反解出 JPEG 段与 alpha。用于回环校验和给查看器用。"""
    if len(blob) < FOOTER_SIZE:
        raise ValueError("文件太短")
    jpeg_size, block_size, magic = struct.unpack("<II4s", blob[-FOOTER_SIZE:])
    if magic != MAGIC:
        raise ValueError("尾部没有 AJP1 magic,不是 AJPEG 文件")
    jpeg = blob[:jpeg_size]
    block = blob[jpeg_size:jpeg_size + block_size]
    if len(jpeg) != jpeg_size or len(block) != block_size:
        raise ValueError("尾部索引与文件长度对不上")

    header = block[:HEADER_SIZE]
    if header[0:4] != MAGIC:
        raise ValueError("alpha 块头 magic 错误")
    width, height = struct.unpack_from("<HH", header, 4)
    algo = header[8]
    payload_size = struct.unpack_from("<I", header, 12)[0]
    flags = header[11]

    table_bytes = (height + 1) * 4
    offsets = list(struct.unpack_from(f"<{height + 1}I", block, HEADER_SIZE))
    payload = block[HEADER_SIZE + table_bytes:HEADER_SIZE + table_bytes + payload_size]

    if algo == ALGO_RLE:
        alpha = rle_decode(payload, offsets, height)
    else:
        alpha = payload

    return {
        "jpeg": jpeg, "alpha": alpha, "width": width, "height": height,
        "algo": "RLE" if algo == ALGO_RLE else "RAW",
        "has_alpha": bool(flags & 1),
        "payload": payload, "offsets": offsets,
        "payload_size": payload_size, "block_size": block_size,
    }


# --------------------------------------------------------------------------- #
# 画质指标
# --------------------------------------------------------------------------- #

def psnr_rgb(a: np.ndarray, b: np.ndarray) -> float:
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0 ** 2 / mse)


def _gauss(x: np.ndarray) -> np.ndarray:
    if _HAS_SCIPY:
        return gaussian_filter(x, 1.5, truncate=10.0 / 3.0, mode="reflect")
    k = np.exp(-((np.arange(11) - 5) ** 2) / (2 * 1.5 ** 2))
    k /= k.sum()
    out = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, x)
    return np.apply_along_axis(lambda c: np.convolve(c, k, "same"), 0, out)


def ssim_luma(a_rgb: np.ndarray, b_rgb: np.ndarray) -> float:
    """标准 SSIM:11×11 高斯窗 σ=1.5,作用在亮度通道上。"""
    wa = np.array([0.299, 0.587, 0.114])
    a = (a_rgb.astype(np.float64) @ wa)
    b = (b_rgb.astype(np.float64) @ wa)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _gauss(a), _gauss(b)
    saa = _gauss(a * a) - mu_a * mu_a
    sbb = _gauss(b * b) - mu_b * mu_b
    sab = _gauss(a * b) - mu_a * mu_b
    num = (2 * mu_a * mu_b + c1) * (2 * sab + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2)
    return float(np.mean(num / den))


# --------------------------------------------------------------------------- #
# 单张图处理
# --------------------------------------------------------------------------- #

def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.2f} {unit}"
        n /= 1024


def load_rgba(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """返回 (RGB uint8 HxWx3, A uint8 HxW)。没有 alpha 通道就补 255。"""
    im = Image.open(path)
    im.load()
    if im.mode in ("I", "I;16", "F"):
        im = im.convert("I").point(lambda v: v / 256).convert("L")
    rgba = im.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.uint8)
    return np.ascontiguousarray(arr[:, :, :3]), np.ascontiguousarray(arr[:, :, 3])


def encode_jpeg(rgb: np.ndarray, quality: int, subsampling: int,
                optimize: bool = True) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(
        buf, "JPEG", quality=quality, subsampling=subsampling,
        optimize=optimize, progressive=False,
    )
    return buf.getvalue()


def process_image(path: Path, out_dir: Path, rel: Path, qualities, args) -> dict:
    rgb, alpha = load_rgba(path)
    height, width = alpha.shape
    if width > 65535 or height > 65535:
        raise SystemExit(f"{path}: 宽高超过 65535,alpha 块头放不下")

    png_bytes = path.stat().st_size
    alpha_bytes = alpha.tobytes()
    alpha_adler = zlib.adler32(alpha_bytes) & 0xFFFFFFFF

    # alpha 的可选编码成本,用来判断 RLE 到底值不值
    buf = io.BytesIO()
    Image.fromarray(alpha, "L").save(buf, "PNG", optimize=True)
    alpha_png = buf.getvalue()
    alpha_png_bytes = len(alpha_png)

    records = []
    out_path = out_dir / rel.with_suffix(".jpg")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # alpha 块与 JPEG 质量无关:算一次,所有质量档共用
    block, binfo = build_alpha_block(alpha_bytes, width, height, args.rle_mode)

    for q in qualities:
        jpeg = encode_jpeg(rgb, q, SUBSAMPLING[args.subsampling], not args.no_optimize)
        jpeg_size = jpeg_end(jpeg)
        jinfo = parse_jpeg(jpeg[:jpeg_size])

        blob = build_ajpeg(jpeg, block)

        # 回环校验:重新解析 + 解 alpha,必须与原图逐字节相同
        back = parse_ajpeg(blob)
        ok = (back["alpha"] == alpha_bytes and back["width"] == width
              and back["height"] == height and back["jpeg"] == jpeg[:jpeg_size])
        if not ok:
            raise SystemExit(f"{path}@{q}: 回环校验失败")

        dec = np.asarray(Image.open(io.BytesIO(back["jpeg"])).convert("RGB"), dtype=np.uint8)
        p = psnr_rgb(rgb, dec)
        s = ssim_luma(rgb, dec)

        record = {
            "q": q,
            "jpeg_bytes": jpeg_size,
            "block_bytes": binfo["block_bytes"],
            "ajpeg_bytes": len(blob),
            "algo": binfo["algo"],
            "algo_id": binfo["algo_id"],
            "payload_bytes": binfo["payload_bytes"],
            "rle_bytes": binfo["rle_bytes"],
            "rle_nodes": binfo["rle_nodes"],
            "raw_alpha_bytes": binfo["raw_bytes"],
            "table_bytes": binfo["table_bytes"],
            "psnr": None if p == float("inf") else round(p, 3),
            "ssim": round(s, 5),
            "jpeg": jinfo,
            "sampling": sampling_label(jinfo),
            "baseline": not jinfo["progressive"],
            "bpp": round(len(blob) * 8 / (width * height), 3),
            "vs_png": round(len(blob) / png_bytes, 4),
            "verify": ok,
            "_blob": blob,
            "_jpeg": back["jpeg"],
            "_payload": back["payload"],
            "_offsets": back["offsets"],
        }
        records.append(record)

        # 只有一档时沿用原文件名;多档时全部带质量后缀,避免含糊
        if len(qualities) == 1:
            target = out_path
        else:
            target = out_path.with_name(f"{out_path.stem}.q{q}{out_path.suffix}")
        target.write_bytes(blob)

    return {
        "name": path.name,
        "rel": str(rel),
        "out": str(target.relative_to(out_dir)),
        "width": width,
        "height": height,
        "png_bytes": png_bytes,
        "alpha_png_bytes": alpha_png_bytes,
        "has_alpha": bool(np.any(alpha != 255)),
        "alpha": alpha,
        "alpha_adler": alpha_adler,
        "alpha_png": alpha_png,
        "rgb": rgb,
        "qualities": records,
    }


# --------------------------------------------------------------------------- #
# 演示样图
# --------------------------------------------------------------------------- #

def make_samples(samples_dir: Path) -> None:
    """生成四张演示图:全不透明 / 柔和渐变 alpha / 硬边贴纸 / 贴纸反相。"""
    samples_dir.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parent
    src = root.parent / "progressiveJpeg" / "user-wallpaper.png"
    if not src.exists():
        raise SystemExit(f"找不到底图 {src},无法生成样图")

    base = Image.open(src).convert("RGB")
    w, h = base.size
    rgb = np.asarray(base, dtype=np.uint8)

    def tint(arr: np.ndarray, mat: np.ndarray) -> np.ndarray:
        """每个样图用不同的色彩变换,切换下拉框时一眼能看出换了图。"""
        out = arr.astype(np.float64) @ mat.T
        return np.clip(out, 0, 255).astype(np.uint8)

    # 1) 全不透明（原色）
    Image.fromarray(rgb, "RGB").convert("RGBA").save(samples_dir / "opaque.png", optimize=True)

    # 2) 柔和渐变 alpha:径向 + 线性叠加,alpha 大范围平滑变化
    yy, xx = np.mgrid[0:h, 0:w]
    nx = (xx - w / 2) / (w / 2)
    ny = (yy - h / 2) / (h / 2)
    radial = np.clip(1.0 - np.sqrt(nx ** 2 + ny ** 2) * 1.15, 0, 1)
    linear = np.clip(1.15 - yy / h * 1.3, 0, 1)
    a_soft = np.clip(radial * 0.75 + linear * 0.45, 0, 1)
    a_soft = (a_soft ** 0.85 * 255).astype(np.uint8)
    warm = tint(rgb, np.array([[1.10, 0.05, -0.05],
                               [0.02, 0.98, 0.02],
                               [-0.06, 0.04, 1.06]]))
    rgba = np.dstack([warm, a_soft])
    Image.fromarray(rgba, "RGBA").save(samples_dir / "alpha_soft.png", optimize=True)

    # 3) 硬边贴纸:圆角矩形 + 中间挖空 + 边缘抗锯齿,alpha 大量连续相同值
    a_hard = np.zeros((h, w), dtype=np.uint8)
    pad = h // 8
    y0, y1, x0, x1 = pad, h - pad, pad, w - pad
    r = h // 6
    cx0, cy0, cx1, cy1 = x0 + r, y0 + r, x1 - r, y1 - r
    inside = ((xx >= cx0) & (xx < cx1) & (yy >= y0) & (yy < y1)) | \
             ((yy >= cy0) & (yy < cy1) & (xx >= x0) & (xx < x1))
    corners = np.zeros((h, w), dtype=bool)
    for cx, cy in ((cx0, cy0), (cx1, cy0), (cx0, cy1), (cx1, cy1)):
        corners |= (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
    inside |= corners
    hole = (xx - w / 2) ** 2 + (yy - h / 2) ** 2 <= (h / 5) ** 2
    inside &= ~hole
    a_hard[inside] = 255
    cool = tint(rgb, np.array([[0.92, 0.02, 0.10],
                               [0.04, 1.02, 0.04],
                               [0.10, 0.02, 1.12]]))
    rgba = np.dstack([cool, a_hard])
    Image.fromarray(rgba, "RGBA").save(samples_dir / "alpha_sticker.png", optimize=True)

    # 4) 贴纸反相:前景/背景互换 —— 中间是洞、四周是实体。
    #    RLE 的游程统计会跟着反过来(原来"透明在外圈"的长 run 变成"不透明在外圈"),
    #    正好用来看压缩率对 alpha 极性有多敏感。
    a_inv = 255 - a_hard
    # 用另一套色调,和上面那张一眼能区分
    inv_tint = tint(rgb, np.array([[1.02, -0.04, 0.12],
                                   [-0.02, 0.96, 0.10],
                                   [0.06, -0.02, 0.90]]))
    rgba = np.dstack([inv_tint, a_inv])
    Image.fromarray(rgba, "RGBA").save(samples_dir / "alpha_sticker_inv.png", optimize=True)

    for p in sorted(samples_dir.glob("*.png")):
        print(f"  samples/{p.name:<24} {p.stat().st_size / 1024:8.1f} KB")


# --------------------------------------------------------------------------- #
# 输出:表格 / metrics.json / data.js
# --------------------------------------------------------------------------- #

def print_table(records) -> None:
    print()
    print(f"{'图':<18}{'q':>4}{'JPEG':>10}{'alpha块':>10}{'AJPEG':>10}"
          f"{'vs PNG':>9}{'bpp':>7}{'PSNR':>8}{'SSIM':>8}  {'alpha':<5}{'采样':<7}")
    print("-" * 96)
    for r in records:
        for q in r["qualities"]:
            print(f"{r['name']:<18}{q['q']:>4}{human(q['jpeg_bytes']):>10}"
                  f"{human(q['block_bytes']):>10}{human(q['ajpeg_bytes']):>10}"
                  f"{q['vs_png'] * 100:>8.1f}%{q['bpp']:>7.3f}"
                  f"{(q['psnr'] if q['psnr'] is not None else 99):>8.2f}"
                  f"{q['ssim']:>8.4f}  {q['algo']:<5}{q['sampling']:<7}")

    print("-" * 96)
    print("alpha 通道单独看:")
    for r in records:
        q = r["qualities"][0]
        raw = r["width"] * r["height"]
        print(f"  {r['name']:<18} raw {human(raw):>9}"
              f" | RLE {human(q['rle_bytes']):>9} ({q['rle_bytes'] / raw * 100:5.1f}%)"
              f" | PNG-L {human(r['alpha_png_bytes']):>9}"
              f" | 节点 {q['rle_nodes']:>7,}"
              f" | {'含透明像素' if r['has_alpha'] else '全不透明'}")
    print()


def to_json(records, args) -> dict:
    out = []
    for r in records:
        out.append({
            "name": r["name"],
            "rel": r["rel"],
            "width": r["width"],
            "height": r["height"],
            "png_bytes": r["png_bytes"],
            "alpha_png_bytes": r["alpha_png_bytes"],
            "has_alpha": r["has_alpha"],
            "qualities": [{k: v for k, v in q.items() if not k.startswith("_")}
                          for q in r["qualities"]],
        })
    return {
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "subsampling": args.subsampling,
        "optimize": not args.no_optimize,
        "rle_mode": args.rle_mode,
        "images": out,
    }


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def build_data_js(records, out_dir: Path, max_view: int, view_max: int) -> str:
    """给查看器的内联数据。

    原图 = 一张 4:4:4 / q98 的参考 JPEG(RGB 部分) + alphaPng(alpha 部分),
    查看器把两者叠起来才是真实原图 —— 只给 JPEG 的话,带透明的图会显示成
    带黑底的不透明图,和 AJPEG 重建结果对不上。alpha 另由 RLE payload 在
    查看器里现解,顺便验证了 JS 解码器。
    """
    payload = []
    for r in records[:max_view]:
        rgb = r["rgb"]
        alpha = r["alpha"]
        h, w = alpha.shape
        ref = Image.fromarray(rgb, "RGB")
        if max(w, h) > view_max:
            scale = view_max / max(w, h)
            ref = ref.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        view_jpeg = _b64(encode_jpeg(np.asarray(ref, dtype=np.uint8), 98, 0))

        quals = []
        for q in r["qualities"]:
            quals.append({
                "q": q["q"],
                "jpeg": _b64(q["_jpeg"]),
                "jpeg_bytes": q["jpeg_bytes"],
                "ajpeg_bytes": q["ajpeg_bytes"],
                "psnr": q["psnr"],
                "ssim": q["ssim"],
                "bpp": q["bpp"],
                "vs_png": q["vs_png"],
                "sampling": q["sampling"],
            })

        # alpha 块对所有质量档都一样,只存一份
        q0 = r["qualities"][0]
        payload.append({
            "name": r["name"],
            "width": w,
            "height": h,
            "png_bytes": r["png_bytes"],
            "alpha_png_bytes": r["alpha_png_bytes"],
            "has_alpha": r["has_alpha"],
            "viewJpeg": view_jpeg,
            "alphaPng": _b64(r["alpha_png"]),
            "alpha": {
                "algo": q0["algo_id"],
                "adler32": r["alpha_adler"],
                "payload": _b64(q0["_payload"]),
                "offsets": list(q0["_offsets"]),
                "block_bytes": q0["block_bytes"],
                "payload_bytes": q0["payload_bytes"],
                "raw_alpha_bytes": q0["raw_alpha_bytes"],
                "table_bytes": q0["table_bytes"],
                "rle_bytes": q0["rle_bytes"],
                "rle_nodes": q0["rle_nodes"],
            },
            "qualities": quals,
        })

    data = {
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "subsampling": records[0]["qualities"][0]["sampling"] if records else "?",
        "images": payload,
    }
    return "window.AJPEG_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n"


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def collect_sources(src: Path) -> list[Path]:
    if src.is_dir():
        return sorted(p for p in src.rglob("*")
                      if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    if src.is_file():
        return [src]
    raise SystemExit(f"找不到输入:{src}")


def parse_qualities(s: str) -> list[int]:
    out = []
    for part in s.replace(" ", "").split(","):
        if not part:
            continue
        q = int(part)
        if not 1 <= q <= 100:
            raise SystemExit(f"质量必须在 1..100:{q}")
        out.append(q)
    if not out:
        raise SystemExit("没有有效的质量参数")
    return out


def dump_encode_cases(path: Path) -> None:
    """导出 alpha 编码的回归用例,供 verify_ajpeg.cjs 校验 JS 编码器。

    覆盖两种 algo(RLE / RAW)、边界尺寸、以及 run 上限附近的情况。
    """
    import random
    rng = random.Random(11)

    def make(w: int, h: int, kind: str) -> bytes:
        if kind == "flat":
            return bytes([255]) * (w * h)
        if kind == "noise":
            return bytes(rng.randrange(256) for _ in range(w * h))
        if kind == "bands":
            return bytes((x // 7 * 37) % 256 for y in range(h) for x in range(w))
        if kind == "sparse":
            return bytes(0 if (x + y) % 13 else 255 for y in range(h) for x in range(w))
        if kind == "longrun":
            # 整片同值 —— 每行都会被 run 上限 255 切断,专门测多段长 run
            return bytes([7]) * (w * h)
        raise ValueError(kind)

    specs = [(64, 64, "flat"), (37, 23, "noise"), (100, 3, "bands"),
             (256, 64, "sparse"), (1, 1, "flat"), (300, 1, "bands"),
             (320, 4, "longrun")]

    cases = []
    for w, h, kind in specs:
        alpha = make(w, h, kind)
        block, info = build_alpha_block(alpha, w, h, "best")
        cases.append({
            "width": w, "height": h, "kind": kind, "mode": "best",
            "algo": info["algo_id"],
            "blockBytes": info["block_bytes"],
            "payloadBytes": info["payload_bytes"],
            "rleBytes": info["rle_bytes"],
            "rleNodes": info["rle_nodes"],
            "adler": zlib.adler32(alpha) & 0xFFFFFFFF,
            "alpha": list(alpha),
        })

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cases), encoding="utf-8")
    print(f"  enc_cases.json  {human(path.stat().st_size)}  {len(cases)} 组编码用例")


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(
        description="PNG -> JPEG(YUV420) + 尾部 RLE alpha,输出仍为 .jpg",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("-s", "--src", default=str(here / "samples"),
                    help="输入 PNG 文件或文件夹(默认 AJPEG/samples)")
    ap.add_argument("-o", "--out", default=None,
                    help="输出目录(默认:AJPEG/out;单文件模式为 AJPEG/out_single)")
    ap.add_argument("-q", "--quality", default="70,85,95",
                    help="JPEG 质量,可逗号分隔多档,默认 70,85,95")
    ap.add_argument("--subsampling", choices=list(SUBSAMPLING), default="420",
                    help="色度采样,默认 420")
    ap.add_argument("--rle-mode", choices=("best", "rle", "raw"), default="best",
                    help="alpha 编码方式:best 自动择优(默认)")
    ap.add_argument("--no-optimize", action="store_true",
                    help="关闭 JPEG Huffman 最优表(体积会大 2~5%%)")
    ap.add_argument("--make-samples", action="store_true",
                    help="先生成 samples/ 下的演示图")
    ap.add_argument("--no-html", action="store_true", help="不生成 data.js / metrics.json")
    ap.add_argument("--max-view", type=int, default=8,
                    help="查看器最多内联几张图,默认 8")
    ap.add_argument("--view-max", type=int, default=1400,
                    help="查看器里原图最长边上限,超过会等比缩小,默认 1400")
    args = ap.parse_args()

    if args.make_samples:
        print("生成演示样图:")
        make_samples(here / "samples")

    src = Path(args.src)
    sources = collect_sources(src)
    if not sources:
        raise SystemExit(f"{src} 下没有可用的图片")
    qualities = parse_qualities(args.quality)
    if args.out:
        out_dir = Path(args.out)
    else:
        out_dir = here / ("out" if src.is_dir() else "out_single")
    out_dir.mkdir(parents=True, exist_ok=True)

    # 清掉上一次留下的 .jpg,否则换质量档跑会残留旧文件
    for old in out_dir.rglob("*.jpg"):
        old.unlink()

    base = src if src.is_dir() else src.parent
    records = []
    for p in sources:
        rel = p.relative_to(base) if src.is_dir() else Path(p.name)
        records.append(process_image(p, out_dir, rel, qualities, args))

    print_table(records)

    if not args.no_html:
        metrics = to_json(records, args)
        (out_dir / "metrics.json").write_text(
            json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        js = build_data_js(records, out_dir, args.max_view, args.view_max)
        (out_dir / "data.js").write_text(js, encoding="utf-8")
        print(f"  metrics.json  {human((out_dir / 'metrics.json').stat().st_size)}")
        print(f"  data.js       {human((out_dir / 'data.js').stat().st_size)}")
        # 给 verify_ajpeg.cjs 用的编码回归用例(验证页面里的 JS 编码器)
        dump_encode_cases(out_dir / "enc_cases.json")
        print(f"\n产物在 {out_dir};查看器:双击 {here / 'ajpeg-compare.html'}")


if __name__ == "__main__":
    main()
