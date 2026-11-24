"""解码带宽模型（对应需求 2.2 / 2.4）。

输入是每个预测块的运动信息（来自 FFmpeg 的 MV 侧数据），按 2.4 的规则把
"参考帧读取"换算成每次拷多少字节，再加上码流读取 / 重建写回 / MV 读写。

所有尺寸按 4:2:0、每样点 1 字节（8bit）计算。
"""

# 每像素亮度 + 2 个色度分量的字节数
PIXEL_BYTES = 1.5

PART_NAMES = ("16x16", "16x8", "8x16", "8x8", "4x4")


class Options(object):
    def __init__(self):
        self.mv_bytes_per_mb = 32      # 每宏块 MV 读写字节数（可选项，0 = 不算）
        self.do_writeback = True       # 是否统计重建写回
        self.align = 16                # 重建写回按多少对齐


class Frame(object):
    """一帧的输入数据。"""
    __slots__ = ("index", "pict_type", "pkt_size", "key", "width", "height",
                 "blocks", "poc", "decode_index", "display_index", "ff_display")

    def __init__(self, index, pict_type, pkt_size, key, width, height):
        self.index = index
        self.pict_type = pict_type
        self.pkt_size = pkt_size
        self.key = key
        self.width = width
        self.height = height
        self.blocks = []
        self.poc = index
        self.decode_index = index
        self.display_index = index
        self.ff_display = index


def fetch_bytes(w, h, frac_x, frac_y):
    """一个预测方向、一个块的读取字节数（2.4 表）。"""
    lw = w + 5 if frac_x else w
    lh = h + 5 if frac_y else h
    if frac_x or frac_y:
        lw = w + 5 if frac_x else w
        lh = h + 5 if frac_y else h
    cw, ch = w >> 1, h >> 1
    cw = cw + 1 if frac_x else cw
    ch = ch + 1 if frac_y else ch
    return lw * lh * 1 + 2 * cw * ch


def ideal_bytes(w, h):
    return int(w * h * PIXEL_BYTES)


def analyze(frames, opt=None, fps=0.0):
    """返回 (per_frame, summary)。"""
    opt = opt or Options()
    per_frame = []
    for f in frames:
        per_frame.append(_analyze_frame(f, opt))

    summary = _summarize(per_frame)
    # 滑动窗口（1 秒），用来判断解码器缓冲能不能把峰值抹平
    if fps and fps > 1:
        w = int(round(fps))
        win = sliding_average(per_frame, w)
        summary["window"] = {
            "frames": w,
            "mean": sum(win) / float(len(win)) if win else 0.0,
            "max": max(win) if win else 0.0,
        }
        summary["window_series"] = win
    return per_frame, summary


def _analyze_frame(f, opt):
    W, H = f.width, f.height
    frame_pixels = W * H
    mb_cols = (W + 15) // 16

    # FFmpeg 对每个预测方向各输出一条记录，先按块位置合并
    groups = {}
    for (left, top, w, h, mvx, mvy, scale, dflag) in f.blocks:
        g = groups.get((left, top, w, h))
        if g is None:
            g = groups[(left, top, w, h)] = {}
        g[dflag] = (mvx, mvy, scale)

    ref_bytes = 0
    ideal = 0
    dir_pixels = 0
    area_total = 0
    area_uni = 0
    area_bi = 0
    part_area = dict((n, 0) for n in PART_NAMES)
    frac_area = {"int": 0, "h": 0, "v": 0, "both": 0}
    rows = {}
    mv_mag = 0
    mv_count = 0
    mv_disp = 0
    mv_disp_count = 0
    first_mv = {}          # 块左上角 -> 主方向 MV（像素），用于算离散度

    for (left, top, w, h), dirs in groups.items():
        block_area = w * h
        area_total += block_area
        n_dirs = len(dirs)
        if n_dirs == 2:
            area_bi += block_area
        else:
            area_uni += block_area
        name = "%dx%d" % (w, h)
        if name in part_area:
            part_area[name] += block_area
        ideal += ideal_bytes(w, h) * n_dirs
        dir_pixels += block_area * n_dirs

        block_bytes = 0
        for dflag in (1, 2):
            if dflag not in dirs:
                continue
            mvx, mvy, scale = dirs[dflag]
            sc = float(scale) if scale > 1 else 4.0
            fx = (mvx % int(sc)) != 0
            fy = (mvy % int(sc)) != 0
            key = "both" if (fx and fy) else ("h" if fx else ("v" if fy else "int"))
            frac_area[key] += block_area
            block_bytes += fetch_bytes(w, h, fx, fy)
            px, py = mvx / sc, mvy / sc
            mv_mag += abs(px) + abs(py)
            mv_count += 1
            if dflag not in first_mv and (left, top) not in first_mv:
                first_mv[(left, top)] = (px, py, w, h)
        ref_bytes += block_bytes
        row = top // 16
        rows[row] = rows.get(row, 0) + block_bytes

    # MV 离散度：与左邻块 / 上邻块的差
    for (left, top), (px, py, w, h) in first_mv.items():
        for nb in ((left - w, top), (left, top - h)):
            o = first_mv.get(nb)
            if o is not None:
                mv_disp += abs(px - o[0]) + abs(py - o[1])
                mv_disp_count += 1

    if area_total < frame_pixels:
        area_intra = frame_pixels - area_total
    else:
        area_intra = 0

    if opt.do_writeback:
        aw = ((W + opt.align - 1) // opt.align) * opt.align
        ah = ((H + opt.align - 1) // opt.align) * opt.align
        wb_bytes = int(aw * ah * PIXEL_BYTES)
    else:
        wb_bytes = 0

    nb_mb = mb_cols * ((H + 15) // 16)
    mv_bytes = nb_mb * opt.mv_bytes_per_mb
    total = f.pkt_size + wb_bytes + ref_bytes + mv_bytes

    denom = float(frame_pixels) or 1.0
    return {
        "index": f.index,
        "decode_index": f.decode_index,
        "display_index": f.display_index,
        "poc": f.poc,
        "type": f.pict_type,
        "key": f.key,
        "bytes": f.pkt_size,
        "ref_bytes": ref_bytes,
        "wb_bytes": wb_bytes,
        "mv_bytes": mv_bytes,
        "total": total,
        "n_dir": dir_pixels / denom,
        "k_interp": (ref_bytes / float(ideal)) if ideal else 0.0,
        "row_peak": max(rows.values()) if rows else 0,
        "blocks": len(groups),
        "area_intra": area_intra / denom,
        "area_uni": area_uni / denom,
        "area_bi": area_bi / denom,
        "partitions": dict((k, v / denom) for k, v in part_area.items()),
        # 分数 MV 按"每个方向的读取"归一化，双向帧合计 ≈ 100%
        "frac": dict((k, (v / float(dir_pixels)) if dir_pixels else 0.0)
                     for k, v in frac_area.items()),
        "mv_mag": (mv_mag / mv_count) if mv_count else 0.0,
        "mv_disp": (mv_disp / mv_disp_count) if mv_disp_count else 0.0,
    }


def _pct(values, q):
    if not values:
        return 0
    s = sorted(values)
    k = int(round((len(s) - 1) * q))
    return s[k]


def _summarize(per_frame):
    if not per_frame:
        return {}
    totals = [f["total"] for f in per_frame]
    refs = [f["ref_bytes"] for f in per_frame]
    by_type = {}
    for f in per_frame:
        by_type.setdefault(f["type"], []).append(f)

    def stat(vals):
        if not vals:
            return {}
        return {
            "mean": sum(vals) / float(len(vals)),
            "p95": _pct(vals, 0.95),
            "p99": _pct(vals, 0.99),
            "max": max(vals),
            "min": min(vals),
        }

    return {
        "frames": len(per_frame),
        "total": stat(totals),
        "ref": stat(refs),
        "by_type": dict((k, stat([f["total"] for f in v])) for k, v in by_type.items()),
        "by_type_ref": dict((k, stat([f["ref_bytes"] for f in v])) for k, v in by_type.items()),
        "row_peak_max": max(f["row_peak"] for f in per_frame),
    }


def sliding_average(per_frame, window):
    """滑动窗口平均（按帧数），返回每帧位置上的窗口均值。"""
    out = []
    n = len(per_frame)
    acc = 0
    for i, f in enumerate(per_frame):
        acc += f["total"]
        if i >= window:
            acc -= per_frame[i - window]["total"]
        out.append(acc / float(min(i + 1, window)))
    return out


# ITU-T H.264 表 A-2：各 level 的 MaxBR（kbit/s，Baseline/Main/Extended 以及 High 档）
LEVEL_MAXBR = {
    10: (64, 80), 11: (192, 240), 12: (384, 480), 13: (768, 960),
    20: (2000, 2500), 21: (4000, 5000), 22: (4000, 5000), 30: (10000, 12500),
    31: (14000, 17500), 32: (20000, 25000), 40: (20000, 25000),
    41: (50000, 62500), 42: (50000, 62500), 50: (135000, 168750),
    51: (240000, 300000), 52: (240000, 300000), 60: (240000, 300000),
    61: (480000, 600000), 62: (800000, 1000000),
}


def level_maxbr_bytes(level_idc, high_profile, fps):
    """按 Level 估算的每帧码流上限（字节）。"""
    entry = LEVEL_MAXBR.get(level_idc)
    if not entry or not fps:
        return 0
    kbit = entry[1] if high_profile else entry[0]
    return kbit * 1000.0 / 8.0 / fps
