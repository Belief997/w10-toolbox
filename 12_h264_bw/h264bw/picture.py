"""图像级状态：运动场、宏块属性、参考帧列表。

运动场按 4x4 块存，外面留一圈 padding（左/右各 1 个宏块、上/下各 1 个），
这样块 (bx, by) 的 A/B/C 邻居就是 (bx-1, by)、(bx, by-1)、(bx+1, by-1)，
越界自动落到 padding（ref = PART_NOT_AVAILABLE，mv = 0）。
"""

PART_NOT_AVAILABLE = -2
LIST_NOT_USED = -1


class Picture(object):
    def __init__(self, sps, pps, sh=None):
        self.sps = sps
        self.pps = pps
        self.sh = sh
        self.w_mbs = sps.width_mbs
        self.h_mbs = sps.height_map_units
        self.n_mb = self.w_mbs * self.h_mbs

        self.stride = (self.w_mbs + 2) * 4          # 4x4 块为单位的行宽
        self.rows = (self.h_mbs + 2) * 4
        n = self.stride * self.rows
        self.mvx0 = [0] * n
        self.mvy0 = [0] * n
        self.ref0 = [PART_NOT_AVAILABLE] * n
        self.mvx1 = [0] * n
        self.mvy1 = [0] * n
        self.ref1 = [PART_NOT_AVAILABLE] * n
        # 残差 MV（CABAC 的 mvd 上下文要用）
        self.mdx0 = [0] * n
        self.mdy0 = [0] * n
        self.mdx1 = [0] * n
        self.mdy1 = [0] * n

        # 宏块属性
        self.is_intra = bytearray(self.n_mb)
        self.is_intra16 = bytearray(self.n_mb)
        self.is_pcm = bytearray(self.n_mb)
        self.is_skip = bytearray(self.n_mb)
        self.is_direct = bytearray(self.n_mb)
        self.shape = bytearray(self.n_mb)           # 0=intra 1=16x16 2=16x8 3=8x16 4=8x8
        self.chroma_pred = bytearray(self.n_mb)
        self.t8x8 = bytearray(self.n_mb)
        self.cbp = [0] * self.n_mb
        self.nnz = [None] * self.n_mb               # 每个 MB 的非零系数个数（CAVLC/CABAC 上下文）

        # 图像级信息
        self.poc = 0
        self.frame_num = 0
        self.is_ref = False
        self.is_long_term = False
        self.long_term_idx = -1
        self.idr = False
        self.pic_id = 0
        self.slice_type = "I"
        self.decode_index = -1
        self.display_index = -1
        self.ref_lists = ([], [])                   # (L0, L1) 里放 Picture

    # --- 4x4 块坐标 ---
    def block_index(self, mb_x, mb_y, x, y):
        return ((mb_y + 1) * 4 + y) * self.stride + (mb_x + 1) * 4 + x

    def reset_slice(self):
        """新 slice 开始时把当前图像的未解码区域标成不可用。"""
        ref0 = self.ref0
        ref1 = self.ref1
        for i in range(len(ref0)):
            ref0[i] = PART_NOT_AVAILABLE
            ref1[i] = PART_NOT_AVAILABLE
