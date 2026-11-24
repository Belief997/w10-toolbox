/*
 * mvdump —— 用 libavcodec 的 AV_CODEC_FLAG2_EXPORT_MVS 导出逐帧、逐块的
 * 运动矢量（块宽高 + 方向 + MV），供 12_h264_bw 的带宽分析使用。
 *
 * H.264 的 MV 侧数据里，一个 predicted block 一条记录：
 *   dst_x/dst_y  该块左上角在帧内的像素坐标
 *   w/h          该块的宽高（像素），即分区尺寸（16x16 / 16x8 / 8x16 / 8x8）
 *   motion_x/y   运动矢量，单位由 motion_scale 决定（H.264 为 1/4 像素时 scale=4）
 *   flags        1 = 用 list0（前向），2 = 用 list1（后向）
 *   src_x/src_y  参考块位置
 *
 * 注意（H.264 侧数据本身的限制）：
 *   - 小于 8x8 的子分区会被并到 8x8 上报
 *   - 只能区分“前向/后向”，区分不出具体用了哪一参考帧
 *
 * 输出 CSV（每行一条记录）：
 *   F,<解码序号>,<pict_type>,<码流包大小>,<key>,<w>,<h>,<显示序号>
 *   M,<解码序号>,<中心x>,<中心y>,<w>,<h>,<mvx>,<mvy>,<scale>,<source>,<src_x>,<src_y>
 *
 * 注意：dst_x/dst_y 是**块中心**（FFmpeg 这么填的），左上角要自己减 w/2、h/2；
 *      方向看 source：-1 = list0（前向），+1 = list1（后向），flags 恒为 0。
 *
 * 顺序问题：libavcodec 默认按**显示顺序**输出帧，而解码器访问 DDR 是**解码顺序**。
 * 这里把每个包的序号写进 pkt->pts，解码器会透传到输出帧的 pts 上，据此
 * 既能把帧对回它自己的码流包，也拿到了真正的解码序号。
 *
 * 构建（需要 FFmpeg shared 版的 include/ 与 lib/）：
 *   gcc -O2 -o mvdump.exe mvdump.c -I ff/include -L ff/lib \
 *       -lavformat -lavcodec -lavutil
 */
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/frame.h>
#include <libavutil/motion_vector.h>

static const char *pict_name(int t)
{
    switch (t) {
    case AV_PICTURE_TYPE_I: return "I";
    case AV_PICTURE_TYPE_P: return "P";
    case AV_PICTURE_TYPE_B: return "B";
    case AV_PICTURE_TYPE_S: return "S";
    case AV_PICTURE_TYPE_SI: return "SI";
    case AV_PICTURE_TYPE_SP: return "SP";
    case AV_PICTURE_TYPE_BI: return "BI";
    default: return "?";
    }
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "用法: %s <input> [max_frames]\n", argv[0]);
        return 2;
    }
    AVFormatContext *fmt = NULL;
    if (avformat_open_input(&fmt, argv[1], NULL, NULL) < 0) {
        fprintf(stderr, "打开失败: %s\n", argv[1]);
        return 1;
    }
    if (avformat_find_stream_info(fmt, NULL) < 0) {
        fprintf(stderr, "找不到流信息\n");
        return 1;
    }
    int vs = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vs < 0) {
        fprintf(stderr, "没有视频流\n");
        return 1;
    }
    AVStream *st = fmt->streams[vs];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) {
        fprintf(stderr, "找不到解码器\n");
        return 1;
    }
    AVCodecContext *cc = avcodec_alloc_context3(codec);
    avcodec_parameters_to_context(cc, st->codecpar);
    cc->thread_count = 1;                 /* 保证解码顺序确定 */
    cc->flags2 |= AV_CODEC_FLAG2_EXPORT_MVS;
    if (avcodec_open2(cc, codec, NULL) < 0) {
        fprintf(stderr, "打开解码器失败\n");
        return 1;
    }

    printf("# h264bw-mvdump 1\n");
    printf("# picture=%dx%d\n", cc->width, cc->height);

    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    int display_idx = 0;
    int max_frames = argc >= 3 ? atoi(argv[2]) : 0;
    int pkt_cap = 1024, pkt_n = 0;
    int *pkt_sizes = malloc(sizeof(int) * pkt_cap);

    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index != vs) {
            av_packet_unref(pkt);
            continue;
        }
        if (pkt_n >= pkt_cap) {
            pkt_cap *= 2;
            pkt_sizes = realloc(pkt_sizes, sizeof(int) * pkt_cap);
        }
        int my_idx = pkt_n;
        pkt_sizes[pkt_n++] = pkt->size;
        pkt->pts = pkt->dts = my_idx;      /* 用包序号当时间戳，解码器会原样带出 */
        if (avcodec_send_packet(cc, pkt) < 0) {
            av_packet_unref(pkt);
            continue;
        }
        av_packet_unref(pkt);
        while (avcodec_receive_frame(cc, frame) == 0) {
            if (max_frames > 0 && display_idx >= max_frames) {
                goto done;
            }
            int dec_idx = (int)frame->pts;
            int psz = (dec_idx >= 0 && dec_idx < pkt_n) ? pkt_sizes[dec_idx] : 0;
            printf("F,%d,%s,%d,%d,%d,%d,%d\n",
                   dec_idx, pict_name(frame->pict_type), psz,
                   (frame->flags & AV_FRAME_FLAG_KEY) ? 1 : 0, frame->width, frame->height,
                   display_idx);

            AVFrameSideData *sd = av_frame_get_side_data(frame, AV_FRAME_DATA_MOTION_VECTORS);
            if (sd) {
                const AVMotionVector *mvs = (const AVMotionVector *)sd->data;
                int n = sd->size / sizeof(AVMotionVector);
                for (int i = 0; i < n; i++) {
                    const AVMotionVector *mv = &mvs[i];
                    printf("M,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
                           dec_idx, mv->dst_x, mv->dst_y, mv->w, mv->h,
                           mv->motion_x, mv->motion_y, mv->motion_scale,
                           mv->source, mv->src_x, mv->src_y);
                }
            }
            display_idx++;
            av_frame_unref(frame);
        }
    }
    /* flush */
    avcodec_send_packet(cc, NULL);
    while (avcodec_receive_frame(cc, frame) == 0) {
        int dec_idx = (int)frame->pts;
        int psz = (dec_idx >= 0 && dec_idx < pkt_n) ? pkt_sizes[dec_idx] : 0;
        printf("F,%d,%s,%d,%d,%d,%d,%d\n",
               dec_idx, pict_name(frame->pict_type), psz,
               (frame->flags & AV_FRAME_FLAG_KEY) ? 1 : 0, frame->width, frame->height,
               display_idx);
        AVFrameSideData *sd = av_frame_get_side_data(frame, AV_FRAME_DATA_MOTION_VECTORS);
        if (sd) {
            const AVMotionVector *mvs = (const AVMotionVector *)sd->data;
            int n = sd->size / sizeof(AVMotionVector);
            for (int i = 0; i < n; i++) {
                const AVMotionVector *mv = &mvs[i];
                printf("M,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n",
                       dec_idx, mv->dst_x, mv->dst_y, mv->w, mv->h,
                       mv->motion_x, mv->motion_y, mv->motion_scale,
                       mv->source, mv->src_x, mv->src_y);
            }
        }
        display_idx++;
        av_frame_unref(frame);
    }

done:
    free(pkt_sizes);
    av_frame_free(&frame);
    av_packet_free(&pkt);
    avcodec_free_context(&cc);
    avformat_close_input(&fmt);
    return 0;
}
