"""CABAC 算术解码器（ITU-T H.264 9.3）。

只做熵解码：本工具不解像素，只关心"每个宏块用了哪些分区、MV、参考帧"，
所以解出语法元素即可，重建过程全部省略。
"""

from . import cabac_tables as _tab
from .bitstream import BitReaderError

# 表按 16 列排过版，用之前先拍平
INIT_I = tuple(v for row in _tab.INIT_I for v in row)
INIT_PB = tuple(tuple(v for row in table for v in row) for table in _tab.INIT_PB)
LPS_RANGE = _tab.LPS_RANGE
LPS_NEXT = _tab.LPS_NEXT
MPS_NEXT = _tab.MPS_NEXT

# 上下文状态用 (pStateIdx << 1) | valMPS 表示，与 INIT_* 表一致


class Cabac(object):
    __slots__ = ("buf", "pos", "nbits", "range_", "offset", "states")

    def __init__(self, reader, states):
        # slice_data 从字节对齐处开始
        reader.align()
        self.buf = reader.buf
        self.pos = reader.pos
        self.nbits = reader.nbits
        self.range_ = 510
        self.offset = self._read_bits(9)
        self.states = states

    # --- 原始比特读取（renorm 用） ---
    def _read_bit(self):
        p = self.pos
        if p >= self.nbits:
            raise BitReaderError("CABAC 读到 RBSP 末尾之外")
        self.pos = p + 1
        return (self.buf[p >> 3] >> (7 - (p & 7))) & 1

    def _read_bits(self, n):
        val = 0
        for _ in range(n):
            val = (val << 1) | self._read_bit()
        return val

    @property
    def byte_pos(self):
        return (self.pos + 7) >> 3

    # --- 9.3.1.2 / 9.3.2 ---
    def decision(self, ctx):
        """decode_decision：返回 0/1，同时更新上下文。"""
        states = self.states
        state = states[ctx]
        r = self.range_
        lps = LPS_RANGE[(r >> 6) & 3][state >> 1]
        r -= lps
        off = self.offset
        if off < r:
            # MPS
            states[ctx] = MPS_NEXT[state]
            bit = state & 1
            while r < 256:
                r <<= 1
                off = (off << 1) | self._read_bit()
            self.range_ = r
            self.offset = off
            return bit
        # LPS
        off -= r
        r = lps
        states[ctx] = LPS_NEXT[state]
        bit = 1 - (state & 1)
        while r < 256:
            r <<= 1
            off = (off << 1) | self._read_bit()
        self.range_ = r
        self.offset = off
        return bit

    def bypass(self):
        """decode_bypass：range 不变，只把 offset 左移一位再比。"""
        r = self.range_
        off = (self.offset << 1) | self._read_bit()
        if off >= r:
            off -= r
            bit = 1
        else:
            bit = 0
        self.range_ = r
        self.offset = off
        return bit

    def bypass_bits(self, n):
        val = 0
        for _ in range(n):
            val = (val << 1) | self.bypass()
        return val

    def bypass_sign(self, value):
        """get_cabac_bypass_sign(v)：负数在前的符号位。"""
        if self.bypass():
            return -value
        return value

    def align_pcm(self):
        """I_PCM：算术解码位置对齐到字节边界。"""
        self.pos = (self.pos + 7) & ~7

    def terminate(self):
        """decode_terminate：返回 1 表示 slice 到此结束。"""
        r = self.range_ - 2
        off = self.offset
        if off >= r:
            self.range_ = r
            return 1
        if r < 256:
            r <<= 1
            off = (off << 1) | self._read_bit()
        self.range_ = r
        self.offset = off
        return 0

    def reset(self, slice_qp, cabac_init_idc, intra_slice):
        """9.3.1.1：按 slice_qp 初始化 1024 个上下文。"""
        qp = slice_qp & 0xFF
        tab = INIT_I if intra_slice else INIT_PB[cabac_init_idc]
        states = self.states
        for i in range(1024):
            m = tab[2 * i]
            n = tab[2 * i + 1]
            pre = 2 * (((m * qp) >> 4) + n) - 127
            # 9.3.1.1：preCtxState <= 63 时 pStateIdx = 63 - preCtxState 且 valMPS = 0，
            # 等价于对负数取 ~pre（不是 -pre）
            if pre < 0:
                pre = -pre - 1
            if pre > 124:
                pre = 124 + (pre & 1)
            states[i] = pre
