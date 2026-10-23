/**
 * grok_face.c — 按参考网页（grokbot.yin.wiki）的原版数据回放表情
 *
 * 运动模型与参考网页一致：每条轨道独立的贝塞尔关键帧（牛顿法解 x）、clip 洗牌调度、
 * 状态切换时由当前姿态合成 0.35s bridge 接入新 clip、表情事件驱动的眼形变形与 clip 内嵌眨眼、
 * 眼睛贴在两个眼球基向量定义的球面上并随头部四元数旋转后正交投影。
 *
 * 为控制每帧开销，眼睛轮廓直接对 21 点脊线做法向偏移得到胶囊（原版用 SDF 等值线追踪），
 * 转到背面的点压到球的轮廓上（原版沿地平线弧精确裁剪）。几何在 advance 里算好，
 * draw 只回放：身体一次 fill，眼睛是同一次 fill 里的 NVG_HOLE 子路径。
 */
#include <math.h>
#include <string.h>
#include "grok_face_internal.h"

#define GF_PI          3.14159265f
#define GF_DEG         (GF_PI / 180.0f)

#define BODY_FRAC      0.50f    /* zoom 为 1 时身体半径 = 控件短边 × 0.5（原版 radius = zoom·size/2） */
#define BODY_R         236
#define BODY_G         238
#define BODY_B         242

/* 姿态：度（pitch/yaw/roll，与原版欧拉顺序一致）、身体半径单位的位移、zoom */
typedef struct
{
    float rot[3];
    float pos[2];
    float zoom;
} gf_pose_t;

#define BAG_MAX        8

enum { MORPH_SPINE, MORPH_OVAL, MORPH_OUTLINE };
#define POKE_MAX       4
#define BOUNCE_DUR     0.62f    /* 原版 poke('bounce') 时长 */

static struct
{
    uint32_t rng;
    grok_expr_t expr;
    uint8_t bag[BAG_MAX];
    uint8_t bag_n;
    uint8_t bag_pos;
    uint8_t clip;
    uint8_t first_clip;         /* 首条 clip 随机相位起播（原版 firstPhase） */
    float clip_t;

    /* bridge：从切换时刻的姿态合成 0.35s 过渡，结束后从 pending clip 的开头起播 */
    uint8_t bridging;
    uint8_t pending_clip;
    float bridge_t;
    gf_pose_t bridge_from;
    gf_pose_t bridge_to;

    /* 表情：clip 事件或状态固定表情触发的眼形变形 */
    int8_t face;
    float morph_t;              /* >= morph_dur 表示变形结束 */
    /*
     * 变形分两条路径（原版按形状选路径）：两端都是胶囊时走 spine 路径，逐参数插值眼形描述；
     * 任一端是椭圆时走 outline 路径，逐点插值轮廓。起点都是变形开始那一刻的眼睛（可能是中间态）。
     */
    uint8_t morph_path;         /* MORPH_SPINE / MORPH_OVAL / MORPH_OUTLINE */
    gf_eye_t desc_from[2];      /* spine / oval 路径的起点 */
    gf_eye_t desc_now[2];       /* 当前眼形描述（含椭圆眼） */
    uint8_t desc_valid;         /* 当前眼睛能否用描述表示（oval / outline 变形中途为 0） */
    gf_outline_t face_from[2];  /* outline 路径的起点 */
    gf_outline_t face_now[2];   /* 当前轮廓（始终有效） */
    float inspect_from, inspect_now;
    float lids;                 /* clip 的 lids 轨道（Working_F 用它眨眼） */
    float blink_t;              /* 自最近一次眨眼起的秒数 */
    uint8_t blink_imperative;   /* 1 = 命令式 blink()，0 = clip 内嵌的眨眼事件 */
    float poke_t[POKE_MAX];     /* 正在进行的 bounce 戳一下（可叠加） */
    uint8_t npoke;

    /* advance 的输出：姿态、身体缩放与抬升（身体半径单位）、投影后的眼睛（单位球坐标，y 向上） */
    gf_pose_t pose;
    float anchor;
    float sq[2];
    float lift;
    float eye[2][GF_EYE_PTS][2];
    uint8_t eye_n[2];
} s_face;

/* ---------- 基础数学 ---------- */
static float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static float smooth01(float t)
{
    t = clampf(t, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

static float bez(float t, float p1, float p2)
{
    float u = 1.0f - t;
    return 3.0f * u * u * t * p1 + 3.0f * u * t * t * p2 + t * t * t;
}

static float bez_d(float t, float p1, float p2)
{
    float u = 1.0f - t;
    return 3.0f * u * u * p1 + 6.0f * u * t * (p2 - p1) + 3.0f * t * t * (1.0f - p2);
}

/* 三次贝塞尔缓动：牛顿迭代由 x 反解参数 t，再取 y（与原版 Qa 相同） */
static float ease_eval(const float e[4], float x)
{
    float t = x;
    for (int i = 0; i < 8; i++)
    {
        float f = bez(t, e[0], e[2]) - x;
        float d = bez_d(t, e[0], e[2]);
        if (fabsf(f) < 1e-6f || fabsf(d) < 1e-6f)
        {
            break;
        }
        t = clampf(t - f / d, 0.0f, 1.0f);
    }
    return bez(t, e[1], e[3]);
}

/* mulberry32，与原版 PRNG 相同 */
static float rng_next(void)
{
    uint32_t t = s_face.rng += 0x6D2B79F5u;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return (float)((t ^ (t >> 14)) >> 8) / 16777216.0f;
}

/* 轨道求值（原版 vt）：首帧前取首帧，末帧后取末帧，段内按本段 ease 插值；空轨道返回 0 */
static int track_eval(const gf_track_t *tr, float t, int n, float out[3])
{
    if (tr->n == 0)
    {
        return 0;
    }
    const gf_key_t *k = tr->keys;
    if (t <= k[0].t)
    {
        memcpy(out, k[0].v, sizeof(float) * (size_t)n);
        return 1;
    }
    if (t >= k[tr->n - 1].t)
    {
        memcpy(out, k[tr->n - 1].v, sizeof(float) * (size_t)n);
        return 1;
    }
    int i = 0;
    while (i < tr->n - 2 && k[i + 1].t <= t)
    {
        i++;
    }
    float w = ease_eval(k[i].ease, (t - k[i].t) / fmaxf(k[i + 1].t - k[i].t, 1e-9f));
    for (int c = 0; c < n; c++)
    {
        out[c] = k[i].v[c] + (k[i + 1].v[c] - k[i].v[c]) * w;
    }
    return 1;
}

static void clip_pose(const gf_clip_t *c, float t, gf_pose_t *p)
{
    float v[3];
    memset(p, 0, sizeof(*p));
    if (track_eval(&c->rot, t, 3, v))
    {
        memcpy(p->rot, v, sizeof(p->rot));
    }
    if (track_eval(&c->pos, t, 2, v))
    {
        memcpy(p->pos, v, sizeof(p->pos));
    }
    p->zoom = track_eval(&c->zoom, t, 1, v) ? clampf(v[0], 0.25f, 2.5f) : gf_consts.zoom_default;
}

/* clip 在 t 时刻应有的表情：最后一个 t 之前的表情事件（原版 dl） */
static int8_t clip_face_at(const gf_clip_t *c, float t)
{
    int8_t f = GF_FACE_NEUTRAL;
    for (int i = 0; i < c->nevents && c->events[i].t <= t + 1e-6f; i++)
    {
        f = c->events[i].face;
    }
    return f;
}

/* clip 静止帧的表情（原版 ul）：先取第一个表情事件，再被 restTime 之前的事件覆盖 */
static int8_t clip_rest_face(const gf_clip_t *c)
{
    int8_t f = c->nevents ? c->events[0].face : GF_FACE_NEUTRAL;
    for (int i = 0; i < c->nevents && c->events[i].t <= c->rest_time + 1e-6f; i++)
    {
        f = c->events[i].face;
    }
    return f;
}

/* ---------- 表情机（原版 Bb 的 morph 路径 + 眨眼） ---------- */
/* 眼形 f 的轮廓：按需从常量表生成（不缓存，省下约 6.5 KB RAM） */
static void face_outline(int8_t f, int side, gf_outline_t *o)
{
    gf_eye_outline(&gf_faces[f].eye[side], o);
}

static float face_inspect_weight(int8_t f)
{
    return f == GF_FACE_INSPECTING ? 1.0f : 0.0f;
}

static int face_is_oval(int8_t f)
{
    return gf_faces[f].eye[0].oval[0] > 1e-4f;
}

/* 从当前眼形出发，用 tb 缓动在 morph_dur 内变形到目标表情 */
static void face_morph_to(int8_t f)
{
    if (f == s_face.face)
    {
        return;
    }
    /*
     * 路径（原版按形状选择）：任一端是椭圆 → oval 路径；两端都是胶囊 → spine 路径；
     * 若当前正处于 oval 变形中途（没有可用的眼形描述）→ 退化为逐点插值轮廓。
     */
    s_face.morph_path = !s_face.desc_valid ? MORPH_OUTLINE :
                        (face_is_oval(f) || face_is_oval(s_face.face)) ? MORPH_OVAL : MORPH_SPINE;
    memcpy(s_face.desc_from, s_face.desc_now, sizeof(s_face.desc_from));
    memcpy(s_face.face_from, s_face.face_now, sizeof(s_face.face_from));
    s_face.inspect_from = s_face.inspect_now;
    s_face.face = f;
    s_face.morph_t = 0.0f;
}

static void face_step(float dt)
{
    const gf_face_t *to = &gf_faces[s_face.face];
    s_face.morph_t += dt;
    int done = s_face.morph_t >= gf_consts.morph_dur;
    float w = done ? 1.0f : ease_eval(gf_consts.ease_tb, s_face.morph_t / gf_consts.morph_dur);
    if (done)
    {
        memcpy(s_face.desc_now, to->eye, sizeof(s_face.desc_now));
        face_outline(s_face.face, 0, &s_face.face_now[0]);
        face_outline(s_face.face, 1, &s_face.face_now[1]);
        s_face.desc_valid = 1;
    }
    else if (s_face.morph_path == MORPH_SPINE)
    {
        for (int s = 0; s < 2; s++)
        {
            gf_eye_lerp(&s_face.desc_from[s], &to->eye[s], w, &s_face.desc_now[s]);
            gf_eye_outline(&s_face.desc_now[s], &s_face.face_now[s]);
        }
        s_face.desc_valid = 1;
    }
    else
    {
        for (int s = 0; s < 2; s++)
        {
            if (s_face.morph_path == MORPH_OVAL)
            {
                gf_eye_oval_morph(&s_face.desc_from[s], &to->eye[s], w, &s_face.face_now[s]);
            }
            else
            {
                gf_outline_t to_o;
                face_outline(s_face.face, s, &to_o);
                gf_outline_lerp(&s_face.face_from[s], &to_o, w, &s_face.face_now[s]);
            }
        }
        s_face.desc_valid = 0;
    }
    s_face.inspect_now = s_face.inspect_from + (face_inspect_weight(s_face.face) - s_face.inspect_from) * w;
}

/*
 * clip 里的眨眼事件在原版被编译成 lids 关键帧（gx）：0 → 1（+0.45·dur）→ 0（+dur），nr 缓动。
 * 命令式 blink()（戳一下）则用 ab + ii 的相位窗曲线：[0, u1] 闭合、[u1, u2] 全闭、[u2, 1] 睁开。
 */
static float blink_amount(void)
{
    float d = gf_consts.blink_dur;
    if (s_face.blink_t >= d)
    {
        return 0.0f;
    }
    float f = s_face.blink_t / d;
    if (!s_face.blink_imperative)
    {
        return f < 0.45f ? ease_eval(gf_consts.ease_nr, f / 0.45f)
                         : 1.0f - ease_eval(gf_consts.ease_nr, (f - 0.45f) / 0.55f);
    }
    float t = fminf(0.28f, gf_consts.blink_close / fmaxf(d, 0.05f));
    float u1 = (1.0f - t) * 0.42f, u2 = u1 + t;
    if (f < u1)
    {
        return smooth01(f / u1);
    }
    if (f <= u2)
    {
        return 1.0f;
    }
    return 1.0f - smooth01((f - u2) / fmaxf(1e-6f, 1.0f - u2));
}

/* 状态固定表情（如 curious 的 inspecting）优先；否则跟随 clip 的表情事件 */
static void apply_clip_events(const gf_clip_t *c, float a, float b)
{
    for (int i = 0; i < c->nblinks; i++)
    {
        if (c->blinks[i] > a && c->blinks[i] <= b && !gf_faces[s_face.face].blink_blocking)
        {
            s_face.blink_t = b - c->blinks[i];      /* 从事件时刻起算，不受帧边界影响 */
            s_face.blink_imperative = 0;
        }
    }
    if (gf_states[s_face.expr].face >= 0)
    {
        return;
    }
    for (int i = 0; i < c->nevents; i++)
    {
        if (c->events[i].t > a && c->events[i].t <= b)
        {
            face_morph_to(c->events[i].face);
        }
    }
}

/* ---------- clip 调度（原版 Nx 洗牌 + Yf 的 bridge/循环） ---------- */
static void refill_bag(void)
{
    const gf_state_t *st = &gf_states[s_face.expr];
    s_face.bag_n = st->npool < BAG_MAX ? st->npool : BAG_MAX;
    memcpy(s_face.bag, st->pool, s_face.bag_n);
    for (int i = s_face.bag_n - 1; i > 0; i--)
    {
        int j = (int)(rng_next() * (float)(i + 1));
        uint8_t tmp = s_face.bag[i];
        s_face.bag[i] = s_face.bag[j];
        s_face.bag[j] = tmp;
    }
    /* 新一轮的第一条不和刚播完的那条重复（原版 Lx） */
    for (int k = 1; k < s_face.bag_n; k++)
    {
        if (s_face.bag[0] != s_face.clip)
        {
            break;
        }
        if (s_face.bag[k] != s_face.clip)
        {
            s_face.bag[0] = s_face.bag[k];
            s_face.bag[k] = s_face.clip;
        }
    }
    s_face.bag_pos = 0;
}

static uint8_t draw_clip(void)
{
    if (s_face.bag_pos >= s_face.bag_n)
    {
        refill_bag();
    }
    return s_face.bag[s_face.bag_pos++];
}

static float angle_dist(float a, float b)
{
    return fabsf(fmodf(fmodf(a - b, 360.0f) + 540.0f, 360.0f) - 180.0f);
}

/* 原版 wx：两个姿态是否足够接近（不需要 bridge） */
static int pose_close(const gf_pose_t *a, const gf_pose_t *b)
{
    const float *tol = gf_consts.rest_tol;
    for (int i = 0; i < 3; i++)
    {
        if (angle_dist(a->rot[i], b->rot[i]) >= tol[0])
        {
            return 0;
        }
    }
    return fabsf(a->pos[0] - b->pos[0]) < tol[1] && fabsf(a->pos[1] - b->pos[1]) < tol[1] &&
           fabsf(a->zoom - b->zoom) < tol[2];
}

/* 以 clip 的静止帧为目标合成 bridge；角度取离起点最近的等价角，避免多转一圈 */
static void start_bridge(uint8_t clip)
{
    const gf_clip_t *c = &gf_clips[clip];
    s_face.bridge_from = s_face.pose;
    clip_pose(c, c->rest_time, &s_face.bridge_to);
    for (int i = 0; i < 3; i++)
    {
        float d = s_face.bridge_to.rot[i] - s_face.bridge_from.rot[i];
        s_face.bridge_to.rot[i] = s_face.bridge_from.rot[i] + d - 360.0f * roundf(d / 360.0f);
    }
    s_face.bridging = 1;
    s_face.pending_clip = clip;
    s_face.bridge_t = 0.0f;
    s_face.lids = 0.0f;
    /* 原版：bridge 开始时就把眼形变到目标 clip 静止帧的表情 */
    if (gf_states[s_face.expr].face < 0)
    {
        face_morph_to(clip_rest_face(c));
    }
}

static void begin_clip(uint8_t clip, float phase)
{
    const gf_clip_t *c = &gf_clips[clip];
    s_face.bridging = 0;
    s_face.clip = clip;
    s_face.clip_t = phase * c->duration;
    s_face.anchor = c->anchor;
    /* 起播时只补放 [0, 起播时刻] 内的表情事件；没有事件就保持当前表情（原版 seek 语义） */
    if (gf_states[s_face.expr].face < 0 && phase > 0.0f)
    {
        face_morph_to(clip_face_at(c, s_face.clip_t));
    }
    apply_clip_events(c, -1e-6f, s_face.clip_t);
}

static void play_clip(float dt)
{
    if (s_face.bridging)
    {
        s_face.bridge_t += dt;
        if (s_face.bridge_t >= gf_consts.bridge_dur)
        {
            begin_clip(s_face.pending_clip, 0.0f);
        }
        return;
    }
    const gf_clip_t *c = &gf_clips[s_face.clip];
    float a = s_face.clip_t, b = a + dt;
    if (b < c->duration)
    {
        apply_clip_events(c, a, b);
        s_face.clip_t = b;
        return;
    }
    apply_clip_events(c, a, c->duration);

    /* 一条 clip 播完：从洗牌池抽下一条；姿态接不上时插入 bridge，否则直接接续 */
    uint8_t next = draw_clip();
    const gf_clip_t *n = &gf_clips[next];
    gf_pose_t end, rest;
    clip_pose(c, c->duration, &end);
    clip_pose(n, n->rest_time, &rest);
    s_face.pose = end;
    if (next != s_face.clip || !pose_close(&end, &rest))
    {
        start_bridge(next);
        return;
    }
    float t = b - c->duration;
    begin_clip(next, 0.0f);
    apply_clip_events(n, 0.0f, t);
    s_face.clip_t = t < n->duration ? t : 0.0f;
}

/* ---------- 每帧几何 ---------- */
/* 原版 fo：(start, end) 区间内的 sin² 鼓包 */
static float bump(float x, float a, float b)
{
    if (x <= a || x >= b)
    {
        return 0.0f;
    }
    float s = sinf(GF_PI * (x - a) / (b - a));
    return s * s;
}

/* 原版 Xb 的 bounce 分支：起跳抬升 + 起落时压扁、腾空时拉长 */
static void bounce_offsets(float *lift, float sq[2])
{
    *lift = 0.0f;
    sq[0] = 1.0f;
    sq[1] = 1.0f;
    for (int i = 0; i < s_face.npoke; i++)
    {
        float a = fminf(1.0f, s_face.poke_t[i] / BOUNCE_DUR);
        float c = bump(a, 0.0f, 0.18f) + bump(a, 0.82f, 1.0f), u = bump(a, 0.18f, 0.82f);
        *lift += 0.3f * sinf(GF_PI * clampf((a - 0.14f) / 0.72f, 0.0f, 1.0f));
        sq[0] *= 1.0f + 0.08f * c - 0.04f * u;
        sq[1] *= 1.0f - 0.1f * c + 0.06f * u;
    }
}

static void update_geometry(void)
{
    if (s_face.bridging)
    {
        float w = ease_eval(gf_consts.ease_dx, clampf(s_face.bridge_t / gf_consts.bridge_dur, 0.0f, 1.0f));
        const gf_pose_t *a = &s_face.bridge_from, *b = &s_face.bridge_to;
        for (int i = 0; i < 3; i++)
        {
            s_face.pose.rot[i] = a->rot[i] + (b->rot[i] - a->rot[i]) * w;
        }
        s_face.pose.pos[0] = a->pos[0] + (b->pos[0] - a->pos[0]) * w;
        s_face.pose.pos[1] = a->pos[1] + (b->pos[1] - a->pos[1]) * w;
        s_face.pose.zoom = a->zoom + (b->zoom - a->zoom) * w;
    }
    else
    {
        const gf_clip_t *c = &gf_clips[s_face.clip];
        float v[3];
        clip_pose(c, s_face.clip_t, &s_face.pose);
        s_face.lids = track_eval(&c->lids, s_face.clip_t, 1, v) ? clampf(v[0], 0.0f, 1.0f) : 0.0f;
    }
    bounce_offsets(&s_face.lift, s_face.sq);

    float m[9];
    gf_rot_matrix(s_face.pose.rot, m);
    /* 原版：正在眨眼时用眨眼曲线，否则用 lids 轨道；弧形眼（blink_blocking）两者都不压扁 */
    float blink = blink_amount();
    float lid = gf_faces[s_face.face].blink_blocking ? 0.0f : (blink > 0.0f ? blink : s_face.lids);
    gf_outline_t eyes[2];
    memcpy(eyes, s_face.face_now, sizeof(eyes));
    gf_outline_inspect(eyes, s_face.inspect_now, s_face.pose.rot[1]);
    for (int s = 0; s < 2; s++)
    {
        gf_outline_blink(&eyes[s], lid);
        s_face.eye_n[s] = (uint8_t)gf_outline_project(&eyes[s], s, m, s_face.eye[s]);
    }
}

/* 直接把眼形设成 f（不经变形） */
static void face_set(int8_t f)
{
    s_face.face = f;
    memcpy(s_face.desc_now, gf_faces[f].eye, sizeof(s_face.desc_now));
    memcpy(s_face.desc_from, s_face.desc_now, sizeof(s_face.desc_from));
    s_face.desc_valid = 1;
    face_outline(f, 0, &s_face.face_now[0]);
    face_outline(f, 1, &s_face.face_now[1]);
    memcpy(s_face.face_from, s_face.face_now, sizeof(s_face.face_from));
    s_face.inspect_now = s_face.inspect_from = face_inspect_weight(f);
    s_face.morph_t = gf_consts.morph_dur;
}

/* ---------- 对外接口 ---------- */
void grok_face_init(uint32_t seed)
{
    memset(&s_face, 0, sizeof(s_face));
    s_face.rng = seed ? seed : 1u;
    s_face.expr = GROK_EXPR_IDLE;
    s_face.clip = 0xFF;
    face_set(GF_FACE_NEUTRAL);
    s_face.blink_t = gf_consts.blink_dur;
    begin_clip(draw_clip(), rng_next());
    update_geometry();
}

void grok_face_set_expression(grok_expr_t expr)
{
    if (expr >= GROK_EXPR_COUNT || expr == s_face.expr)
    {
        return;
    }
    s_face.expr = expr;
    s_face.bag_n = 0;
    s_face.bag_pos = 0;
    const gf_state_t *st = &gf_states[expr];
    face_morph_to(st->face >= 0 ? st->face : GF_FACE_NEUTRAL);
    /* 原版：已在播放时，从当前画面合成 bridge 接入新状态的第一条 clip */
    start_bridge(draw_clip());
}

void grok_face_debug_start(grok_expr_t expr, int index)
{
    if (expr >= GROK_EXPR_COUNT || index < 0 || index >= gf_states[expr].npool)
    {
        return;
    }
    s_face.expr = expr;
    s_face.bag_n = 0;
    s_face.bag_pos = 0;
    const gf_state_t *st = &gf_states[expr];
    face_set(st->face >= 0 ? st->face : GF_FACE_NEUTRAL);
    s_face.blink_t = gf_consts.blink_dur;
    begin_clip(st->pool[index], 0.0f);
    update_geometry();
}

/* 调试/对拍用：当前变形路径（MORPH_*），变形结束返回 -1 */
int grok_face_debug_morph_path(void)
{
    return s_face.morph_t < gf_consts.morph_dur ? s_face.morph_path : -1;
}

/* 调试/对拍用：side 眼切平面轮廓的主轴方向（度，0 = 竖直），用二阶矩估计 */
float grok_face_debug_eye_axis(int side)
{
    const gf_outline_t *o = &s_face.face_now[side & 1];
    float cx = 0.0f, cy = 0.0f, sxx = 0.0f, syy = 0.0f, sxy = 0.0f;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        cx += o->p[i][0];
        cy += o->p[i][1];
    }
    cx /= (float)GF_EYE_PTS;
    cy /= (float)GF_EYE_PTS;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        float x = o->p[i][0] - cx, y = o->p[i][1] - cy;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    return 0.5f * atan2f(2.0f * sxy, syy - sxx) * 180.0f / GF_PI;
}

/* 调试/对拍用：side 眼在 size×size 画布上投影后的高度（像素，不含身体压扁） */
int grok_face_debug_eye_height(int side, float size)
{
    if (side < 0 || side > 1 || s_face.eye_n[side] < 3)
    {
        return 0;
    }
    float y0 = 1e9f, y1 = -1e9f;
    for (int i = 0; i < s_face.eye_n[side]; i++)
    {
        y0 = fminf(y0, s_face.eye[side][i][1]);
        y1 = fmaxf(y1, s_face.eye[side][i][1]);
    }
    return (int)((y1 - y0) * BODY_FRAC * size * s_face.pose.zoom + 0.5f);
}

grok_expr_t grok_face_get_expression(void)
{
    return s_face.expr;
}

const char *grok_face_expression_name(grok_expr_t expr)
{
    return expr < GROK_EXPR_COUNT ? gf_states[expr].name : "?";
}

void grok_face_advance(float dt)
{
    dt = clampf(dt, 0.0f, gf_consts.max_advance);
    s_face.blink_t += dt;
    play_clip(dt);
    face_step(dt);

    int k = 0;
    for (int i = 0; i < s_face.npoke; i++)
    {
        s_face.poke_t[i] += dt;
        if (s_face.poke_t[i] < BOUNCE_DUR)
        {
            s_face.poke_t[k++] = s_face.poke_t[i];
        }
    }
    s_face.npoke = (uint8_t)k;
    update_geometry();
}

/* 与参考网页陈列馆一致：点击 = poke('bounce') */
void grok_face_poke(void)
{
    if (s_face.npoke < POKE_MAX)
    {
        s_face.poke_t[s_face.npoke++] = 0.0f;
    }
}

void grok_face_draw(NVGcontext *vg, float w, float h)
{
    float r = BODY_FRAC * fminf(w, h) * s_face.pose.zoom;
    float rx = r * s_face.sq[0], ry = r * s_face.sq[1];
    /* 原版 wT：中心 = size/2 + r·offset，纵向再按 squashAnchor 把压扁的身体贴住锚点 */
    float cx = 0.5f * w + r * s_face.pose.pos[0];
    float cy = 0.5f * h - r * (s_face.anchor * (1.0f - s_face.sq[1]) + s_face.pose.pos[1] + s_face.lift);

    nvgBeginPath(vg);
    nvgEllipse(vg, cx, cy, rx, ry);
    for (int e = 0; e < 2; e++)
    {
        if (s_face.eye_n[e] < 3)
        {
            continue;
        }
        nvgMoveTo(vg, cx + s_face.eye[e][0][0] * rx, cy - s_face.eye[e][0][1] * ry);
        for (int i = 1; i < s_face.eye_n[e]; i++)
        {
            nvgLineTo(vg, cx + s_face.eye[e][i][0] * rx, cy - s_face.eye[e][i][1] * ry);
        }
        nvgClosePath(vg);
        nvgPathWinding(vg, NVG_HOLE);
    }
    nvgFillColor(vg, nvgRGBA(BODY_R, BODY_G, BODY_B, 255));
    nvgFill(vg);
}
