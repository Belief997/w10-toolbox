"""一次性脚本：把 ITU-T H.264 标准里的 CABAC 常数表（表 9-12 ~ 9-45）抽取成
h264bw/cabac_tables.py。

表里的数值本身就是标准文档的常数，这里只是为了不手抄 1024×2×4 个数字，
从一份公开实现（FFmpeg h264_cabac.c / cabac.c）里把它们机械地抄出来。

用法（仓库里不需要跑，产物 cabac_tables.py 已提交）：
    python gen_tables.py <ffmpeg_src_dir>
    # ffmpeg_src_dir 下需要有 h264_cabac.c 和 cabac.c
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _ints(text):
    """把 '105+15, 402, -3' 这类 C 表达式求值成整数序列（只支持加减）。"""
    out = []
    for m in re.finditer(r"[-+]?\s*\d+(?:\s*[-+]\s*\d+)*", text):
        tok = m.group(0)
        total = 0
        for sign, num in re.findall(r"([-+])?\s*(\d+)", tok):
            total += -int(num) if sign == "-" else int(num)
        out.append(total)
    return out


def _extract_block(src, name):
    """取出 C 数组 name[...] = { ... }; 的花括号内容"""
    i = src.index(name)
    i = src.index("{", i)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1:j]
    raise ValueError("unbalanced: " + name)


def main(src_dir):
    src_dir = Path(src_dir)
    cabac_c = (src_dir / "h264_cabac.c").read_text(encoding="utf-8", errors="replace")
    cabac = (src_dir / "cabac.c").read_text(encoding="utf-8", errors="replace")

    # --- 表 9-12 / 9-13：上下文初始值 m,n ---
    # 先过滤掉 C 注释，避免注释里的数字混进来
    def strip_comments(t):
        t = re.sub(r"/\*.*?\*/", " ", t, flags=re.S)
        return re.sub(r"//[^\n]*", " ", t)

    init_i = _ints(strip_comments(_extract_block(cabac_c, "cabac_context_init_I[1024][2]")))
    init_pb = _ints(strip_comments(_extract_block(cabac_c, "cabac_context_init_PB[3][1024][2]")))
    assert len(init_i) == 2048 and len(init_pb) == 6144

    # --- 表 9-44 / 9-45：rangeTabLPS + 状态转移，都打包在 ff_h264_cabac_tables 里 ---
    tbl = _ints(strip_comments(_extract_block(cabac, "ff_h264_cabac_tables")))
    # 布局: [0:512) 归一化移位表, [512:1024) LPS range (4×128), [1024:1280) mlps 转移
    #       [1280:1343) last_coeff_flag_offset_8x8
    assert len(tbl) == 512 + 4 * 2 * 64 + 4 * 64 + 63, len(tbl)
    lps_range = [v & 0xFF for v in tbl[512:1024]]
    mlps = tbl[1024:1280]

    # mlps[128 + s] = MPS 分支后的新状态；mlps[127 - s] = LPS 分支后的新状态
    mps_trans = [mlps[128 + s] for s in range(128)]
    lps_trans = [mlps[127 - s] for s in range(128)]
    last_coeff_8x8 = tbl[1280:1343]

    # --- 残差块上下文偏移 ---
    sig_off = _ints(strip_comments(_extract_block(cabac_c, "significant_coeff_flag_offset[2][14]")))
    last_off = _ints(strip_comments(_extract_block(cabac_c, "last_coeff_flag_offset[2][14]")))
    lvl_off = _ints(strip_comments(_extract_block(cabac_c, "coeff_abs_level_m1_offset[14]")))
    sig_8x8 = _ints(strip_comments(_extract_block(cabac_c, "significant_coeff_flag_offset_8x8[2][63]")))
    assert len(sig_off) == 28 and len(last_off) == 28 and len(lvl_off) == 14
    assert len(sig_8x8) == 126 and len(last_coeff_8x8) == 63

    def rows(values, n):
        return "\n".join(
            "    (" + ", ".join(str(v) for v in values[i:i + n]) + "),"
            for i in range(0, len(values), n)
        )

    out = []
    out.append('"""H.264 CABAC 常数表（ITU-T Rec. H.264 表 9-12/9-13/9-44/9-45 及残差上下文偏移）。')
    out.append("")
    out.append("由 gen_tables.py 自动生成，请勿手工修改。")
    out.append('"""')
    out.append("")
    out.append("# 表 9-12：I slice 上下文初始值，拍平成 m0, n0, m1, n1, ...（ctxIdx 0..1023）")
    out.append("INIT_I = (")
    out.append(rows(init_i, 16))
    out.append(")")
    out.append("")
    out.append("# 表 9-13：P/B slice 上下文初始值，按 cabac_init_idc = 0/1/2")
    for k in range(3):
        chunk = init_pb[k * 2048:(k + 1) * 2048]
        out.append("INIT_PB_%d = (" % k)
        out.append(rows(chunk, 16))
        out.append(")")
        out.append("")
    out.append("INIT_PB = (INIT_PB_0, INIT_PB_1, INIT_PB_2)")
    out.append("")
    out.append("# 表 9-44：rangeTabLPS[4][pStateIdx]（已去重：每行 64 个）")
    out.append("LPS_RANGE = (")
    for r in range(4):
        row = [lps_range[r * 128 + 2 * p] for p in range(64)]
        out.append("    (" + ", ".join(str(v) for v in row) + "),")
    out.append(")")
    out.append("")
    out.append("# 表 9-45：状态转移，索引 = (pStateIdx << 1) | valMPS")
    out.append("MPS_NEXT = (" + ", ".join(str(v) for v in mps_trans) + ")")
    out.append("LPS_NEXT = (" + ", ".join(str(v) for v in lps_trans) + ")")
    out.append("")
    out.append("# 残差系数上下文偏移，下标 [MB_FIELD][ctxBlockCat]")
    out.append("SIG_COEFF_OFFSET = (")
    out.append("    (" + ", ".join(str(v) for v in sig_off[:14]) + "),")
    out.append("    (" + ", ".join(str(v) for v in sig_off[14:]) + "),")
    out.append(")")
    out.append("LAST_COEFF_OFFSET = (")
    out.append("    (" + ", ".join(str(v) for v in last_off[:14]) + "),")
    out.append("    (" + ", ".join(str(v) for v in last_off[14:]) + "),")
    out.append(")")
    out.append("COEFF_LEVEL_OFFSET = (" + ", ".join(str(v) for v in lvl_off) + ")")
    out.append("")
    out.append("# 8x8 残差块（High profile）的上下文映射")
    out.append("SIG_COEFF_OFFSET_8X8 = (")
    out.append("    (" + ", ".join(str(v) for v in sig_8x8[:63]) + "),")
    out.append("    (" + ", ".join(str(v) for v in sig_8x8[63:]) + "),")
    out.append(")")
    out.append("LAST_COEFF_OFFSET_8X8 = (" + ", ".join(str(v) for v in last_coeff_8x8) + ")")
    out.append("")

    (HERE / "h264bw" / "cabac_tables.py").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("wrote h264bw/cabac_tables.py", len("\n".join(out)))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ref")
