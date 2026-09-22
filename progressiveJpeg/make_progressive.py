#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PNG -> Progressive JPEG,逐扫描解码,并与高斯模糊做对比。

做四件事:
  1. 把 PNG 编码成 progressive JPEG(libjpeg 默认 10 段扫描脚本),并解析出
     每一段 SOS 的参数与字节边界。
  2. 对每个前缀(第 1..N 段扫描)截断 + 补 EOI,得到「只收到前 N 段」的合法
     JPEG,逐个解码成 PNG —— 其中第 1 段就是首扫(DC-only)。
  3. 对原图做不同 sigma 的高斯模糊,用 PSNR / SSIM 反解出「和首扫效果最接近」
     的 sigma,以及「和首扫失真程度相同」的 sigma。
  4. 输出:out/ 下的全部中间图、metrics.json、拼版对比图 comparison.png,
     以及给 HTML 查看器用的内联数据 out/data.js。

首扫会用两种方式解码:
  - libjpeg(PIL):开启 block smoothing,即浏览器渲染渐进图时真正看到的样子
  - ffmpeg(可选):不做平滑,能看到 DC 系数原本的 8x8 色块

用法:
    python make_progressive.py                       # 用 user-wallpaper.png
    python make_progressive.py --src other.png -q 90
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter

try:
    from skimage.metrics import structural_similarity as _sk_ssim
except ImportError:  # pragma: no cover
    _sk_ssim = None


# --------------------------------------------------------------------------- #
# JPEG 码流解析
# --------------------------------------------------------------------------- #

MARKER_NAMES = {
    0xC0: "SOF0", 0xC1: "SOF1", 0xC2: "SOF2", 0xC4: "DHT",
    0xDB: "DQT", 0xDD: "DRI", 0xDA: "SOS", 0xD8: "SOI", 0xD9: "EOI",
    0xE0: "APP0", 0xE1: "APP1", 0xE2: "APP2", 0xEE: "APP14", 0xFE: "COM",
}
# 无长度字段的 marker
STANDALONE = {0xD8, 0x01} | set(range(0xD0, 0xD8))


def _next_marker(data: bytes, start: int) -> int:
    """从 start 开始跳过熵编码数据,返回下一个真 marker 的位置(0xFF 的下标)。

    需要跳过字节填充 FF00 和重启标记 FFD0..FFD7。
    """
    j, n = start, len(data)
    while j < n - 1:
        if data[j] == 0xFF:
            nxt = data[j + 1]
            if nxt != 0x00 and nxt != 0xFF and not (0xD0 <= nxt <= 0xD7):
                return j
        j += 1
    return n


def parse_jpeg(data: bytes) -> dict:
    """扫一遍码流,取出帧头信息和每段 SOS 的参数 + 该段结束的字节偏移。"""
    frame: dict = {}
    scans: list[dict] = []
    i, n = 0, len(data)

    while i < n - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m in STANDALONE:
            i += 2
            continue
        if m == 0xD9:  # EOI
            break

        length = int.from_bytes(data[i + 2:i + 4], "big")
        seg = data[i + 4:i + 2 + length]

        if m in (0xC0, 0xC1, 0xC2):
            ncomp = seg[5]
            frame = {
                "marker": MARKER_NAMES[m],
                "progressive": m == 0xC2,
                "height": int.from_bytes(seg[1:3], "big"),
                "width": int.from_bytes(seg[3:5], "big"),
                "components": [
                    {"id": seg[6 + 3 * k],
                     "h": seg[7 + 3 * k] >> 4,
                     "v": seg[7 + 3 * k] & 0x0F}
                    for k in range(ncomp)
                ],
            }
            i += 2 + length
            continue

        if m == 0xDA:
            ns = seg[0]
            comp_ids = [seg[1 + 2 * k] for k in range(ns)]
            ss, se = seg[1 + 2 * ns], seg[2 + 2 * ns]
            ah_al = seg[3 + 2 * ns]
            end = _next_marker(data, i + 2 + length)
            scans.append({
                "index": len(scans) + 1,
                "sos_offset": i,
                "end_offset": end,          # 截断点:该段熵数据结束处
                "components": comp_ids,
                "Ss": ss, "Se": se,
                "Ah": ah_al >> 4, "Al": ah_al & 0x0F,
            })
            i = end
            continue

        i += 2 + length

    return {"frame": frame, "scans": scans, "size": n}


def describe_scan(sc: dict) -> str:
    """把 SOS 参数翻译成一句人话。"""
    comp_name = {1: "Y", 2: "Cb", 3: "Cr"}
    comps = "+".join(comp_name.get(c, f"C{c}") for c in sc["components"])
    if sc["Ss"] == 0:
        band = "DC"
    elif sc["Se"] == 63:
        band = f"AC {sc['Ss']}-63"
    else:
        band = f"AC {sc['Ss']}-{sc['Se']}"
    if sc["Ah"] == 0:
        refine = f"首次传输,低 {sc['Al']} bit 未发" if sc["Al"] else "首次传输,全精度"
    else:
        refine = f"精化 bit {sc['Al']}"
    return f"{comps} / {band} / {refine}"


def truncate_after_scan(data: bytes, parsed: dict, k: int) -> bytes:
    """保留前 k 段扫描,补上 EOI,得到一个合法(但信息不全)的 JPEG。"""
    return data[:parsed["scans"][k - 1]["end_offset"]] + b"\xff\xd9"


# --------------------------------------------------------------------------- #
# 解码 / 指标
# --------------------------------------------------------------------------- #

def decode_pil(raw: bytes) -> Image.Image:
    """libjpeg 解码。渐进图信息不全时会自动做 block smoothing,和浏览器一致。"""
    return Image.open(io.BytesIO(raw)).convert("RGB")


def decode_ffmpeg(raw: bytes) -> Image.Image | None:
    """ffmpeg 解码。不做 DC 平滑,能直接看到 8x8 色块。ffmpeg 不在则返回 None。"""
    exe = shutil.which("ffmpeg")
    if not exe:
        return None
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.jpg", Path(td) / "out.png"
        src.write_bytes(raw)
        r = subprocess.run([exe, "-v", "error", "-i", str(src), "-y", str(dst)],
                           capture_output=True)
        if r.returncode != 0 or not dst.exists():
            return None
        return Image.open(dst).convert("RGB").copy()


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return float("inf") if mse == 0 else float(10 * np.log10(255.0 ** 2 / mse))


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """标准 SSIM(Wang et al.):11x11 高斯窗 sigma=1.5,总体协方差,逐通道平均。

    参数固定成这一组,是为了让 HTML 里的 JS 实现能算出同样的数。
    """
    if _sk_ssim is None:
        return float("nan")
    return float(_sk_ssim(a, b, channel_axis=2, data_range=255,
                          gaussian_weights=True, sigma=1.5,
                          use_sample_covariance=False))


def gauss_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    """在 sRGB 空间做真高斯模糊(和 Photoshop / CSS blur 同一空间)。

    sigma=0 直接返回原图;边缘用 nearest 夹取,JS 侧同样处理。
    """
    if sigma <= 0:
        return arr.copy()
    out = gaussian_filter(arr.astype(np.float32), sigma=(sigma, sigma, 0),
                          mode="nearest", truncate=4.0)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- #
# 拼版对比图
# --------------------------------------------------------------------------- #

def _font(px: int) -> ImageFont.ImageFont:
    """找一个能画中文的字体。CJK 字体必须排在 Segoe UI / DejaVu 之前,否则中文成豆腐块。"""
    cands = [
        Path("C:/Windows/Fonts/msyh.ttc"),        # 微软雅黑
        Path("C:/Windows/Fonts/simhei.ttf"),      # 黑体
        Path("C:/Windows/Fonts/Deng.ttf"),        # 等线
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("C:/Windows/Fonts/segoeui.ttf"),     # 兜底:无 CJK
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for p in cands:
        if p.exists():
            try:
                return ImageFont.truetype(str(p), px)
            except OSError:
                pass
    return ImageFont.load_default()


def contact_sheet(tiles: list[tuple[str, str, Image.Image]], cols: int,
                  pad: int = 16, cap_h: int = 46) -> Image.Image:
    """把 (标题, 副标题, 图) 拼成一张带说明的网格图。"""
    tw, th = tiles[0][2].size
    rows = (len(tiles) + cols - 1) // cols
    W = pad + cols * (tw + pad)
    H = pad + rows * (th + cap_h + pad)
    sheet = Image.new("RGB", (W, H), (24, 25, 30))
    d = ImageDraw.Draw(sheet)
    f_title, f_sub = _font(17), _font(13)

    for i, (title, sub, img) in enumerate(tiles):
        r, c = divmod(i, cols)
        x = pad + c * (tw + pad)
        y = pad + r * (th + cap_h + pad)
        sheet.paste(img.resize((tw, th), Image.LANCZOS) if img.size != (tw, th) else img,
                    (x, y))
        d.rectangle([x, y, x + tw - 1, y + th - 1], outline=(70, 72, 82))
        d.text((x, y + th + 7), title, font=f_title, fill=(238, 240, 246))
        d.text((x, y + th + 27), sub, font=f_sub, fill=(150, 154, 168))
    return sheet


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

PRESET_SIGMAS = [1.0, 2.0, 3.0, 3.4, 4.0, 4.25, 5.0, 6.0]


def main() -> int:
    ap = argparse.ArgumentParser(description="PNG -> progressive JPEG 首扫 vs 高斯模糊对比")
    ap.add_argument("--src", default="user-wallpaper.png", help="源 PNG")
    ap.add_argument("--out", default="out", help="输出目录")
    ap.add_argument("-q", "--quality", type=int, default=85, help="JPEG 质量 (默认 85)")
    ap.add_argument("--no-data-js", action="store_true", help="不生成 HTML 用的 data.js")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    src = (here / args.src) if not Path(args.src).is_absolute() else Path(args.src)
    outdir = (here / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        print(f"找不到源图: {src}", file=sys.stderr)
        return 1

    # ---- 1. 读源图 ------------------------------------------------------- #
    src_im = Image.open(src)
    src_mode, src_size = src_im.mode, src_im.size
    alpha_note = ""
    if src_mode in ("RGBA", "LA", "P"):
        rgba = src_im.convert("RGBA")
        amin = int(np.array(rgba)[..., 3].min())
        alpha_note = ("alpha 全不透明,丢弃无损" if amin == 255
                      else f"alpha 最小 {amin},JPEG 不支持透明,已按不透明压平")
    orig = src_im.convert("RGB")
    orig_a = np.array(orig)
    W, H = orig.size
    print(f"源图 {src.name}  {W}x{H}  mode={src_mode}" + (f"  ({alpha_note})" if alpha_note else ""))

    # ---- 2. 编码 progressive + baseline --------------------------------- #
    enc = dict(quality=args.quality, optimize=True, subsampling="4:2:0")
    bp, bb = io.BytesIO(), io.BytesIO()
    orig.save(bp, "JPEG", progressive=True, **enc)
    orig.save(bb, "JPEG", progressive=False, **enc)
    prog, base = bp.getvalue(), bb.getvalue()

    (outdir / "progressive.jpg").write_bytes(prog)
    (outdir / "baseline.jpg").write_bytes(base)
    png_bytes = src.stat().st_size
    print(f"progressive.jpg {len(prog):,} B   baseline.jpg {len(base):,} B   "
          f"源 PNG {png_bytes:,} B")

    parsed = parse_jpeg(prog)
    fr = parsed["frame"]
    assert fr.get("progressive"), "编码结果不是 progressive JPEG"
    samp = " ".join(f"{c['id']}:{c['h']}x{c['v']}" for c in fr["components"])
    print(f"SOF2 {fr['width']}x{fr['height']}  采样 {samp}  共 {len(parsed['scans'])} 段扫描\n")

    # ---- 3. 逐段截断解码 ------------------------------------------------ #
    print(f"{'#':>2}  {'累计字节':>9} {'占比':>6}  {'扫描内容':<34} {'PSNR':>7} {'SSIM':>7}")
    print("-" * 78)
    scan_rows = []
    for sc in parsed["scans"]:
        k = sc["index"]
        raw = truncate_after_scan(prog, parsed, k)
        img = decode_pil(raw)
        arr = np.array(img)
        p, s = psnr(orig_a, arr), ssim(orig_a, arr)
        img.save(outdir / f"scan{k:02d}.png")
        (outdir / f"scan{k:02d}.jpg").write_bytes(raw)

        desc = describe_scan(sc)
        ratio = len(raw) / len(prog)
        scan_rows.append({
            "index": k, "bytes": len(raw), "ratio": ratio,
            "desc": desc, "psnr": p, "ssim": s,
            "Ss": sc["Ss"], "Se": sc["Se"], "Ah": sc["Ah"], "Al": sc["Al"],
            "components": sc["components"], "end_offset": sc["end_offset"],
        })
        print(f"{k:>2}  {len(raw):>9,} {ratio*100:>5.1f}%  {desc:<34} {p:>6.2f}dB {s:>7.4f}")

    first = scan_rows[0]
    first_arr = np.array(Image.open(outdir / f"scan01.png").convert("RGB"))

    # 不做 DC 平滑的首扫(纯 8x8 色块),用 ffmpeg
    raw1 = truncate_after_scan(prog, parsed, 1)
    ff = decode_ffmpeg(raw1)
    blocks_stats = None
    if ff is not None:
        ff.save(outdir / "scan01_blocks.png")
        y = np.array(ff.convert("YCbCr"))[..., 0].astype(np.float64)
        bh, bw = (H // 8) * 8, (W // 8) * 8
        std_in_block = float(y[:bh, :bw].reshape(bh // 8, 8, bw // 8, 8).std(axis=(1, 3)).mean())
        blocks_stats = {"psnr": psnr(orig_a, np.array(ff)),
                        "ssim": ssim(orig_a, np.array(ff)),
                        "luma_std_in_8x8": std_in_block}
        print(f"\nscan01_blocks.png (ffmpeg,无 DC 平滑): "
              f"{blocks_stats['psnr']:.2f}dB SSIM {blocks_stats['ssim']:.4f}  "
              f"块内 luma 标准差 {std_in_block:.3f}(≈0 即纯色块)")
    else:
        print("\n未找到 ffmpeg,跳过「无平滑 8x8 色块」版本")

    # ---- 4. 高斯 sigma 反解 --------------------------------------------- #
    print("\n扫描 sigma,寻找与首扫等效的高斯模糊 ...")
    sweep = []
    for sg in np.arange(0.2, 8.01, 0.1):
        b = gauss_blur(orig_a, float(sg))
        sweep.append({
            "sigma": round(float(sg), 2),
            "psnr_vs_orig": psnr(orig_a, b),
            "ssim_vs_orig": ssim(orig_a, b),
            "psnr_vs_scan1": psnr(first_arr, b),
            "ssim_vs_scan1": ssim(first_arr, b),
        })

    best_psnr = max(sweep, key=lambda r: r["psnr_vs_scan1"])
    best_ssim = max(sweep, key=lambda r: r["ssim_vs_scan1"])
    iso = min(sweep, key=lambda r: abs(r["psnr_vs_orig"] - first["psnr"]))

    print(f"  最像首扫 (PSNR 最高)      : sigma = {best_psnr['sigma']:.1f}  "
          f"PSNR(blur,scan1) = {best_psnr['psnr_vs_scan1']:.2f}dB")
    print(f"  最像首扫 (SSIM 最高)      : sigma = {best_ssim['sigma']:.1f}  "
          f"SSIM(blur,scan1) = {best_ssim['ssim_vs_scan1']:.4f}")
    print(f"  等失真 (PSNR vs 原图相同) : sigma = {iso['sigma']:.2f}  "
          f"{iso['psnr_vs_orig']:.2f}dB vs 首扫 {first['psnr']:.2f}dB")

    # 理论值:DC-only ≈ 8x8 均值 = 盒式滤波,等效 sigma = w/sqrt(12)
    theory = {"luma_box8": 8 / np.sqrt(12), "chroma_box16": 16 / np.sqrt(12)}
    print(f"  理论参考: 8x8 盒式 ≈ sigma {theory['luma_box8']:.2f}(亮度),"
          f"16x16 ≈ sigma {theory['chroma_box16']:.2f}(色度,4:2:0)")

    sigmas = sorted(set(PRESET_SIGMAS + [best_psnr["sigma"], best_ssim["sigma"], iso["sigma"]]))
    blur_rows = []
    for sg in sigmas:
        b = gauss_blur(orig_a, sg)
        name = f"blur_s{sg:g}".replace(".", "p") + ".png"
        Image.fromarray(b).save(outdir / name)
        blur_rows.append({
            "sigma": sg, "file": name,
            "psnr_vs_orig": psnr(orig_a, b), "ssim_vs_orig": ssim(orig_a, b),
            "psnr_vs_scan1": psnr(first_arr, b), "ssim_vs_scan1": ssim(first_arr, b),
        })

    # ---- 5. 拼版对比图 --------------------------------------------------- #
    m_sig = best_psnr["sigma"]
    m_blur = Image.fromarray(gauss_blur(orig_a, m_sig))
    i_blur = Image.fromarray(gauss_blur(orig_a, iso["sigma"]))

    tiles = [
        ("原图", f"{W}x{H} PNG  {png_bytes/1024:.0f} KB", orig),
        ("首扫 · 浏览器所见",
         f"前 {first['bytes']/1024:.1f} KB ({first['ratio']*100:.1f}% 字节)  "
         f"{first['psnr']:.2f}dB / SSIM {first['ssim']:.3f}",
         Image.open(outdir / "scan01.png")),
        (f"高斯模糊 sigma={m_sig:g} · 最像首扫",
         f"{[r for r in blur_rows if r['sigma']==m_sig][0]['psnr_vs_orig']:.2f}dB vs 原图  "
         f"| 与首扫 {best_psnr['psnr_vs_scan1']:.2f}dB",
         m_blur),
        ("首扫 · 无 DC 平滑" if ff else "完整 JPEG",
         "DC 系数原样 = 8x8 色块" if ff else f"全 10 段  {len(prog)/1024:.1f} KB",
         (Image.open(outdir / "scan01_blocks.png") if ff else decode_pil(prog))),
        (f"高斯模糊 sigma={iso['sigma']:g} · 等失真",
         f"{iso['psnr_vs_orig']:.2f}dB,与首扫 PSNR 持平",
         i_blur),
        ("完整 JPEG · 10 段全收",
         f"{len(prog)/1024:.1f} KB  {scan_rows[-1]['psnr']:.2f}dB / SSIM {scan_rows[-1]['ssim']:.3f}",
         decode_pil(prog)),
    ]
    contact_sheet(tiles, cols=3).save(outdir / "comparison.png")

    stage_tiles = [
        (f"第 {r['index']} 段",
         f"{r['bytes']/1024:.1f} KB ({r['ratio']*100:.0f}%)  {r['psnr']:.1f}dB",
         Image.open(outdir / f"scan{r['index']:02d}.png"))
        for r in scan_rows
    ]
    contact_sheet(stage_tiles, cols=5).save(outdir / "scan_stages.png")

    blur_tiles = [
        (f"sigma = {r['sigma']:g}",
         f"{r['psnr_vs_orig']:.1f}dB vs 原图  |  {r['psnr_vs_scan1']:.1f}dB vs 首扫",
         Image.open(outdir / r["file"]))
        for r in blur_rows
    ]
    contact_sheet(blur_tiles, cols=5).save(outdir / "blur_stages.png")
    print(f"\n拼版图: comparison.png / scan_stages.png / blur_stages.png")

    # ---- 6. metrics.json ------------------------------------------------- #
    metrics = {
        "source": {"file": src.name, "width": W, "height": H,
                   "mode": src_mode, "bytes": png_bytes, "alpha": alpha_note},
        "encode": {"quality": args.quality, "subsampling": "4:2:0",
                   "progressive_bytes": len(prog), "baseline_bytes": len(base),
                   "sampling": samp, "scan_count": len(scan_rows)},
        "scans": scan_rows,
        "first_scan_no_smoothing": blocks_stats,
        "blurs": blur_rows,
        "equivalent_sigma": {
            "best_match_psnr": best_psnr, "best_match_ssim": best_ssim,
            "iso_distortion": iso,
            "theory_box_filter": {k: round(v, 3) for k, v in theory.items()},
        },
        "notes": [
            "SSIM = Wang et al. 标准式,11x11 高斯窗 sigma=1.5,逐通道平均,裁边 5px",
            "高斯模糊在 sRGB 空间做,边缘 nearest 夹取,截断半径 4 sigma",
            "scanNN.png 由 libjpeg 解码(带 DC block smoothing),即浏览器所见",
        ],
    }
    (outdir / "metrics.json").write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- 7. data.js(给 HTML,file:// 直接可用)-------------------------- #
    if not args.no_data_js:
        b64_png = base64.b64encode(src.read_bytes()).decode()
        b64_jpg = base64.b64encode(prog).decode()
        # 无平滑首扫由 ffmpeg 解出,直接内联给 HTML 用。
        # 浏览器自己没法关掉 DC 平滑,在 JS 里对已平滑的结果再求块均值只是近似
        # (实测差 0.3 dB),所以宁可把准确的那张图带过去。
        blocks_png = outdir / "scan01_blocks.png"
        b64_blocks = (base64.b64encode(blocks_png.read_bytes()).decode()
                      if blocks_png.exists() else None)
        payload = {
            "meta": metrics,
            "origMime": Image.open(src).get_format_mimetype(),
            "scanOffsets": [r["end_offset"] for r in scan_rows],
            "scanInfo": [{k: r[k] for k in
                          ("index", "bytes", "ratio", "desc", "psnr", "ssim")}
                         for r in scan_rows],
            "hasBlocks": b64_blocks is not None,
        }
        js = (
            "// 由 make_progressive.py 生成,请勿手改。\n"
            "// 图片内联成 base64,好处是 file:// 打开 HTML 时 canvas 不会被跨源污染。\n"
            f"window.PJ_DATA = {json.dumps(payload, ensure_ascii=False)};\n"
            f'window.PJ_DATA.origBase64 = "{b64_png}";\n'
            f'window.PJ_DATA.progBase64 = "{b64_jpg}";\n'
            + (f'window.PJ_DATA.blocksBase64 = "{b64_blocks}";\n' if b64_blocks else "")
        )
        (outdir / "data.js").write_text(js, encoding="utf-8")
        print(f"data.js {len(js)/1024:.0f} KB  ->  打开 progressive-jpeg-compare.html")

    return 0


if __name__ == "__main__":
    sys.exit(main())
