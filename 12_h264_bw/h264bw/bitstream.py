"""H.264 码流读取：Annex-B 拆包、去防竞争字节（RBSP）、位读取器。"""


class BitReaderError(Exception):
    pass


class BitReader(object):
    """读 RBSP。所有位置以 bit 计。"""

    __slots__ = ("buf", "pos", "nbits")

    def __init__(self, buf, size=None):
        self.buf = buf
        self.pos = 0
        self.nbits = len(buf) * 8 if size is None else size

    def bit(self):
        p = self.pos
        if p >= self.nbits:
            raise BitReaderError("read past end of RBSP")
        self.pos = p + 1
        return (self.buf[p >> 3] >> (7 - (p & 7))) & 1

    def u(self, n):
        """无符号定长，n <= 32。"""
        p = self.pos
        end = p + n
        if end > self.nbits:
            raise BitReaderError("read past end of RBSP")
        buf = self.buf
        val = 0
        while p < end:
            byte = buf[p >> 3]
            off = p & 7
            take = 8 - off
            if take > end - p:
                take = end - p
            val = (val << take) | ((byte >> (8 - off - take)) & ((1 << take) - 1))
            p += take
        self.pos = end
        return val

    def skip(self, n):
        if self.pos + n > self.nbits:
            raise BitReaderError("skip past end of RBSP")
        self.pos += n

    def ue(self):
        """无符号指数哥伦布。"""
        p = self.pos
        nbits = self.nbits
        buf = self.buf
        zeros = 0
        while True:
            if p >= nbits:
                raise BitReaderError("truncated ue(v)")
            if (buf[p >> 3] >> (7 - (p & 7))) & 1:
                p += 1
                break
            zeros += 1
            p += 1
            if zeros > 31:
                raise BitReaderError("bad ue(v) prefix")
        val = 1
        end = p + zeros
        if end > nbits:
            raise BitReaderError("truncated ue(v) suffix")
        while p < end:
            byte = buf[p >> 3]
            off = p & 7
            take = 8 - off
            if take > end - p:
                take = end - p
            val = (val << take) | ((byte >> (8 - off - take)) & ((1 << take) - 1))
            p += take
        self.pos = p
        return val - 1

    def se(self):
        """有符号指数哥伦布。"""
        code = self.ue()
        if code & 1:
            return (code + 1) >> 1
        return -(code >> 1)

    def byte_aligned(self):
        return (self.pos & 7) == 0

    def align(self):
        """对齐到字节，返回对齐掉的 bit 数。"""
        n = (-self.pos) & 7
        self.skip(n)
        return n

    def left(self):
        return self.nbits - self.pos


def split_annexb(data):
    """把 Annex-B 字节流拆成 [(nal_ref_idc, nal_unit_type, rbsp_bytes), ...]。

    rbsp 已去掉 0x03 防竞争字节。
    """
    out = []
    n = len(data)
    i = 0
    starts = []
    while i < n - 2:
        if data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 1:
            starts.append(i + 3)
            i += 3
        else:
            i += 1
    for k, start in enumerate(starts):
        end = starts[k + 1] - 3 if k + 1 < len(starts) else n
        # 去掉尾部的 0x00 填充
        while end > start and data[end - 1] == 0:
            end -= 1
        if end <= start:
            continue
        hdr = data[start]
        nal_ref_idc = (hdr >> 5) & 3
        nal_type = hdr & 0x1F
        out.append((nal_ref_idc, nal_type, unescape_rbsp(data[start + 1:end])))
    return out


def unescape_rbsp(data):
    """去掉 0x03 防竞争字节。"""
    if data.find(b"\x00\x00\x03") < 0:
        return data
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        if i + 2 < n and data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 3:
            out.append(0)
            out.append(0)
            i += 3
        else:
            out.append(data[i])
            i += 1
    return bytes(out)


def more_rbsp_data(reader):
    """判断 RBSP 里是否还有更多数据（rbsp_stop_one_bit + 对齐 0 之后无数据）。"""
    left = reader.left()
    if left <= 0:
        return False
    # 末尾一定是 rbsp_trailing_bits：1 后跟若干 0
    p = reader.nbits - 1
    buf = reader.buf
    while p >= (reader.pos) and not ((buf[p >> 3] >> (7 - (p & 7))) & 1):
        p -= 1
    return p != reader.pos
