/**
 * grok_face_internal.h — 表情核心的内部类型
 *
 * 数据表 grok_face_data.c / grok_face_ids.h 由 tools/gen_grok_face_data.mjs 从参考网页的
 * grok-recipes.json 生成；调度、表情过渡与绘制在 grok_face.c。
 */
#ifndef GROK_FACE_INTERNAL_H
#define GROK_FACE_INTERNAL_H

#include <stdint.h>
#include "grok_face.h"
#include "grok_face_ids.h"

/* 一个关键帧；ease 作用于「本关键帧 → 下一关键帧」这一段，y 可超出 [0,1] */
typedef struct
{
    float t;
    float v[3];         /* position 用前 2 个（身体半径），rotation 用 3 个（度，pitch/yaw/roll），zoom 用 1 个 */
    float ease[4];
} gf_key_t;

typedef struct
{
    const gf_key_t *keys;
    uint8_t n;
} gf_track_t;

typedef struct
{
    float t;
    int8_t face;        /* GF_FACE_* */
} gf_event_t;

typedef struct
{
    const char *name;
    float duration;
    float rest_time;    /* clip 的静止帧时刻（bridge 的目标） */
    float anchor;       /* squashAnchor：缩放时身体的锚点 */
    gf_track_t pos, rot, zoom, lids;    /* lids：眼睑闭合量 0..1，与眨眼同样压扁眼睛 */
    const float *blinks;
    uint8_t nblinks;
    const gf_event_t *events;
    uint8_t nevents;
} gf_clip_t;

/*
 * 眼睛：沿 21 点脊线、半宽为 wid 的胶囊；oval 非零时改为半轴 oval[0]×oval[1] 的椭圆（calm）。
 * 坐标是该眼球切平面上的弧度。
 */
typedef struct
{
    float off[2];
    float wid;
    float oval[2];
    float pts[GF_SPINE_N][2];
} gf_eye_t;

typedef struct
{
    const char *name;
    uint8_t blink_blocking;     /* 弧形眼：不允许眨眼压扁 */
    gf_eye_t eye[2];
} gf_face_t;

typedef struct
{
    const char *name;
    const uint8_t *pool;        /* clip 洗牌池，重复条目即权重 */
    uint8_t npool;
    int8_t face;                /* 状态固定的表情（-1 = 跟随 clip 的表情事件） */
} gf_state_t;

typedef struct
{
    float blink_dur;            /* 0.26s */
    float blink_close;          /* 眨眼闭合段时长，决定全闭保持的相位窗（原版 ob） */
    float morph_dur;            /* 表情变形 0.28s */
    float bridge_dur;           /* 状态切换过渡 0.35s */
    float zoom_default;         /* 0.6 */
    float lid_squash;           /* 闭眼时宽度保留比例 Ab */
    float inspect_yaw;          /* inspecting 大小眼随 yaw 偏向的满量程（度） */
    float max_advance;
    float ease_nr[4];
    float ease_tb[4];           /* 表情变形缓动 */
    float ease_dx[4];           /* bridge 缓动 */
    float rest_tol[4];          /* 静止帧相似判定：rotDeg / pos / zoom / lids */
} gf_consts_t;

extern const gf_clip_t gf_clips[GF_CLIP_COUNT];
extern const gf_face_t gf_faces[GF_FACE_COUNT];
extern const gf_state_t gf_states[GROK_EXPR_COUNT];
extern const float gf_eye_basis[2][3][3];
extern const gf_consts_t gf_consts;

/* ---------- 眼睛几何（grok_face_eye.c） ---------- */
#define GF_CAP_PTS  8                                   /* 胶囊每个端帽的内部采样点 */
#define GF_EYE_PTS  (2 * GF_SPINE_N + 2 * GF_CAP_PTS)

/*
 * 一只眼睛在切平面上的闭合轮廓（已加上 off），胶囊和椭圆都用同样的点数与起止方位，
 * 所以表情变形、大小眼缩放、眨眼都能在轮廓上逐点完成，胶囊 ↔ 椭圆也不会跳变。
 */
typedef struct
{
    float p[GF_EYE_PTS][2];
} gf_outline_t;

/* 眼形描述 → 轮廓 */
void gf_eye_outline(const gf_eye_t *e, gf_outline_t *o);

/* 两个胶囊眼形逐参数插值（原版 spine 路径 _b：脊线点、半宽、off 线性插值） */
void gf_eye_lerp(const gf_eye_t *a, const gf_eye_t *b, float w, gf_eye_t *o);

/*
 * 原版 oval 路径（Rb）：两端各化成 {中心, 方位, 半长, 半宽}，逐参数插值出一个斜放的跑道形，
 * 再按 ovalMix 混向同尺寸的椭圆。用于任一端是椭圆眼（calm）的变形。
 */
void gf_eye_oval_morph(const gf_eye_t *a, const gf_eye_t *b, float w, gf_outline_t *o);

void gf_outline_lerp(const gf_outline_t *a, const gf_outline_t *b, float w, gf_outline_t *o);

/* inspecting 大小眼：随头部 yaw 在两眼间转移大小（绕各自中心缩放），weight 为 inspecting 表情的权重 */
void gf_outline_inspect(gf_outline_t eyes[2], float weight, float yaw_deg);

/* 眨眼 / 眼睑：轮廓按包围盒变成纵向压扁的竖直胶囊，amount 0..1（原版 rl） */
void gf_outline_blink(gf_outline_t *o, float amount);

/* 欧拉角（度，pitch/yaw/roll）→ 头部旋转矩阵 Rz·Ry·Rx（与原版四元数顺序一致） */
void gf_rot_matrix(const float rot_deg[3], float m[9]);

/* 把轮廓贴到第 side 只眼球上、随头部旋转后正交投影；返回点数，整只眼睛在背面时返回 0 */
int gf_outline_project(const gf_outline_t *o, int side, const float m[9], float out[GF_EYE_PTS][2]);

#endif // GROK_FACE_INTERNAL_H
