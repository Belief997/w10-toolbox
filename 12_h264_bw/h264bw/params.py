"""SPS / PPS / Slice Header 解析（ITU-T H.264 7.3.2 / 7.3.3）。"""

from .bitstream import BitReader, more_rbsp_data

HIGH_PROFILES = frozenset((100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135))

PROFILE_NAMES = {
    66: "Baseline",
    77: "Main",
    88: "Extended",
    100: "High",
    110: "High 10",
    122: "High 4:2:2",
    244: "High 4:4:4",
    44: "CAVLC 4:4:4",
}


class SPS(object):
    def __init__(self):
        self.sps_id = 0
        self.profile_idc = 0
        self.constraint_flags = 0
        self.level_idc = 0
        self.chroma_format_idc = 1
        self.separate_colour_plane = 0
        self.bit_depth_luma = 8
        self.bit_depth_chroma = 8
        self.log2_max_frame_num = 4
        self.poc_type = 0
        self.log2_max_poc_lsb = 4
        self.delta_pic_order_always_zero = 0
        self.offset_for_non_ref_pic = 0
        self.offset_for_top_to_bottom_field = 0
        self.offset_for_ref_frame = []
        self.max_num_ref_frames = 1
        self.gaps_in_frame_num_allowed = 0
        self.width_mbs = 0
        self.height_map_units = 0
        self.frame_mbs_only = 1
        self.mb_adaptive_frame_field = 0
        self.direct_8x8_inference = 1
        self.crop = (0, 0, 0, 0)
        self.vui_num_units_in_tick = 0
        self.vui_time_scale = 0
        self.vui_fixed_frame_rate = 0

    @property
    def width(self):
        """裁边后的显示宽度。"""
        w = self.width_mbs * 16
        left, right = self.crop[0], self.crop[1]
        sub_w = 2 if self.chroma_format_idc in (1, 2) else 1
        if self.chroma_format_idc != 0:
            w -= (left + right) * sub_w
        return w

    @property
    def height(self):
        h = self.height_map_units * 16 * (2 - self.frame_mbs_only)
        top, bottom = self.crop[2], self.crop[3]
        sub_h = 2 if self.chroma_format_idc == 1 else (1 if self.chroma_format_idc == 2 else 1)
        if self.chroma_format_idc != 0:
            h -= (top + bottom) * sub_h * (2 - self.frame_mbs_only)
        return h

    @property
    def mb_count(self):
        return self.width_mbs * self.height_map_units * (2 - self.frame_mbs_only)

    @property
    def fps(self):
        if self.vui_num_units_in_tick and self.vui_time_scale:
            return self.vui_time_scale / (2.0 * self.vui_num_units_in_tick)
        return 0.0

    def profile_name(self):
        return PROFILE_NAMES.get(self.profile_idc, "profile(%d)" % self.profile_idc)


class PPS(object):
    def __init__(self):
        self.pps_id = 0
        self.sps_id = 0
        self.entropy_coding_mode = 0
        self.bottom_field_pic_order_in_frame = 0
        self.num_slice_groups = 1
        self.num_ref_idx_l0_default = 1
        self.num_ref_idx_l1_default = 1
        self.weighted_pred = 0
        self.weighted_bipred_idc = 0
        self.pic_init_qp = 26
        self.chroma_qp_index_offset = 0
        self.second_chroma_qp_index_offset = 0
        self.deblocking_filter_control_present = 1
        self.constrained_intra_pred = 0
        self.redundant_pic_cnt_present = 0
        self.transform_8x8_mode = 0


class SliceHeader(object):
    def __init__(self):
        self.nal_ref_idc = 0
        self.nal_type = 0
        self.idr = False
        self.first_mb = 0
        self.slice_type_raw = 0
        self.slice_type = "I"          # "P" / "B" / "I" / "SP" / "SI"
        self.pps_id = 0
        self.frame_num = 0
        self.field_pic = 0
        self.bottom_field = 0
        self.idr_pic_id = 0
        self.poc_lsb = 0
        self.delta_poc_bottom = 0
        self.delta_poc = [0, 0]
        self.direct_spatial_mv_pred = 1
        self.num_ref_idx_l0 = 1
        self.num_ref_idx_l1 = 1
        self.ref_mod_l0 = []
        self.ref_mod_l1 = []
        self.luma_log2_weight_denom = 0
        self.chroma_log2_weight_denom = 0
        self.mmco = []                  # [(op, arg1, arg2), ...]
        self.long_term_reference = False
        self.adaptive_ref_pic_marking = False
        self.cabac_init_idc = 0
        self.slice_qp = 26
        self.disable_deblocking = 0
        self.slice_group_change = 0
        self.poc = 0
        self.decoder_poc = 0            # 8.2.1 的 PicOrderCnt

    def is_intra_slice(self):
        return self.slice_type in ("I", "SI")


def _read_scaling_list(r, size):
    last = 8
    nxt = 8
    for _ in range(size):
        if nxt != 0:
            delta = r.se()
            nxt = (last + delta + 256) % 256
        last = nxt if nxt != 0 else last


def parse_sps(rbsp):
    r = BitReader(rbsp)
    sps = SPS()
    sps.profile_idc = r.u(8)
    sps.constraint_flags = r.u(8)
    sps.level_idc = r.u(8)
    sps.sps_id = r.ue()
    if sps.profile_idc in HIGH_PROFILES:
        sps.chroma_format_idc = r.ue()
        if sps.chroma_format_idc == 3:
            sps.separate_colour_plane = r.u(1)
        sps.bit_depth_luma = r.ue() + 8
        sps.bit_depth_chroma = r.ue() + 8
        r.skip(1)                       # qpprime_y_zero_transform_bypass_flag
        if r.u(1):                      # seq_scaling_matrix_present_flag
            count = 8 if sps.chroma_format_idc != 3 else 12
            for i in range(count):
                if r.u(1):
                    _read_scaling_list(r, 16 if i < 6 else 64)
    sps.log2_max_frame_num = r.ue() + 4
    sps.poc_type = r.ue()
    if sps.poc_type == 0:
        sps.log2_max_poc_lsb = r.ue() + 4
    elif sps.poc_type == 1:
        sps.delta_pic_order_always_zero = r.u(1)
        sps.offset_for_non_ref_pic = r.se()
        sps.offset_for_top_to_bottom_field = r.se()
        n = r.ue()
        sps.offset_for_ref_frame = [r.se() for _ in range(n)]
    sps.max_num_ref_frames = r.ue()
    sps.gaps_in_frame_num_allowed = r.u(1)
    sps.width_mbs = r.ue() + 1
    sps.height_map_units = r.ue() + 1
    sps.frame_mbs_only = r.u(1)
    if not sps.frame_mbs_only:
        sps.mb_adaptive_frame_field = r.u(1)
    sps.direct_8x8_inference = r.u(1)
    if r.u(1):                          # frame_cropping_flag
        sps.crop = (r.ue(), r.ue(), r.ue(), r.ue())
    if r.u(1):                          # vui_parameters_present_flag
        _parse_vui(r, sps)
    return sps


def _parse_vui(r, sps):
    try:
        if r.u(1):                      # aspect_ratio_info_present_flag
            if r.u(8) == 255:
                r.skip(32)
        if r.u(1):                      # overscan_info_present_flag
            r.skip(1)
        if r.u(1):                      # video_signal_type_present_flag
            r.skip(4)
            if r.u(1):
                r.skip(24)
        if r.u(1):                      # chroma_loc_info_present_flag
            r.ue()
            r.ue()
        if r.u(1):                      # timing_info_present_flag
            sps.vui_num_units_in_tick = r.u(32)
            sps.vui_time_scale = r.u(32)
            sps.vui_fixed_frame_rate = r.u(1)
    except Exception:
        # VUI 只用来猜帧率，解析失败不影响主流程
        pass


def parse_pps(rbsp):
    r = BitReader(rbsp)
    pps = PPS()
    pps.pps_id = r.ue()
    pps.sps_id = r.ue()
    pps.entropy_coding_mode = r.u(1)
    pps.bottom_field_pic_order_in_frame = r.u(1)
    num_slice_groups = r.ue() + 1
    pps.num_slice_groups = num_slice_groups
    if num_slice_groups > 1:
        map_type = r.ue()
        if map_type == 0:
            for _ in range(num_slice_groups):
                r.ue()
        elif map_type == 2:
            for _ in range(num_slice_groups - 1):
                r.ue()
                r.ue()
        elif map_type in (3, 4, 5):
            r.skip(1)
            r.ue()
        elif map_type == 6:
            n = r.ue() + 1
            bits = max(1, (num_slice_groups - 1).bit_length())
            r.skip(n * bits)
    pps.num_ref_idx_l0_default = r.ue() + 1
    pps.num_ref_idx_l1_default = r.ue() + 1
    pps.weighted_pred = r.u(1)
    pps.weighted_bipred_idc = r.u(2)
    pps.pic_init_qp = 26 + r.se()
    r.se()                              # pic_init_qs_minus26
    pps.chroma_qp_index_offset = r.se()
    pps.deblocking_filter_control_present = r.u(1)
    pps.constrained_intra_pred = r.u(1)
    pps.redundant_pic_cnt_present = r.u(1)
    pps.second_chroma_qp_index_offset = pps.chroma_qp_index_offset
    if more_rbsp_data(r):
        pps.transform_8x8_mode = r.u(1)
        if r.u(1):                      # pic_scaling_matrix_present_flag
            count = 6 + (8 if pps.transform_8x8_mode else 0)
            for i in range(count):
                if r.u(1):
                    _read_scaling_list(r, 16 if i < 6 else 64)
        pps.second_chroma_qp_index_offset = r.se()
    return pps


SLICE_TYPE_NAMES = ("P", "B", "I", "SP", "SI")


def parse_slice_header(rbsp, nal_ref_idc, nal_type, sps, pps):
    """解析 slice header。slice_type % 5 得到帧类型；first_mb_in_slice==0 表示新图像开始。"""
    r = BitReader(rbsp)
    sh = SliceHeader()
    sh.nal_ref_idc = nal_ref_idc
    sh.nal_type = nal_type
    sh.idr = nal_type == 5
    sh.first_mb = r.ue()
    sh.slice_type_raw = r.ue()
    sh.slice_type = SLICE_TYPE_NAMES[sh.slice_type_raw % 5]
    sh.pps_id = r.ue()
    if sps.separate_colour_plane:
        r.skip(2)
    sh.frame_num = r.u(sps.log2_max_frame_num)
    if not sps.frame_mbs_only:
        sh.field_pic = r.u(1)
        if sh.field_pic:
            sh.bottom_field = r.u(1)
    if sh.idr:
        sh.idr_pic_id = r.ue()
    if sps.poc_type == 0:
        sh.poc_lsb = r.u(sps.log2_max_poc_lsb)
        if pps.bottom_field_pic_order_in_frame and not sh.field_pic:
            sh.delta_poc_bottom = r.se()
    elif sps.poc_type == 1:
        if not sps.delta_pic_order_always_zero:
            sh.delta_poc[0] = r.se()
            if pps.bottom_field_pic_order_in_frame and not sh.field_pic:
                sh.delta_poc[1] = r.se()
    if pps.redundant_pic_cnt_present:
        r.ue()
    if sh.slice_type == "B":
        sh.direct_spatial_mv_pred = r.u(1)
    if sh.slice_type in ("P", "B", "SP"):
        sh.num_ref_idx_l0 = pps.num_ref_idx_l0_default
        sh.num_ref_idx_l1 = pps.num_ref_idx_l1_default
        if r.u(1):                      # num_ref_idx_active_override_flag
            sh.num_ref_idx_l0 = r.ue() + 1
            if sh.slice_type == "B":
                sh.num_ref_idx_l1 = r.ue() + 1
    if sh.slice_type in ("P", "B", "SP"):
        _parse_ref_pic_list_modification(r, sh)
    if (pps.weighted_pred and sh.slice_type in ("P", "SP")) or \
       (pps.weighted_bipred_idc == 1 and sh.slice_type == "B"):
        _parse_pred_weight_table(r, sh, sps)
    if nal_ref_idc != 0:
        _parse_dec_ref_pic_marking(r, sh, sps)
    if pps.entropy_coding_mode and sh.slice_type not in ("I", "SI"):
        sh.cabac_init_idc = r.ue()
    sh.slice_qp = pps.pic_init_qp + r.se()
    if sh.slice_type in ("SP", "SI"):
        if sh.slice_type == "SP":
            r.skip(1)
        r.se()
    if pps.deblocking_filter_control_present:
        sh.disable_deblocking = r.ue()
        if sh.disable_deblocking != 1:
            r.se()
            r.se()
    if pps.num_slice_groups > 1:
        sh.slice_group_change = r.ue()
    sh.header_bits = r.pos
    return sh, r


def _parse_ref_pic_list_modification(r, sh):
    for list_id in (0, 1):
        if list_id == 1 and sh.slice_type != "B":
            continue
        ops = []
        if r.u(1):                      # ref_pic_list_modification_flag
            while True:
                op = r.ue()
                if op == 3:
                    break
                if op in (0, 1):
                    ops.append((op, r.ue(), 0))
                elif op == 2:
                    ops.append((op, r.ue(), 0))
                else:
                    raise ValueError("bad ref_pic_list_modification")
                if len(ops) > 66:
                    raise ValueError("too many ref_pic_list_modification ops")
        if list_id == 0:
            sh.ref_mod_l0 = ops
        else:
            sh.ref_mod_l1 = ops


def _parse_pred_weight_table(r, sh, sps):
    sh.luma_log2_weight_denom = r.ue()
    chroma_array_type = 0 if sps.separate_colour_plane else sps.chroma_format_idc
    if chroma_array_type != 0:
        sh.chroma_log2_weight_denom = r.ue()
    lists = 1 if sh.slice_type in ("P", "SP") else 2
    for list_id in range(lists):
        count = sh.num_ref_idx_l0 if list_id == 0 else sh.num_ref_idx_l1
        for _ in range(count):
            if r.u(1):
                r.se()
                r.se()
            if chroma_array_type != 0 and r.u(1):
                for _ in range(4):
                    r.se()
            if sps.bit_depth_luma > 8 and 0 and r.u(1):   # 10bit 不在本工具范围内
                pass


def _parse_dec_ref_pic_marking(r, sh, sps):
    if sh.idr:
        r.skip(2)                       # no_output_of_prior_pics_flag, long_term_reference_flag
        sh.long_term_reference = False
        return
    if r.u(1):                          # adaptive_ref_pic_marking_mode_flag
        sh.adaptive_ref_pic_marking = True
        while True:
            op = r.ue()
            if op == 0:
                break
            if op == 1:
                sh.mmco.append((op, r.ue(), 0))
            elif op == 2:
                sh.mmco.append((op, 0, r.ue()))
            elif op == 3:
                sh.mmco.append((op, r.ue(), r.ue()))
            elif op in (4, 6):
                sh.mmco.append((op, r.ue(), 0))
            elif op == 5:
                sh.mmco.append((op, 0, 0))
            else:
                raise ValueError("bad MMCO op %d" % op)
            if len(sh.mmco) > 66:
                raise ValueError("too many MMCO ops")
