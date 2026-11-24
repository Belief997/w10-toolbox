"""一次性脚本：把 ITU-T H.264 表 9-5 / 9-7 / 9-8 / 9-10（CAVLC 变长码表）
抽取成 h264bw/cavlc_tables.py。

数值来自标准文档；这里从公开实现 FFmpeg h264_cavlc.c 里机械抄出来，避免手抄出错。
用法：python gen_cavlc_tables.py <ffmpeg_src_dir>
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def strip_comments(t):
    t = re.sub(r"/\*.*?\*/", " ", t, flags=re.S)
    return re.sub(r"//[^\n]*", " ", t)


def _ints(text):
    return [int(x) for x in re.findall(r"-?\d+", text)]


def _block(src, header):
    i = src.index(header)
    i = src.index("{", i)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return strip_comments(src[i + 1:j])
    raise ValueError(header)


def _table(src, name, rows, cols):
    """取出二维表；行长度可变（total_zeros 是三角表）。"""
    body = _block(src, name)
    if "{" not in body:
        vals = _ints(body)
        assert len(vals) == rows * cols, (name, len(vals), rows * cols)
        return [vals[i * cols:(i + 1) * cols] for i in range(rows)]
    out = []
    i = 0
    while len(out) < rows:
        i = body.index("{", i)
        depth = 0
        for j in range(i, len(body)):
            if body[j] == "{":
                depth += 1
            elif body[j] == "}":
                depth -= 1
                if depth == 0:
                    out.append(_ints(body[i + 1:j]))
                    i = j + 1
                    break
    return out


def emit(out, py_name, table, comment):
    out.append("# " + comment)
    out.append("%s = (" % py_name)
    for row in table:
        out.append("    (" + ", ".join(str(v) for v in row) + "),")
    out.append(")")
    out.append("")


def main(src_dir):
    src = (Path(src_dir) / "h264_cavlc.c").read_text(encoding="utf-8", errors="replace")
    src += (Path(src_dir) / "h264data.c").read_text(encoding="utf-8", errors="replace")
    out = ['"""H.264 CAVLC 变长码表（表 9-5 / 9-7 / 9-8 / 9-10）。',
           "",
           "由 gen_cavlc_tables.py 自动生成，请勿手工修改。",
           '"""', ""]

    emit(out, "COEFF_TOKEN_LEN", _table(src, "coeff_token_len[4][4*17]", 4, 68),
         "表 9-5：coeff_token 码长，[4 个 nC 区间][TotalCoeff*4+TrailingOnes]")
    emit(out, "COEFF_TOKEN_BITS", _table(src, "coeff_token_bits[4][4*17]", 4, 68),
         "表 9-5：coeff_token 码字")
    emit(out, "TOTAL_ZEROS_LEN", _table(src, "total_zeros_len[16][16]", 15, 16),
         "表 9-7：total_zeros 码长（4x4 块），[total_coeff-1][total_zeros]")
    emit(out, "TOTAL_ZEROS_BITS", _table(src, "total_zeros_bits[16][16]", 15, 16),
         "表 9-7：total_zeros 码字")
    emit(out, "RUN_LEN", _table(src, "run_len[7][16]", 7, 16),
         "表 9-10：run_before 码长（4x4 块）")
    emit(out, "RUN_BITS", _table(src, "run_bits[7][16]", 7, 16),
         "表 9-10：run_before 码字")
    emit(out, "CHROMA_DC_COEFF_TOKEN_LEN", _table(src, "chroma_dc_coeff_token_len[4*5]", 1, 20),
         "色度 DC 4:2:0 的 coeff_token 码长")
    emit(out, "CHROMA_DC_COEFF_TOKEN_BITS", _table(src, "chroma_dc_coeff_token_bits[4*5]", 1, 20),
         "色度 DC 4:2:0 的 coeff_token 码字")
    emit(out, "CHROMA_DC_TOTAL_ZEROS_LEN", _table(src, "chroma_dc_total_zeros_len[3][4]", 3, 4),
         "色度 DC 4:2:0 的 total_zeros 码长")
    emit(out, "CHROMA_DC_TOTAL_ZEROS_BITS", _table(src, "chroma_dc_total_zeros_bits[3][4]", 3, 4),
         "色度 DC 4:2:0 的 total_zeros 码字")
    emit(out, "GOLOMB_TO_INTER_CBP", _table(src, "ff_h264_golomb_to_inter_cbp[48]", 1, 48),
         "表 9-4 前半：inter 块 coded_block_pattern 的 me(v) 映射")
    emit(out, "GOLOMB_TO_INTRA4X4_CBP", _table(src, "ff_h264_golomb_to_intra4x4_cbp[48]", 1, 48),
         "表 9-4 后半：intra4x4 块 coded_block_pattern 的 me(v) 映射")

    (HERE / "h264bw" / "cavlc_tables.py").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("wrote h264bw/cavlc_tables.py")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ref")
