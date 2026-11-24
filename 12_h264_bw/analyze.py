#!/usr/bin/env python
"""H.264 解码带宽分析：720p / 1080p，平均带宽 + 峰值带宽 + 归因。

用法：
    python analyze.py <视频> [--max-frames N] [--html out.html] [--json out.json]
                      [--mv-bytes-mb 32] [--no-writeback]

数据来源：
  * 每帧码流包大小、逐块运动矢量 —— mvtool/mvdump（FFmpeg 的 MV 侧数据）
  * Profile / Level / 参考帧数 / POC（显示顺序）—— h264bw 自己的码流头解析器
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from h264bw import bandwidth                       # noqa: E402
from h264bw.decoder import Decoder                 # noqa: E402
from h264bw.report import build_html               # noqa: E402

MVDIR = os.path.join(HERE, "mvtool")
MVBIN = os.path.join(MVDIR, "mvdump.exe")
FF_DIR = os.path.join(MVDIR, "ff")


def ensure_mvdump():
    if os.path.exists(MVBIN):
        return MVBIN
    src = os.path.join(MVDIR, "mvdump.c")
    inc = os.path.join(FF_DIR, "include")
    lib = os.path.join(FF_DIR, "lib")
    if not (os.path.exists(src) and os.path.isdir(inc)):
        raise SystemExit(
            "缺少 mvdump.exe。请先运行 mvtool\\build.bat，"
            "或手动编译 mvdump.c（需要 FFmpeg shared 版的 include/lib）。")
    cmd = ["gcc", "-O2", "-o", MVBIN, src, "-I", inc, "-L", lib,
           "-lavformat", "-lavcodec", "-lavutil"]
    print("编译 mvdump ...")
    subprocess.check_call(cmd)
    return MVBIN


def run_mvdump(path, max_frames=None):
    cmd = [ensure_mvdump(), path]
    if max_frames:
        cmd.append(str(max_frames))
    env = dict(os.environ)
    dlls = os.path.join(FF_DIR, "bin")
    if os.path.isdir(dlls):
        env["PATH"] = dlls + os.pathsep + env.get("PATH", "")
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if proc.returncode != 0:
        raise SystemExit("mvdump 失败：%s" % proc.stderr.decode("utf-8", "replace")[:400])
    frames = []
    cur = None
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split(",")
        if parts[0] == "F":
            _, idx, ptype, size, key, w, h, disp = parts[:8]
            cur = bandwidth.Frame(int(idx), ptype, int(size), int(key), int(w), int(h))
            cur.ff_display = int(disp)          # FFmpeg 自己的输出顺序，用来交叉验证
            frames.append(cur)
        elif parts[0] == "M" and cur is not None:
            _, idx, cx, cy, w, h, mx, my, scale, source, sx, sy = parts[:12]
            # dst 是块中心 → 换成左上角；source: -1 = list0，+1 = list1
            bw, bh = int(w), int(h)
            left, top = int(cx) - bw // 2, int(cy) - bh // 2
            dflag = 1 if int(source) < 0 else 2
            cur.blocks.append((left, top, bw, bh, int(mx), int(my), int(scale), dflag))
    frames.sort(key=lambda f: f.index)      # 恢复解码顺序
    return frames


START_CODE = bytes((0, 0, 1))   # Annex-B 起始码 00 00 01


def to_annexb(path):
    """非裸码流（mp4/flv/mkv…）先用 ffmpeg 转成 Annex-B 再解析。"""
    with open(path, "rb") as fh:
        head = fh.read(4096)
    if START_CODE in head:
        with open(path, "rb") as fh:
            return fh.read()
    print("非 Annex-B 码流，用 ffmpeg 转一份裸流用于解析头 ...")
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-c", "copy",
         "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise SystemExit("转裸流失败：%s" % proc.stderr.decode("utf-8", "replace")[:300])
    return proc.stdout


def parse_headers(path):
    data = to_annexb(path)
    dec = Decoder()
    dec.decode(data, header_only=True)
    return dec


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[1]
    opts = bandwidth.Options()
    out_html = None
    out_json = None
    max_frames = None
    i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--max-frames":
            max_frames = int(argv[i + 1]); i += 2
        elif a == "--html":
            out_html = argv[i + 1]; i += 2
        elif a == "--json":
            out_json = argv[i + 1]; i += 2
        elif a == "--mv-bytes-mb":
            opts.mv_bytes_per_mb = int(argv[i + 1]); i += 2
        elif a == "--no-writeback":
            opts.do_writeback = False; i += 1
        else:
            print("未知参数 %s" % a)
            return 2

    if not os.path.exists(path):
        raise SystemExit("找不到文件：%s" % path)

    frames = run_mvdump(path, max_frames)
    if not frames:
        raise SystemExit("没有解出任何帧")

    dec = parse_headers(path)
    sps = list(dec.sps_map.values())[0] if dec.sps_map else None
    pps = list(dec.pps_map.values())[0] if dec.pps_map else None
    pics = [p for p in _collect_pictures(dec)]

    # 显示顺序：POC 排序，但每个 IDR 会重置 POC，所以要先按 IDR 划"纪元"
    epoch = 0
    keys = []
    for k, p in enumerate(pics):
        if p.idr and k > 0:
            epoch += 1
        keys.append((epoch, p.poc, k))
    for disp, (_, _, k) in enumerate(sorted(keys)):
        pics[k].display_index = disp

    n = min(len(frames), len(pics))
    if len(frames) != len(pics):
        print("⚠ 帧数不一致：mvdump %d 帧 / 头解析 %d 帧，按前 %d 帧对齐"
              % (len(frames), len(pics), n))
    for k in range(n):
        frames[k].poc = pics[k].poc
        frames[k].display_index = pics[k].display_index

    fps = sps.fps if sps else 0.0
    per_frame, summary = bandwidth.analyze(frames[:n], opts, fps)
    meta = {
        "file": os.path.basename(path),
        "width": frames[0].width,
        "height": frames[0].height,
        "profile": sps.profile_name() if sps else "?",
        "profile_idc": sps.profile_idc if sps else 0,
        "level": sps.level_idc if sps else 0,
        "max_num_ref_frames": sps.max_num_ref_frames if sps else 0,
        "entropy_coding": ("CABAC" if pps.entropy_coding_mode else "CAVLC") if pps else "?",
        "transform_8x8": bool(pps.transform_8x8_mode) if pps else False,
        "fps": fps,
        "frames": n,
        "mv_bytes_per_mb": opts.mv_bytes_per_mb,
        "writeback": opts.do_writeback,
        "warnings": dec.warnings[:10],
    }
    if sps and fps:
        meta["level_ceiling"] = bandwidth.level_maxbr_bytes(
            sps.level_idc, sps.profile_idc in (100, 110, 122, 244), fps)

    result = {"meta": meta, "fps": per_frame, "summary": summary}

    for path in (out_json, out_html):
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=1)
        print("已写出 %s" % out_json)

    if out_html:
        with open(out_html, "w", encoding="utf-8") as fh:
            fh.write(build_html(result))
        print("已写出 %s" % out_html)

    _print_console(result)
    return 0


def _collect_pictures(dec):
    """Decoder 没有保存每帧对象，这里重放一遍拿 Picture 列表。"""
    return getattr(dec, "pictures", [])


def _print_console(result):
    meta = result["meta"]
    s = result["summary"]
    print("")
    print("%s  %dx%d  %s@L%d  %s  %s  %d 帧  参考帧上限 %d"
          % (meta["file"], meta["width"], meta["height"], meta["profile"],
             meta["level"], meta["entropy_coding"],
             "8x8变换" if meta["transform_8x8"] else "4x4变换",
             meta["frames"], meta["max_num_ref_frames"]))
    print("-" * 78)
    print("%-10s %10s %10s %10s %10s" % ("", "平均", "P95", "P99", "最大"))
    for label, key in (("总带宽", "total"), ("参考读取", "ref")):
        st = s[key]
        print("%-10s %10.0f %10.0f %10.0f %10.0f  (字节/帧)"
              % (label, st["mean"], st["p95"], st["p99"], st["max"]))
    for t in ("I", "P", "B"):
        if t in s["by_type"]:
            st = s["by_type"][t]
            print("  %s 帧总带宽  平均 %8.0f   最大 %8.0f" % (t, st["mean"], st["max"]))
    print("-" * 78)
    print("MB 行级峰值参考读取：%d 字节" % s["row_peak_max"])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
