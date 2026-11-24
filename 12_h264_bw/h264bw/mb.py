"""slice data 层：宏块 / 子宏块语法（ITU-T H.264 7.3.4 / 7.3.5）。

⚠ 状态：实验代码，未完成。CAVLC 的 4x4 路径已在多条码流上做到位精确
（解析消耗的比特数正好等于 NAL 尾部），但 8x8 DCT 的 nC 上下文、CABAC 的
部分低频上下文、P/B 帧的 MV 预测仍未完全打通，部分码流会解析中断。
当前 analyze.py 只用同一套头解析器（params.py / decoder.py 的 header_only），
逐块 MV 走 mvtool/mvdump（FFmpeg 的 MV 侧数据），因此这条路径不影响出数。

只做熵解码 + 运动信息提取，不做像素重建。每个宏块解码完回调 on_mb，
交出 [(宽, 高, mvL0, mvL1), ...]，mv 为 1/4 像素单位的 (x, y) 或 None。
"""

from .bitstream import BitReaderError
from .cabac import Cabac
from .cabac_tables import (SIG_COEFF_OFFSET, LAST_COEFF_OFFSET, COEFF_LEVEL_OFFSET,
                           SIG_COEFF_OFFSET_8X8, LAST_COEFF_OFFSET_8X8)
from .cavlc_tables import (
    COEFF_TOKEN_LEN, COEFF_TOKEN_BITS, TOTAL_ZEROS_LEN, TOTAL_ZEROS_BITS, RUN_LEN, RUN_BITS,
    CHROMA_DC_COEFF_TOKEN_LEN, CHROMA_DC_COEFF_TOKEN_BITS,
    CHROMA_DC_TOTAL_ZEROS_LEN, CHROMA_DC_TOTAL_ZEROS_BITS,
    GOLOMB_TO_INTER_CBP, GOLOMB_TO_INTRA4X4_CBP,
)
from .mbtables import P_MB, B_MB, P_SUB_MB, B_SUB_MB, i_mb_info
from .picture import PART_NOT_AVAILABLE, LIST_NOT_USED

# 残差上下文类别（ctxBlockCat），与 FFmpeg 的 cat 编号一致
CAT_LUMA_DC = 0
CAT_LUMA_AC16 = 1
CAT_LUMA4x4 = 2
CAT_CHROMA_DC = 3
CAT_CHROMA_AC = 4
CAT_LUMA8x8 = 5

CBF_BASE = (85, 89, 93, 97, 101, 1012)

CB_ABS_LEVEL1_CTX = (1, 2, 3, 4, 0, 0, 0, 0)
CB_ABS_LEVELGT1_CTX = (5, 5, 5, 5, 6, 7, 8, 9)
CB_ABS_TRANS_ONE = (1, 2, 3, 3, 4, 5, 6, 7)
CB_ABS_TRANS_GT1 = (4, 4, 4, 4, 5, 6, 7, 7)

# nnz 数组下标：0..15 亮度 AC 的 4x4，16..19 Cb，32..35 Cr（与 FFmpeg 相同）
NNZ_CB = 16
NNZ_CR = 32


def _vlc_table(lens, bits):
    t = {}
    for value, (n, b) in enumerate(zip(lens, bits)):
        if n:
            t[(n, b)] = value
    return t


COEFF_TOKEN_VLC = tuple(_vlc_table(COEFF_TOKEN_LEN[i], COEFF_TOKEN_BITS[i]) for i in range(4))
TOTAL_ZEROS_VLC = tuple(_vlc_table(TOTAL_ZEROS_LEN[i], TOTAL_ZEROS_BITS[i]) for i in range(15))
RUN_VLC = tuple(_vlc_table(RUN_LEN[i], RUN_BITS[i]) for i in range(7))
CHROMA_DC_CT_VLC = _vlc_table(CHROMA_DC_COEFF_TOKEN_LEN[0], CHROMA_DC_COEFF_TOKEN_BITS[0])
CHROMA_DC_TZ_VLC = tuple(_vlc_table(CHROMA_DC_TOTAL_ZEROS_LEN[i], CHROMA_DC_TOTAL_ZEROS_BITS[i])
                         for i in range(3))
GOLOMB_CBP_INTER = GOLOMB_TO_INTER_CBP[0]
GOLOMB_CBP_INTRA4 = GOLOMB_TO_INTRA4X4_CBP[0]


def _read_vlc(br, table):
    code = 0
    for n in range(1, 17):
        code = (code << 1) | br.bit()
        v = table.get((n, code))
        if v is not None:
            return v
    raise BitReaderError("非法的 VLC 码")


def _mid_pred(a, b, c):
    if b < c:
        if a < b:
            return b
        return b if c < a else a
    if b < a:
        return b
    return a if c < a else c


class SliceDecoder(object):
    def __init__(self, dec, sh, reader, sps, pps):
        self.dec = dec
        self.sps = sps
        self.pps = pps
        self.pic = dec.pic
        self.sh = sh
        self.br = reader
        self.on_mb = dec.on_mb

        self.states = None
        self.cabac = None
        self.cabac_mode = bool(self.pps.entropy_coding_mode)
        if self.cabac_mode:
            self.states = bytearray(1024)
            self.cabac = Cabac(reader, self.states)
            self.cabac.reset(sh.slice_qp, sh.cabac_init_idc, sh.is_intra_slice())

        self.slice_type = sh.slice_type
        self.intra_slice = sh.is_intra_slice()
        self.list_count = 2 if sh.slice_type == "B" else (0 if self.intra_slice else 1)
        self.ref_count = (sh.num_ref_idx_l0, sh.num_ref_idx_l1)
        self.slice_dct8x8 = bool(self.pps.transform_8x8_mode)
        self.direct_spatial = bool(sh.direct_spatial_mv_pred)

        pic = self.pic
        self.mvx0, self.mvy0, self.ref0 = pic.mvx0, pic.mvy0, pic.ref0
        self.mvx1, self.mvy1, self.ref1 = pic.mvx1, pic.mvy1, pic.ref1
        self.mdx0, self.mdy0 = pic.mdx0, pic.mdy0
        self.mdx1, self.mdy1 = pic.mdx1, pic.mdy1
        self.stride = pic.stride
        self.w_mbs = pic.w_mbs
        self.n_mb = pic.n_mb

        self.mb_x = 0
        self.mb_y = 0
        self.mb_addr = sh.first_mb
        self.nnz = [0] * 48
        self.dct8x8 = False
        self.last_qscale_diff = 0

    # ------------------------------------------------------------- 运动场访问
    def _blk(self, mb_x, mb_y, x, y):
        return ((mb_y + 1) * 4 + y) * self.stride + (mb_x + 1) * 4 + x

    def _get_mv(self, lst, mb_x, mb_y, x, y):
        i = ((mb_y + 1) * 4 + y) * self.stride + (mb_x + 1) * 4 + x
        if lst == 0:
            return self.mvx0[i], self.mvy0[i], self.ref0[i]
        return self.mvx1[i], self.mvy1[i], self.ref1[i]

    def _get_local(self, lst, x, y):
        """以当前宏块为原点的块坐标（x/y 可为 -1，越界落到 padding / 相邻宏块）。"""
        return self._get_mv(lst, self.mb_x, self.mb_y, x, y)

    def _set_mv(self, lst, x, y, w4, h4, mx, my, ref, mdx=0, mdy=0):
        if lst == 0:
            mvx, mvy, rf = self.mvx0, self.mvy0, self.ref0
            mdx_a, mdy_a = self.mdx0, self.mdy0
        else:
            mvx, mvy, rf = self.mvx1, self.mvy1, self.ref1
            mdx_a, mdy_a = self.mdx1, self.mdy1
        stride = self.stride
        base_y = (self.mb_y + 1) * 4 + y
        base_x = (self.mb_x + 1) * 4 + x
        for dy in range(h4):
            base = (base_y + dy) * stride + base_x
            for dx in range(w4):
                mvx[base + dx] = mx
                mvy[base + dx] = my
                rf[base + dx] = ref
                mdx_a[base + dx] = mdx
                mdy_a[base + dx] = mdy

    def _reset_mb_blocks(self):
        stride = self.stride
        base_y = (self.mb_y + 1) * 4
        base_x = (self.mb_x + 1) * 4
        for dy in range(4):
            base = (base_y + dy) * stride + base_x
            for dx in range(4):
                i = base + dx
                self.mvx0[i] = self.mvx1[i] = self.mvy0[i] = self.mvy1[i] = 0
                self.ref0[i] = self.ref1[i] = PART_NOT_AVAILABLE

    # ---------------------------------------------------------------- 邻居宏块
    def _nb_addr(self, dx, dy):
        mb_x = self.mb_x + dx
        mb_y = self.mb_y + dy
        if mb_x < 0 or mb_y < 0 or mb_x >= self.w_mbs:
            return -1
        addr = mb_y * self.w_mbs + mb_x
        return addr if addr < self.n_mb else -1

    def _nnz_at(self, mb_x, mb_y, idx):
        if mb_x < 0 or mb_y < 0 or mb_x >= self.w_mbs:
            return None
        addr = mb_y * self.w_mbs + mb_x
        if addr == self.mb_addr:
            return self.nnz[idx]
        arr = self.pic.nnz[addr]
        if arr is None:
            return None
        return arr[idx]

    def _empty_nnz(self):
        if self.cabac_mode and not self.pic.is_intra[self.mb_addr]:
            return 0
        return 64

    def _nc_context(self, x, y, base, size):
        """CAVLC 的 nC 预测：块 (x,y) 的左、上邻居。"""
        if x > 0:
            left = self.nnz[base + y * size + x - 1]
        else:
            left = self._nnz_at(self.mb_x - 1, self.mb_y, base + y * size + size - 1)
            if left is None:
                left = self._empty_nnz()
        if y > 0:
            top = self.nnz[base + (y - 1) * size + x]
        else:
            top = self._nnz_at(self.mb_x, self.mb_y - 1, base + (size - 1) * size + x)
            if top is None:
                top = self._empty_nnz()
        n = left + top
        if n < 64:
            n = (n + 1) >> 1
        return n & 31

    # -------------------------------------------------------------- MV 预测
    def _pred_motion(self, x, y, part_width, lst, ref):
        ax, ay, aref = self._get_local(lst, x - 1, y)
        bx_, by_, bref = self._get_local(lst, x, y - 1)
        cx, cy, cref = self._get_local(lst, x + part_width, y - 1)
        if cref == PART_NOT_AVAILABLE:
            cx, cy, cref = self._get_local(lst, x - 1, y - 1)
        match = (cref == ref) + (bref == ref) + (aref == ref)
        if match > 1:
            return _mid_pred(ax, bx_, cx), _mid_pred(ay, by_, cy)
        if match == 1:
            if aref == ref:
                return ax, ay
            if bref == ref:
                return bx_, by_
            return cx, cy
        if bref == PART_NOT_AVAILABLE and cref == PART_NOT_AVAILABLE and aref != PART_NOT_AVAILABLE:
            return ax, ay
        return _mid_pred(ax, bx_, cx), _mid_pred(ay, by_, cy)

    def _pred_16x8_motion(self, i, lst, ref):
        if i == 0:
            mx, my, r = self._get_local(lst, 0, -1)
        else:
            mx, my, r = self._get_local(lst, -1, 2)
        if r == ref:
            return mx, my
        return self._pred_motion(0, i * 2, 4, lst, ref)

    def _pred_8x16_motion(self, i, lst, ref):
        if i == 0:
            mx, my, r = self._get_local(lst, -1, 0)
        else:
            mx, my, r = self._get_local(lst, 2, 0)
            if r == PART_NOT_AVAILABLE:
                mx, my, r = self._get_local(lst, -1, 0)
        if r == ref:
            return mx, my
        return self._pred_motion(i * 2, 0, 2, lst, ref)

    # ---------------------------------------------------------------- 主循环
    def run(self):
        pending_skip = 0
        while self.mb_addr < self.n_mb:
            self.mb_x = self.mb_addr % self.w_mbs
            self.mb_y = self.mb_addr // self.w_mbs
            self.nnz = [0] * 48
            self.dct8x8 = self.slice_dct8x8
            self._reset_mb_blocks()
            if self.cabac_mode:
                self._mb_cabac(self.mb_addr)
                self.mb_addr += 1
                if self.cabac.terminate():
                    break
                continue
            else:
                if not self.intra_slice:
                    if pending_skip == 0:
                        pending_skip = self.br.ue()
                    if pending_skip:
                        pending_skip -= 1
                        self._mb_skip(self.mb_addr)
                        self.mb_addr += 1
                        continue
                self._mb_cavlc(self.mb_addr)
            self.mb_addr += 1
        if self.cabac is not None:
            return self.cabac.byte_pos
        self.br.align()
        return self.br.pos >> 3

    # ------------------------------------------------------------ 残差：CAVLC
    def _residual_cavlc(self, max_coeff, x, y, base, size):
        br = self.br
        if max_coeff <= 8:
            code = _read_vlc(br, CHROMA_DC_CT_VLC)
        else:
            nc = self._nc_context(x, y, base, size)
            if nc < 2:
                code = _read_vlc(br, COEFF_TOKEN_VLC[0])
            elif nc < 4:
                code = _read_vlc(br, COEFF_TOKEN_VLC[1])
            elif nc < 8:
                code = _read_vlc(br, COEFF_TOKEN_VLC[2])
            else:
                code = br.u(6)
        total_coeff = code >> 2
        trailing = code & 3
        if total_coeff == 0:
            return 0
        if total_coeff > max_coeff:
            raise BitReaderError("total_coeff 越界")

        if trailing:
            br.skip(trailing)

        if trailing < total_coeff:
            suffix_len = 1 if (total_coeff > 10 and trailing < 3) else 0
            for i in range(trailing, total_coeff):
                zeros = 0
                while br.bit() == 0:
                    zeros += 1
                    if zeros > 32:
                        raise BitReaderError("level_prefix 过长")
                prefix = zeros
                if prefix == 14 and suffix_len == 0:
                    suffix_size = 4
                elif prefix >= 15:
                    suffix_size = 12
                else:
                    suffix_size = suffix_len
                suffix = br.u(suffix_size) if suffix_size else 0
                level_code = (min(15, prefix) << suffix_len) + suffix
                if prefix >= 15 and suffix_len == 0:
                    level_code += 15
                if prefix >= 16:
                    level_code += (1 << (prefix - 3)) - 4096
                if i == trailing and trailing < 3:
                    level_code += 2
                if level_code % 2 == 0:
                    level = (level_code + 2) >> 1
                else:
                    level = (-level_code - 1) >> 1
                if suffix_len == 0:
                    suffix_len = 1
                if abs(level) > (3 << (suffix_len - 1)) and suffix_len < 6:
                    suffix_len += 1

        if total_coeff < max_coeff:
            if max_coeff <= 8:
                zeros_left = _read_vlc(br, CHROMA_DC_TZ_VLC[total_coeff - 1])
            else:
                zeros_left = _read_vlc(br, TOTAL_ZEROS_VLC[total_coeff - 1])
        else:
            zeros_left = 0

        i = 1
        while i < total_coeff and zeros_left > 0:
            row = RUN_VLC[zeros_left - 1] if zeros_left < 7 else RUN_VLC[6]
            zeros_left -= _read_vlc(br, row)
            i += 1
        return total_coeff

    def _residual_mb_cavlc(self, cbp, is_16x16):
        br = self.br
        pic = self.pic
        mb_addr = self.mb_addr
        nnz = self.nnz
        pic.cbp[mb_addr] = cbp
        pic.nnz[mb_addr] = nnz
        if cbp or is_16x16:
            br.se()                                     # mb_qp_delta
        if is_16x16:
            n = self._residual_cavlc(16, 0, 0, 0, 4)
            if n:
                pic.cbp[mb_addr] |= 0x100
            if cbp & 15:
                self._luma_ac_cavlc(cbp, 15)
        elif cbp & 15:
            self._luma_ac_cavlc(cbp, 16)
        if cbp & 0x30:
            for idx in range(2):
                base = NNZ_CB if idx == 0 else NNZ_CR
                n = self._residual_cavlc(4, 0, 0, base, 2)
                if n:
                    pic.cbp[mb_addr] |= 0x40 << idx
        if cbp & 0x20:
            for idx in range(2):
                base = NNZ_CB if idx == 0 else NNZ_CR
                for k in range(4):
                    nnz[base + k] = self._residual_cavlc(
                        16, k & 1, k >> 1, base, 2)

    def _luma_ac_cavlc(self, cbp, max_coeff):
        nnz = self.nnz
        for i8 in range(4):
            if not (cbp & (1 << i8)):
                continue
            if self.dct8x8:
                n = self._residual_cavlc(64, (i8 & 1) * 2, (i8 >> 1) * 2, 0, 4)
                x0 = (i8 & 1) * 2
                y0 = (i8 >> 1) * 2
                for dy in range(2):
                    for dx in range(2):
                        nnz[(y0 + dy) * 4 + x0 + dx] = n
            else:
                for k in range(4):
                    x = (i8 & 1) * 2 + (k & 1)
                    y = (i8 >> 1) * 2 + (k >> 1)
                    nnz[y * 4 + x] = self._residual_cavlc(max_coeff, x, y, 0, 4)

    # ------------------------------------------------------------ 残差：CABAC
    def _cbf_ctx(self, cat, x, y, base, size, is_dc=False, dc_idx=0):
        pic = self.pic
        if is_dc:
            left_cbp, top_cbp = self._neighbor_cbp()
            if cat == CAT_CHROMA_DC:
                nza = (left_cbp >> (6 + dc_idx)) & 1
                nzb = (top_cbp >> (6 + dc_idx)) & 1
            else:
                nza = left_cbp & 0x100
                nzb = top_cbp & 0x100
            return CBF_BASE[cat] + (1 if nza else 0) + (2 if nzb else 0)
        if x > 0:
            nza = self.nnz[base + y * size + x - 1]
        else:
            nza = self._nnz_at(self.mb_x - 1, self.mb_y, base + y * size + size - 1)
            if nza is None:
                nza = self._empty_nnz()
        if y > 0:
            nzb = self.nnz[base + (y - 1) * size + x]
        else:
            nzb = self._nnz_at(self.mb_x, self.mb_y - 1, base + (size - 1) * size + x)
            if nzb is None:
                nzb = self._empty_nnz()
        return CBF_BASE[cat] + (1 if nza > 0 else 0) + (2 if nzb > 0 else 0)

    def _neighbor_cbp(self):
        pic = self.pic
        mb_x, mb_y = self.mb_x, self.mb_y
        if mb_x == 0:
            left_cbp = 0x7CF if pic.is_intra[self.mb_addr] else 0x00F
        else:
            left_cbp = pic.cbp[mb_y * self.w_mbs + mb_x - 1] & 0x7FA
        if mb_y == 0:
            top_cbp = 0x7CF if pic.is_intra[self.mb_addr] else 0x00F
        else:
            top_cbp = pic.cbp[(mb_y - 1) * self.w_mbs + mb_x]
        return left_cbp, top_cbp

    def _residual_cabac(self, cat, x, y, max_coeff, base, size, is_dc=False, dc_idx=0):
        cab = self.cabac
        if cab.decision(self._cbf_ctx(cat, x, y, base, size, is_dc, dc_idx)) == 0:
            return 0

        sig_base = SIG_COEFF_OFFSET[0][cat]
        last_base = LAST_COEFF_OFFSET[0][cat]
        lvl_base = COEFF_LEVEL_OFFSET[cat]
        count = 0
        broke = False
        if max_coeff == 64:
            sig_off = SIG_COEFF_OFFSET_8X8[0]
            for i in range(63):
                if cab.decision(sig_base + sig_off[i]):
                    count += 1
                    if cab.decision(last_base + LAST_COEFF_OFFSET_8X8[i]):
                        broke = True
                        break
        else:
            for i in range(max_coeff - 1):
                if cab.decision(sig_base + i):
                    count += 1
                    if cab.decision(last_base + i):
                        broke = True
                        break
        if not broke:
            count += 1

        node_ctx = 0
        remaining = count
        while remaining:
            remaining -= 1
            if cab.decision(lvl_base + CB_ABS_LEVEL1_CTX[node_ctx]) == 0:
                node_ctx = CB_ABS_TRANS_ONE[node_ctx]
                cab.bypass()                                # 符号位
            else:
                coeff_abs = 2
                ctx = lvl_base + CB_ABS_LEVELGT1_CTX[node_ctx]
                node_ctx = CB_ABS_TRANS_GT1[node_ctx]
                while coeff_abs < 15 and cab.decision(ctx):
                    coeff_abs += 1
                if coeff_abs >= 15:
                    j = 0
                    while cab.bypass() and j < 23:
                        j += 1
                    coeff_abs = 1
                    while j:
                        j -= 1
                        coeff_abs += coeff_abs + cab.bypass()
                    coeff_abs += 14
                cab.bypass()                                # 符号位
        return count

    def _cabac_qp_delta(self):
        """CABAC 的 mb_qp_delta（ctxIdx 60..63）。"""
        cab = self.cabac
        if cab.decision(60 + (1 if self.last_qscale_diff else 0)):
            val = 1
            ctx = 2
            while cab.decision(60 + ctx):
                ctx = 3
                val += 1
                if val > 102:
                    raise BitReaderError("qscale diff 越界")
            val = (val + 1) >> 1 if (val & 1) else -((val + 1) >> 1)
            self.last_qscale_diff = val
        else:
            self.last_qscale_diff = 0

    def _residual_mb_cabac(self, cbp, is_16x16):
        pic = self.pic
        mb_addr = self.mb_addr
        nnz = self.nnz
        pic.cbp[mb_addr] = cbp
        pic.nnz[mb_addr] = nnz
        if cbp or is_16x16:
            self._cabac_qp_delta()
        else:
            self.last_qscale_diff = 0
        if is_16x16:
            n = self._residual_cabac(CAT_LUMA_DC, 0, 0, 16, 0, 4, True)
            if n:
                pic.cbp[mb_addr] |= 0x100
            if cbp & 15:
                self._luma_ac_cabac(cbp, CAT_LUMA_AC16)
        elif cbp & 15:
            self._luma_ac_cabac(cbp, CAT_LUMA4x4)
        if cbp & 0x30:
            for idx in range(2):
                n = self._residual_cabac(CAT_CHROMA_DC, 0, 0, 4, 0, 2, True, idx)
                if n:
                    pic.cbp[mb_addr] |= 0x40 << idx
        if cbp & 0x20:
            for idx in range(2):
                base = NNZ_CB if idx == 0 else NNZ_CR
                for k in range(4):
                    nnz[base + k] = self._residual_cabac(
                        CAT_CHROMA_AC, k & 1, k >> 1, 16, base, 2)

    def _luma_ac_cabac(self, cbp, cat):
        nnz = self.nnz
        max_coeff = 15 if cat == CAT_LUMA_AC16 else 16
        for i8 in range(4):
            if not (cbp & (1 << i8)):
                continue
            if self.dct8x8:
                n = self._residual_cabac(CAT_LUMA8x8, (i8 & 1) * 2, (i8 >> 1) * 2, 64, 0, 4)
                x0 = (i8 & 1) * 2
                y0 = (i8 >> 1) * 2
                for dy in range(2):
                    for dx in range(2):
                        nnz[(y0 + dy) * 4 + x0 + dx] = n
            else:
                for k in range(4):
                    x = (i8 & 1) * 2 + (k & 1)
                    y = (i8 >> 1) * 2 + (k >> 1)
                    nnz[y * 4 + x] = self._residual_cabac(
                        cat, x, y, max_coeff, 0, 4)

    # ---------------------------------------------------------------- skip
    def _mb_skip(self, mb_addr):
        pic = self.pic
        pic.is_skip[mb_addr] = 1
        pic.nnz[mb_addr] = self.nnz
        pic.cbp[mb_addr] = 0
        pic.chroma_pred[mb_addr] = 0
        self.last_qscale_diff = 0
        if self.slice_type == "P":
            mx, my = self._pskip_motion()
            self._set_mv(0, 0, 0, 4, 4, mx, my, 0)
            self._set_mv(1, 0, 0, 4, 4, 0, 0, LIST_NOT_USED)
            pic.shape[mb_addr] = 1
            self.on_mb(mb_addr, [(16, 16, (mx, my), None)], "skip")
        else:
            blocks = self._direct_motion(True)
            self.on_mb(mb_addr, blocks, "skip")

    def _pskip_motion(self):
        pic = self.pic
        a = self._nb_addr(-1, 0)
        b = self._nb_addr(0, -1)
        if a < 0 or not (pic.is_skip[a] or pic.shape[a]):
            return 0, 0
        if b < 0 or not (pic.is_skip[b] or pic.shape[b]):
            return 0, 0
        ax, ay, aref = self._get_local(0, -1, 0)
        bx_, by_, bref = self._get_local(0, 0, -1)
        if not (aref > 0 or ax or ay) and not (bref > 0 or bx_ or by_):
            return 0, 0
        cx, cy, cref = self._get_local(0, 4, -1)
        if cref == PART_NOT_AVAILABLE:
            cx, cy, cref = self._get_local(0, -1, -1)
        match = (cref == 0) + (bref == 0) + (aref == 0)
        if match > 1:
            return _mid_pred(ax, bx_, cx), _mid_pred(ay, by_, cy)
        if match == 1:
            if aref == 0:
                return ax, ay
            if bref == 0:
                return bx_, by_
            return cx, cy
        return _mid_pred(ax, bx_, cx), _mid_pred(ay, by_, cy)

    # --------------------------------------------------------- direct 推导
    def _direct_motion(self, whole_mb):
        pic = self.pic
        mb_addr = self.mb_addr
        pic.is_direct[mb_addr] = 1
        is_b8x8 = not whole_mb
        col = self.dec.colocated_picture()

        if self.direct_spatial:
            ref = [0, 0]
            mv = [(0, 0), (0, 0)]
            for lst in (0, 1):
                lref = self._get_local(lst, -1, 0)[2]
                tref = self._get_local(lst, 0, -1)[2]
                cref, cmvx, cmvy = self._get_local(lst, 4, -1)
                if cref == PART_NOT_AVAILABLE:
                    cref, cmvx, cmvy = self._get_local(lst, -1, -1)
                r = self._min_ref(lref, tref, cref)
                if r >= 0:
                    ax, ay, _ = self._get_local(lst, -1, 0)
                    bx_, by_, _ = self._get_local(lst, 0, -1)
                    match = (lref == r) + (tref == r) + (cref == r)
                    if match > 1:
                        mv[lst] = (_mid_pred(ax, bx_, cmvx), _mid_pred(ay, by_, cmvy))
                    elif lref == r:
                        mv[lst] = (ax, ay)
                    elif tref == r:
                        mv[lst] = (bx_, by_)
                    else:
                        mv[lst] = (cmvx, cmvy)
                    ref[lst] = r
                else:
                    ref[lst] = -1
                    mv[lst] = (0, 0)
            if ref[0] < 0 and ref[1] < 0:
                ref = [0, 0]
        else:
            ref, mv = self._temporal_mv(col)

        if is_b8x8:
            shape = 4
        else:
            col_shape = col.shape[mb_addr] if col is not None and mb_addr < len(col.shape) else 0
            if mv[0] == (0, 0) and mv[1] == (0, 0):
                col_shape = 1
            if col_shape in (0, 1):
                shape = 1
            elif col_shape in (2, 3):
                shape = col_shape
            else:
                shape = 4
        pic.shape[mb_addr] = shape

        blocks = []
        if shape == 4:
            for i8 in range(4):
                sx, sy = (i8 & 1) * 2, (i8 >> 1) * 2
                for lst in (0, 1):
                    self._set_mv(lst, sx, sy, 2, 2, mv[lst][0], mv[lst][1],
                                 ref[lst] if ref[lst] >= 0 else LIST_NOT_USED)
                blocks.append((8, 8, mv[0] if ref[0] >= 0 else None,
                               mv[1] if ref[1] >= 0 else None))
        elif shape == 1:
            for lst in (0, 1):
                self._set_mv(lst, 0, 0, 4, 4, mv[lst][0], mv[lst][1],
                             ref[lst] if ref[lst] >= 0 else LIST_NOT_USED)
            blocks.append((16, 16, mv[0] if ref[0] >= 0 else None,
                           mv[1] if ref[1] >= 0 else None))
        elif shape == 2:
            for i in range(2):
                for lst in (0, 1):
                    self._set_mv(lst, 0, i * 2, 4, 2, mv[lst][0], mv[lst][1],
                                 ref[lst] if ref[lst] >= 0 else LIST_NOT_USED)
                blocks.append((16, 8, mv[0] if ref[0] >= 0 else None,
                               mv[1] if ref[1] >= 0 else None))
        else:
            for i in range(2):
                for lst in (0, 1):
                    self._set_mv(lst, i * 2, 0, 2, 4, mv[lst][0], mv[lst][1],
                                 ref[lst] if ref[lst] >= 0 else LIST_NOT_USED)
                blocks.append((8, 16, mv[0] if ref[0] >= 0 else None,
                               mv[1] if ref[1] >= 0 else None))
        pic.cbp[mb_addr] = 0
        return blocks

    @staticmethod
    def _min_ref(a, b, c):
        ua, ub, uc = a & 0xFF, b & 0xFF, c & 0xFF
        m = min(ua, ub, uc)
        if m >= 0x80:
            return -1 if m == 0xFF else -2
        return m

    def _temporal_mv(self, col):
        if col is None:
            return [0, 0], [(0, 0), (0, 0)]
        i = col.block_index(self.mb_x, self.mb_y, 0, 0)
        ref_idx = col.ref0[i]
        if ref_idx >= 0:
            src_mvx, src_mvy = col.mvx0, col.mvy0
            col_list = col.ref_lists[0]
        else:
            ref_idx = col.ref1[i]
            src_mvx, src_mvy = col.mvx1, col.mvy1
            col_list = col.ref_lists[1]
        if ref_idx < 0 or ref_idx >= len(col_list):
            return [0, 0], [(0, 0), (0, 0)]
        refp = col_list[ref_idx]
        td = max(-128, min(127, col.poc - refp.poc))
        tb = max(-128, min(127, self.pic.poc - refp.poc))
        if td == 0:
            scale = 0
        else:
            tx = (16384 + (abs(td) >> 1)) // td
            scale = max(-4096, min(4095, (tb * tx + 32) >> 6))
        mcx = src_mvx[i]
        mcy = src_mvy[i]
        mvx = (scale * mcx + 128) >> 8
        mvy = (scale * mcy + 128) >> 8
        return [ref_idx, 0], [(mvx, mvy), (mvx - mcx, mvy - mcy)]

    # ------------------------------------------------------ 宏块：CAVLC 主体
    def _mb_cavlc(self, mb_addr):
        br = self.br
        pic = self.pic
        pic.is_skip[mb_addr] = 0
        mb_type = br.ue()
        if self.slice_type == "B":
            if mb_type >= 23:
                self._mb_intra_cavlc(mb_type - 23)
                return
            parts = B_MB[mb_type]
        elif self.slice_type == "P":
            if mb_type >= 5:
                self._mb_intra_cavlc(mb_type - 5)
                return
            parts = P_MB[mb_type]
        else:
            self._mb_intra_cavlc(mb_type)
            return

        if self.slice_type == "B" and mb_type == 0:
            blocks = self._direct_motion(True)
            pic.cbp[mb_addr] = 0
            pic.nnz[mb_addr] = self.nnz
            self.on_mb(mb_addr, blocks, "direct")
            return

        if parts is None:                                   # 8x8 子宏块
            tables = B_SUB_MB if self.slice_type == "B" else P_SUB_MB
            sub_types = [br.ue() for _ in range(4)]
            if self.slice_type == "B" and 0 in sub_types:
                self._direct_motion(False)
            if self.slice_dct8x8:
                self.dct8x8 = all(self._sub_8x8_ok(tables, t) for t in sub_types)
            blocks = self._inter_8x8_cavlc(tables, sub_types)
            pic.shape[mb_addr] = 4
        else:
            blocks = self._inter_part_cavlc(parts)
            if len(parts) == 1:
                pic.shape[mb_addr] = 1
            elif len(parts) == 2:
                pic.shape[mb_addr] = 2 if parts[0][0] == 16 else 3
            else:
                pic.shape[mb_addr] = 4

        code = br.ue()
        if code < 48:
            cbp = GOLOMB_CBP_INTRA4[code] if self.pic.is_intra[mb_addr] else GOLOMB_CBP_INTER[code]
        else:
            cbp = 0
        if self.slice_dct8x8 and (cbp & 15):
            t8 = br.u(1)
            pic.t8x8[mb_addr] = t8
            self.dct8x8 = bool(t8)
        self._residual_mb_cavlc(cbp, False)
        self.on_mb(mb_addr, blocks, "inter")

    def _ue_small(self, limit):
        v = self.br.ue()
        if v > limit:
            raise BitReaderError("语法元素越界：%d" % v)
        return v

    @staticmethod
    def _sub_8x8_ok(tables, t):
        st = tables[t]
        return t == 0 or (st is not None and st[0][0] == 8 and st[0][1] == 8)

    def _inter_part_cavlc(self, parts):
        br = self.br
        lists = range(self.list_count)
        refs = {}
        for lst in lists:
            rcount = self.ref_count[lst]
            for i, part in enumerate(parts):
                if not self._dir_uses(part[2], lst):
                    continue
                if rcount == 1:
                    refs[(lst, i)] = 0
                elif rcount == 2:
                    refs[(lst, i)] = br.u(1) ^ 1
                else:
                    refs[(lst, i)] = br.ue()
        mvs = {}
        for lst in lists:
            for i, part in enumerate(parts):
                if not self._dir_uses(part[2], lst):
                    continue
                ref = refs[(lst, i)]
                if part[0] == 16 and part[1] == 16:
                    mx, my = self._pred_motion(0, 0, 4, lst, ref)
                    sx, sy, w4, h4 = 0, 0, 4, 4
                elif part[1] == 8:
                    mx, my = self._pred_16x8_motion(i, lst, ref)
                    sx, sy, w4, h4 = 0, i * 2, 4, 2
                else:
                    mx, my = self._pred_8x16_motion(i, lst, ref)
                    sx, sy, w4, h4 = i * 2, 0, 2, 4
                mx += br.se()
                my += br.se()
                mvs[(lst, i)] = (mx, my)
                self._set_mv(lst, sx, sy, w4, h4, mx, my, ref)
        blocks = []
        for i, part in enumerate(parts):
            m0 = mvs.get((0, i)) if part[2] in ("L0", "BI") else None
            m1 = mvs.get((1, i)) if part[2] in ("L1", "BI") else None
            blocks.append((part[0], part[1], m0, m1))
        return blocks

    @staticmethod
    def _dir_uses(direction, lst):
        return (direction == "L0" and lst == 0) or (direction == "L1" and lst == 1) \
            or direction == "BI"

    def _inter_8x8_cavlc(self, tables, sub_types):
        br = self.br
        refs = [[-1] * 4, [-1] * 4]
        mvs = [[None] * 4, [None] * 4]
        for lst in range(self.list_count):
            rcount = self.ref_count[lst]
            for i in range(4):
                st = tables[sub_types[i]]
                if st is None or not self._dir_uses(st[0][2], lst):
                    continue
                if rcount == 1:
                    refs[lst][i] = 0
                elif rcount == 2:
                    refs[lst][i] = br.u(1) ^ 1
                else:
                    refs[lst][i] = br.ue()
        for lst in range(self.list_count):
            for i in range(4):
                st = tables[sub_types[i]]
                if st is None or not self._dir_uses(st[0][2], lst):
                    continue
                ref = refs[lst][i]
                part = st[0]
                bw = 2 if part[0] == 8 else 1
                for j in range(len(st)):
                    index = 4 * i + bw * j
                    x = index & 3
                    y = index >> 2
                    mx, my = self._pred_motion(x, y, bw, lst, ref)
                    mx += br.se()
                    my += br.se()
                    mvs[lst][i] = (mx, my)
                    self._set_mv(lst, x, y, bw, part[1] // 4, mx, my, ref)
        return self._emit_8x8(tables, sub_types, refs, mvs)

    def _emit_8x8(self, tables, sub_types, refs, mvs):
        blocks = []
        stride = self.stride
        for i in range(4):
            st = tables[sub_types[i]]
            if st is None:
                sx, sy = (i & 1) * 2, (i >> 1) * 2
                k = ((self.mb_y + 1) * 4 + sy) * stride + (self.mb_x + 1) * 4 + sx
                m0 = (self.mvx0[k], self.mvy0[k]) if self.ref0[k] >= 0 else None
                m1 = (self.mvx1[k], self.mvy1[k]) if self.ref1[k] >= 0 else None
                blocks.append((8, 8, m0, m1))
                continue
            for part in st:
                m0 = mvs[0][i] if part[2] in ("L0", "BI") else None
                m1 = mvs[1][i] if part[2] in ("L1", "BI") else None
                blocks.append((part[0], part[1], m0, m1))
        return blocks

    def _mb_intra_cavlc(self, itype):
        br = self.br
        pic = self.pic
        mb_addr = self.mb_addr
        is_pcm, is_16x16, cbp_luma, cbp_chroma, _ = i_mb_info(itype)
        pic.is_intra[mb_addr] = 1
        pic.shape[mb_addr] = 0
        if is_pcm:
            br.align()
            size = (256 + 2 * 64) * self.sps.bit_depth_luma // 8
            br.skip(size * 8)
            pic.is_pcm[mb_addr] = 1
            pic.nnz[mb_addr] = self.nnz
            self.on_mb(mb_addr, [(16, 16, None, None)], "pcm")
            return
        if is_16x16:
            self.dct8x8 = False
            pic.is_intra16[mb_addr] = 1
            pic.chroma_pred[mb_addr] = self._ue_small(3)
            cbp = cbp_luma | (cbp_chroma << 4)
        else:
            t8 = 0
            if self.slice_dct8x8:
                t8 = br.u(1)
                pic.t8x8[mb_addr] = t8
                self.dct8x8 = bool(t8)
            for _ in range(4 if t8 else 16):
                if not br.u(1):
                    br.skip(3)
            pic.chroma_pred[mb_addr] = self._ue_small(3)
            code = br.ue()
            cbp = GOLOMB_CBP_INTRA4[code] if code < 48 else 0
        self._residual_mb_cavlc(cbp, is_16x16)
        self.on_mb(mb_addr, [(16, 16, None, None)], "intra")

    # ------------------------------------------------------ 宏块：CABAC 主体
    def _mb_cabac(self, mb_addr):
        cab = self.cabac
        pic = self.pic
        pic.is_skip[mb_addr] = 0
        if not self.intra_slice:
            ctx = 0
            a = self._nb_addr(-1, 0)
            b = self._nb_addr(0, -1)
            if a >= 0 and not pic.is_skip[a]:
                ctx += 1
            if b >= 0 and not pic.is_skip[b]:
                ctx += 1
            if self.slice_type == "B":
                ctx += 13
            if cab.decision(11 + ctx):
                self._mb_skip(mb_addr)
                return
        if self.slice_type == "B":
            self._mb_b_cabac()
        elif self.slice_type == "P":
            self._mb_p_cabac()
        else:
            self._intra_mb_cabac(self._intra_mb_type_cabac(3, 1))

    def _intra_mb_type_cabac(self, ctx_base, intra_slice):
        cab = self.cabac
        pic = self.pic
        a = self._nb_addr(-1, 0)
        b = self._nb_addr(0, -1)
        if intra_slice:
            ctx = 0
            if a >= 0 and (pic.is_intra16[a] or pic.is_pcm[a]):
                ctx += 1
            if b >= 0 and (pic.is_intra16[b] or pic.is_pcm[b]):
                ctx += 1
            if cab.decision(ctx_base + ctx) == 0:
                return 0
            base = ctx_base + 2
        else:
            if cab.decision(ctx_base) == 0:
                return 0
            base = ctx_base
        if cab.terminate():
            return 25
        mb_type = 1
        mb_type += 12 * cab.decision(base + 1)
        if cab.decision(base + 2):
            mb_type += 4 + 4 * cab.decision(base + 2 + intra_slice)
        mb_type += 2 * cab.decision(base + 3 + intra_slice)
        mb_type += cab.decision(base + 3 + 2 * intra_slice)
        return mb_type

    def _mb_p_cabac(self):
        cab = self.cabac
        if cab.decision(14) == 0:
            if cab.decision(15) == 0:
                mt = 3 * cab.decision(16)
            else:
                mt = 2 - cab.decision(17)
            self._inter_mb_cabac(P_MB[mt], mt >= 3)
        else:
            self._intra_mb_cabac(self._intra_mb_type_cabac(17, 0))

    def _mb_b_cabac(self):
        cab = self.cabac
        pic = self.pic
        ctx = 0
        a = self._nb_addr(-1, 0)
        b = self._nb_addr(0, -1)
        if a < 0 or not pic.is_direct[a]:
            ctx += 1
        if b < 0 or not pic.is_direct[b]:
            ctx += 1
        if cab.decision(27 + ctx) == 0:
            blocks = self._direct_motion(True)
            pic.cbp[mb_addr] = 0
            pic.nnz[mb_addr] = self.nnz
            self.last_qscale_diff = 0
            self.on_mb(self.mb_addr, blocks, "direct")
            return
        if cab.decision(30) == 0:
            mt = 1 + cab.decision(32)
        else:
            bits = cab.decision(31) << 3
            bits += cab.decision(32) << 2
            bits += cab.decision(32) << 1
            bits += cab.decision(32)
            if bits < 8:
                mt = bits + 3
            elif bits == 13:
                self._intra_mb_cabac(self._intra_mb_type_cabac(32, 0))
                return
            elif bits == 14:
                mt = 11
            elif bits == 15:
                mt = 22
            else:
                bits = (bits << 1) + cab.decision(32)
                mt = bits - 4
        self._inter_mb_cabac(B_MB[mt], mt == 22)

    def _intra_mb_cabac(self, itype):
        cab = self.cabac
        pic = self.pic
        mb_addr = self.mb_addr
        is_pcm, is_16x16, cbp_luma, cbp_chroma, _ = i_mb_info(itype)
        pic.is_intra[mb_addr] = 1
        pic.shape[mb_addr] = 0
        if is_pcm:
            cab.align_pcm()
            size = (256 + 2 * 64) * self.sps.bit_depth_luma // 8
            cab.pos += size * 8
            pic.is_pcm[mb_addr] = 1
            pic.nnz[mb_addr] = self.nnz
            self.on_mb(mb_addr, [(16, 16, None, None)], "pcm")
            return
        if is_16x16:
            self.dct8x8 = False
            pic.is_intra16[mb_addr] = 1
            pic.chroma_pred[mb_addr] = self._chroma_pred_cabac()
            cbp = cbp_luma | (cbp_chroma << 4)
        else:
            a = self._nb_addr(-1, 0)
            b = self._nb_addr(0, -1)
            ctx = (1 if a >= 0 and pic.t8x8[a] else 0) + (1 if b >= 0 and pic.t8x8[b] else 0)
            t8 = cab.decision(399 + ctx) if self.slice_dct8x8 else 0
            pic.t8x8[mb_addr] = t8
            self.dct8x8 = bool(t8)
            for _ in range(4 if t8 else 16):
                self._intra4x4_pred_mode_cabac()
            pic.chroma_pred[mb_addr] = self._chroma_pred_cabac()
            cbp = self._cbp_cabac()
        self._residual_mb_cabac(cbp, is_16x16)
        self.on_mb(mb_addr, [(16, 16, None, None)], "intra")

    def _chroma_pred_cabac(self):
        cab = self.cabac
        pic = self.pic
        a = self._nb_addr(-1, 0)
        b = self._nb_addr(0, -1)
        ctx = 0
        if a >= 0 and pic.chroma_pred[a]:
            ctx += 1
        if b >= 0 and pic.chroma_pred[b]:
            ctx += 2
        if cab.decision(64 + ctx) == 0:
            return 0
        if cab.decision(67) == 0:
            return 1
        if cab.decision(67) == 0:
            return 2
        return 3

    def _intra4x4_pred_mode_cabac(self):
        cab = self.cabac
        if cab.decision(68):
            return
        cab.decision(69)
        cab.decision(69)
        cab.decision(69)

    def _cbp_cabac(self):
        cab = self.cabac
        left_cbp, top_cbp = self._neighbor_cbp()
        cbp = 0
        cbp += cab.decision(73 + (0 if (left_cbp & 0x02) else 1) + 2 * (0 if (top_cbp & 0x04) else 1))
        cbp += cab.decision(73 + (0 if (cbp & 0x01) else 1) + 2 * (0 if (top_cbp & 0x08) else 1)) << 1
        cbp += cab.decision(73 + (0 if (left_cbp & 0x08) else 1) + 2 * (0 if (cbp & 0x01) else 1)) << 2
        cbp += cab.decision(73 + (0 if (cbp & 0x04) else 1) + 2 * (0 if (cbp & 0x02) else 1)) << 3
        cbp_a = (left_cbp >> 4) & 3
        cbp_b = (top_cbp >> 4) & 3
        ctx = 0
        if cbp_a > 0:
            ctx += 1
        if cbp_b > 0:
            ctx += 2
        if cab.decision(77 + ctx) == 0:
            chroma = 0
        else:
            ctx = 4
            if cbp_a == 2:
                ctx += 1
            if cbp_b == 2:
                ctx += 2
            chroma = 1 + cab.decision(77 + ctx)
        return cbp | (chroma << 4)

    def _sub_type_cabac(self):
        cab = self.cabac
        if self.slice_type == "P":
            if cab.decision(21):
                return 0
            if cab.decision(22) == 0:
                return 1
            if cab.decision(23):
                return 2
            return 3
        if cab.decision(36) == 0:
            return 0
        if cab.decision(37) == 0:
            return 1 + cab.decision(39)
        t = 3
        if cab.decision(38):
            if cab.decision(39):
                return 11 + cab.decision(39)
            t += 4
        t += 2 * cab.decision(39)
        t += cab.decision(39)
        return t

    def _ref_idx_cabac(self, lst, x, y):
        cab = self.cabac
        _, _, refa = self._get_local(lst, x - 1, y)
        _, _, refb = self._get_local(lst, x, y - 1)
        ctx = 0
        if refa > 0:
            ctx += 1
        if refb > 0:
            ctx += 2
        ref = 0
        while cab.decision(54 + ctx):
            ref += 1
            ctx = (ctx >> 2) + 4
            if ref >= 32:
                break
        return ref

    def _mvd_cabac(self, lst, x, y):
        if lst == 0:
            mdx, mdy = self.mdx0, self.mdy0
        else:
            mdx, mdy = self.mdx1, self.mdy1
        i = self._blk(self.mb_x, self.mb_y, x - 1, y)
        ax, ay = mdx[i], mdy[i]
        i = self._blk(self.mb_x, self.mb_y, x, y - 1)
        bx_, by_ = mdx[i], mdy[i]
        mx = self._decode_mvd(40, ax + bx_)
        my = self._decode_mvd(47, ay + by_)
        return mx, my

    def _decode_mvd(self, ctx_base, amvd):
        cab = self.cabac
        ctx = ctx_base + (1 if amvd > 2 else 0) + (1 if amvd > 32 else 0)
        if cab.decision(ctx) == 0:
            return 0
        mvd = 1
        base = ctx_base + 3
        while mvd < 9 and cab.decision(base):
            if mvd < 4:
                base += 1
            mvd += 1
        if mvd >= 9:
            k = 3
            while cab.bypass():
                mvd += 1 << k
                k += 1
                if k > 24:
                    break
            while k:
                k -= 1
                mvd += cab.bypass() << k
        return cab.bypass_sign(-mvd)

    def _inter_mb_cabac(self, parts, is_8x8):
        cab = self.cabac
        pic = self.pic
        mb_addr = self.mb_addr
        if is_8x8:
            tables = B_SUB_MB if self.slice_type == "B" else P_SUB_MB
            sub_types = [self._sub_type_cabac() for _ in range(4)]
            if self.slice_type == "B" and 0 in sub_types:
                self._direct_motion(False)
            if self.slice_dct8x8:
                self.dct8x8 = all(self._sub_8x8_ok(tables, t) for t in sub_types)
            refs = [[-1] * 4, [-1] * 4]
            mvs = [[None] * 4, [None] * 4]
            for lst in range(self.list_count):
                rcount = self.ref_count[lst]
                for i in range(4):
                    st = tables[sub_types[i]]
                    if st is None or not self._dir_uses(st[0][2], lst):
                        continue
                    if rcount > 1:
                        refs[lst][i] = self._ref_idx_cabac(lst, 0, i)
                    else:
                        refs[lst][i] = 0
            for lst in range(self.list_count):
                for i in range(4):
                    st = tables[sub_types[i]]
                    if st is None or not self._dir_uses(st[0][2], lst):
                        continue
                    ref = refs[lst][i]
                    part = st[0]
                    bw = 2 if part[0] == 8 else 1
                    for j in range(len(st)):
                        index = 4 * i + bw * j
                        x = index & 3
                        y = index >> 2
                        mx, my = self._pred_motion(x, y, bw, lst, ref)
                        d = self._mvd_cabac(lst, x, y)
                        mx += d[0]
                        my += d[1]
                        mvs[lst][i] = (mx, my)
                        self._set_mv(lst, x, y, bw, part[1] // 4, mx, my, ref, d[0], d[1])
            pic.shape[mb_addr] = 4
            blocks = self._emit_8x8(tables, sub_types, refs, mvs)
        else:
            lists = range(self.list_count)
            refs = {}
            for lst in lists:
                rcount = self.ref_count[lst]
                for i, part in enumerate(parts):
                    if not self._dir_uses(part[2], lst):
                        continue
                    if rcount > 1:
                        if part[0] == 16 and part[1] == 16:
                            rx, ry = 0, 0
                        elif part[1] == 8:
                            rx, ry = 0, 2 * i
                        else:
                            rx, ry = 2 * i, 0
                        refs[(lst, i)] = self._ref_idx_cabac(lst, rx, ry)
                    else:
                        refs[(lst, i)] = 0
            mvs = {}
            for lst in lists:
                for i, part in enumerate(parts):
                    if not self._dir_uses(part[2], lst):
                        continue
                    ref = refs[(lst, i)]
                    if part[0] == 16 and part[1] == 16:
                        mx, my = self._pred_motion(0, 0, 4, lst, ref)
                        sx, sy, w4, h4 = 0, 0, 4, 4
                    elif part[1] == 8:
                        mx, my = self._pred_16x8_motion(i, lst, ref)
                        sx, sy, w4, h4 = 0, i * 2, 4, 2
                    else:
                        mx, my = self._pred_8x16_motion(i, lst, ref)
                        sx, sy, w4, h4 = i * 2, 0, 2, 4
                    d = self._mvd_cabac(lst, sx, sy)
                    mx += d[0]
                    my += d[1]
                    mvs[(lst, i)] = (mx, my)
                    self._set_mv(lst, sx, sy, w4, h4, mx, my, ref, d[0], d[1])
            if len(parts) == 1:
                pic.shape[mb_addr] = 1
            elif len(parts) == 2:
                pic.shape[mb_addr] = 2 if parts[0][0] == 16 else 3
            else:
                pic.shape[mb_addr] = 4
            blocks = []
            for i, part in enumerate(parts):
                m0 = mvs.get((0, i)) if part[2] in ("L0", "BI") else None
                m1 = mvs.get((1, i)) if part[2] in ("L1", "BI") else None
                blocks.append((part[0], part[1], m0, m1))

        cbp = self._cbp_cabac()
        if self.slice_dct8x8 and (cbp & 15):
            pic.t8x8[mb_addr] = 1
        self._residual_mb_cabac(cbp, False)
        self.on_mb(mb_addr, blocks, "inter")
