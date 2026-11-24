"""图像层：NAL 循环、POC、DPB、参考帧列表、slice 切分。

输出是"图像 → 宏块分区"的事件流（on_picture / on_mb），带宽统计在
bandwidth.py 里做。
"""

from .bitstream import split_annexb
from .params import parse_sps, parse_pps, parse_slice_header
from .picture import Picture
from .mb import SliceDecoder

NAL_SLICE = (1, 2, 5)


class H264Error(Exception):
    pass


class Decoder(object):
    def __init__(self, on_picture=None, on_mb=None):
        self.on_picture = on_picture or (lambda pic: None)
        self.on_mb = on_mb or (lambda *a: None)
        self.sps_map = {}
        self.pps_map = {}
        self.dpb = []                     # 参考图像列表（Picture）
        self.pic_id = 0
        self.frame_num_wrap = {}
        self.prev_poc_msb = 0
        self.prev_poc_lsb = 0
        self.prev_frame_num = 0
        self.prev_frame_num_offset = 0
        self.decode_order = 0
        self.pictures = []
        self.warnings = []
        self.pic = None
        self.cur_sh = None
        self._cur_frame_num = 0

    # ------------------------------------------------------------------ 入口
    def decode(self, data, max_frames=None, header_only=False):
        self.header_only = header_only
        nals = split_annexb(data)
        cur = None
        for nal_ref_idc, nal_type, rbsp in nals:
            if nal_type == 7:
                sps = parse_sps(rbsp)
                self.sps_map[sps.sps_id] = sps
            elif nal_type == 8:
                pps = parse_pps(rbsp)
                self.pps_map[pps.pps_id] = pps
            elif nal_type in NAL_SLICE:
                if not self.sps_map or not self.pps_map:
                    continue
                sps = list(self.sps_map.values())[0]
                pps = list(self.pps_map.values())[0]
                sh, reader = parse_slice_header(rbsp, nal_ref_idc, nal_type, sps, pps)
                if sps.sps_id in self.sps_map:
                    sps = self.sps_map[sps.sps_id]
                if pps.pps_id in self.pps_map:
                    pps = self.pps_map[pps.pps_id]
                if sh.first_mb == 0:
                    if cur is not None:
                        self._finish_picture(cur)
                    cur = self._start_picture(sh, sps, pps)
                    if max_frames and cur.decode_index >= max_frames:
                        cur = None
                        break
                if cur is None:
                    continue
                if not header_only:
                    self._decode_slice(cur, sh, reader, sps, pps)
        if cur is not None:
            self._finish_picture(cur)
        return self.warnings

    # -------------------------------------------------------------- 图像管理
    def _start_picture(self, sh, sps, pps):
        pic = Picture(sps, pps, sh)
        pic.pic_id = self.pic_id
        self.pic_id += 1
        pic.decode_index = self.decode_order
        self.decode_order += 1
        pic.slice_type = sh.slice_type
        pic.frame_num = self._frame_num_extended(sh, sps)
        pic.poc = self._compute_poc(sh, sps)
        pic.is_ref = sh.nal_ref_idc != 0
        pic.idr = sh.idr

        if sh.idr:
            self.dpb = []
            self.prev_poc_msb = 0
            self.prev_poc_lsb = 0

        # 参考帧列表（当前图像需要，后面帧也可能要看）
        self.pic = pic
        self._cur_frame_num = pic.frame_num
        pic.ref_lists = (self._build_ref_list(sh, sps, 0), self._build_ref_list(sh, sps, 1))
        if sh.nal_ref_idc != 0:
            self._mark_refs(sh, sps, pic)
        pic.reset_slice()
        self.pictures.append(pic)
        self.pic = pic
        self.cur_sh = sh
        return pic

    def _finish_picture(self, pic):
        self.on_picture(pic)
        self.pic = None

    def colocated_picture(self):
        """B slice 的 colocated 图像 = RefPicList1[0]。"""
        if self.pic is None:
            return None
        l1 = self.pic.ref_lists[1]
        return l1[0] if l1 else None

    # ------------------------------------------------------------------- POC
    def _frame_num_extended(self, sh, sps):
        max_fn = 1 << sps.log2_max_frame_num
        if sh.idr:
            self.prev_frame_num_offset = 0
        elif self.prev_frame_num > sh.frame_num:
            self.prev_frame_num_offset += max_fn
        self.prev_frame_num = sh.frame_num
        return self.prev_frame_num_offset + sh.frame_num

    def _compute_poc(self, sh, sps):
        if sps.poc_type == 0:
            max_lsb = 1 << sps.log2_max_poc_lsb
            if sh.idr:
                msb = 0
                lsb = sh.poc_lsb
            else:
                if (sh.poc_lsb < self.prev_poc_lsb and
                        self.prev_poc_lsb - sh.poc_lsb >= max_lsb // 2):
                    msb = self.prev_poc_msb + max_lsb
                elif (sh.poc_lsb > self.prev_poc_lsb and
                        sh.poc_lsb - self.prev_poc_lsb > max_lsb // 2):
                    msb = self.prev_poc_msb - max_lsb
                else:
                    msb = self.prev_poc_msb
                lsb = sh.poc_lsb
            self.prev_poc_msb = msb
            self.prev_poc_lsb = lsb
            return msb + lsb
        if sps.poc_type == 1:
            if sh.idr:
                return 0
            fn = self.prev_frame_num_offset + sh.frame_num
            if sh.nal_ref_idc == 0:
                return 2 * (fn - len(sps.offset_for_ref_frame)) + sh.delta_poc[0]
            expected = 0
            for i in range(fn):
                expected += sps.offset_for_ref_frame[i % len(sps.offset_for_ref_frame)] \
                    if sps.offset_for_ref_frame else 0
            return expected + sh.delta_poc[0]
        return 2 * self.prev_frame_num_offset + 2 * sh.frame_num + (sh.delta_poc[0] if not sh.field_pic else 0)

    # ------------------------------------------------------------------- DPB
    def _mark_refs(self, sh, sps, pic):
        dpb = self.dpb
        if sh.idr:
            dpb[:] = []
            pic.is_long_term = False
        elif sh.adaptive_ref_pic_marking:
            for op, arg1, arg2 in sh.mmco:
                if op == 1:
                    target = pic.frame_num - arg1 - 1
                    for p in list(dpb):
                        if p.frame_num == target and not p.is_long_term:
                            dpb.remove(p)
                elif op == 2:
                    for p in list(dpb):
                        if p.is_long_term and p.long_term_idx == arg2:
                            dpb.remove(p)
                elif op == 3:
                    target = pic.frame_num - arg1 - 1
                    for p in list(dpb):
                        if p.frame_num == target and not p.is_long_term:
                            dpb.remove(p)
                    pic.is_long_term = True
                    pic.long_term_idx = arg2
                elif op == 4:
                    self._max_long_term = arg1 - 1
                elif op == 6:
                    pic.is_long_term = True
                    pic.long_term_idx = arg1
        if pic.is_long_term:
            dpb.append(pic)
            return

        # 滑动窗口：参考帧数超过 max_num_ref_frames 时丢掉 PicNum 最小的
        max_refs = max(1, sps.max_num_ref_frames)
        short = [p for p in dpb if not p.is_long_term]
        while len(short) + len([p for p in dpb if p.is_long_term]) >= max_refs and short:
            victim = min(short, key=lambda p: p.frame_num)
            dpb.remove(victim)
            short.remove(victim)
        dpb.append(pic)

    def _build_ref_list(self, sh, sps, list_id):
        if sh.slice_type in ("I", "SI"):
            return []
        if list_id == 1 and sh.slice_type != "B":
            return []
        cur_fn = self.pic.frame_num if self.pic is not None else self._cur_frame_num
        short = [p for p in self.dpb if not p.is_long_term]
        longt = [p for p in self.dpb if p.is_long_term]
        if list_id == 0:
            before = sorted([p for p in short if p.frame_num < cur_fn],
                            key=lambda p: -p.frame_num)
            after = sorted([p for p in short if p.frame_num > cur_fn],
                           key=lambda p: p.frame_num)
            refs = before + after + sorted(longt, key=lambda p: p.long_term_idx)
        else:
            before = sorted([p for p in short if p.frame_num > cur_fn],
                            key=lambda p: p.frame_num)
            after = sorted([p for p in short if p.frame_num < cur_fn],
                           key=lambda p: -p.frame_num)
            refs = before + after + sorted(longt, key=lambda p: p.long_term_idx)

        mods = sh.ref_mod_l0 if list_id == 0 else sh.ref_mod_l1
        ref_idx = 0
        for op, arg1, _ in mods:
            if op == 0:
                target = cur_fn - arg1 - 1
                found = [i for i, p in enumerate(refs)
                         if not p.is_long_term and p.frame_num == target]
            elif op == 2:
                found = [i for i, p in enumerate(refs)
                         if not p.is_long_term and p.frame_num == arg1]
            else:
                found = [i for i, p in enumerate(refs)
                         if p.is_long_term and p.long_term_idx == arg1]
            if not found:
                continue
            pic = refs.pop(found[0])
            refs.insert(min(ref_idx, len(refs)), pic)
            ref_idx += 1
        return refs

    # ------------------------------------------------------------- slice 解码
    def _decode_slice(self, pic, sh, reader, sps, pps):
        if pic.slice_type is None:
            pic.slice_type = sh.slice_type
        dec = SliceDecoder(self, sh, reader, sps, pps)
        try:
            dec.run()
        except Exception as exc:                       # noqa: BLE001
            self.warnings.append("图像 %d（%s）解析中断：%s"
                                 % (pic.decode_index, sh.slice_type, exc))
            pic.parse_error = True
