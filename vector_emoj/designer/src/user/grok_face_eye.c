/**
 * grok_face_eye.c — 眼睛几何：轮廓生成（胶囊 / 椭圆）、逐点变形、inspecting 大小眼、眨眼压扁、球面投影
 *
 * 与参考网页的映射一致：轮廓点 (S, b)（已含 off）按眼球基向量 C（横向）、T（向上）张成切平面，
 * 经指数映射 cos|v|·M + sinc|v|·(S·C + b·T) 贴到单位球面，随头部旋转后正交投影。
 *
 * 胶囊与椭圆都采样成 GF_EYE_PTS 个点，并按「绕中心的方位角」对齐：第 i 个点都落在方位
 * π - 2π·i/N 附近（从左侧开始顺时针），所以两种形状之间逐点插值不会扭转。
 */
#include <math.h>
#include <string.h>
#include "grok_face_internal.h"

#define GF_PI 3.14159265f
#define EYE_RIM 0.985f          /* 眼睛轮廓的最大半径（单位球），留出抗锯齿余量 */

/* 胶囊：21 点脊线 + 半宽，先按法向偏移出闭合轮廓（顺序：+n 侧、末端帽、-n 侧、首端帽） */
static void capsule_raw(const gf_eye_t *e, float out[GF_EYE_PTS][2])
{
    float n[GF_SPINE_N][2];
    for (int i = 0; i < GF_SPINE_N; i++)
    {
        int a = i > 0 ? i - 1 : 0, b = i < GF_SPINE_N - 1 ? i + 1 : GF_SPINE_N - 1;
        float tx = e->pts[b][0] - e->pts[a][0], ty = e->pts[b][1] - e->pts[a][1];
        float l = sqrtf(tx * tx + ty * ty);
        if (l < 1e-6f)
        {
            tx = 0.0f;  /* 退化为一个点（inspecting 圆眼）：任取竖直方向 */
            ty = 1.0f;
            l = 1.0f;
        }
        n[i][0] = -ty / l;
        n[i][1] = tx / l;
    }
    const float r = e->wid;
    int m = 0;
    for (int i = 0; i < GF_SPINE_N; i++)
    {
        out[m][0] = e->pts[i][0] + n[i][0] * r;
        out[m][1] = e->pts[i][1] + n[i][1] * r;
        m++;
    }
    for (int side = 0; side < 2; side++)
    {
        int end = side == 0 ? GF_SPINE_N - 1 : 0;
        float nx = side == 0 ? n[end][0] : -n[end][0], ny = side == 0 ? n[end][1] : -n[end][1];
        float tx = ny, ty = -nx;    /* 端帽从 +n 绕到 -n，经过切向（向外） */
        for (int j = 1; j <= GF_CAP_PTS; j++)
        {
            float ph = GF_PI * (float)j / (float)(GF_CAP_PTS + 1);
            out[m][0] = e->pts[end][0] + r * (nx * cosf(ph) + tx * sinf(ph));
            out[m][1] = e->pts[end][1] + r * (ny * cosf(ph) + ty * sinf(ph));
            m++;
        }
        if (side == 0)
        {
            for (int i = GF_SPINE_N - 1; i >= 0; i--)
            {
                out[m][0] = e->pts[i][0] - n[i][0] * r;
                out[m][1] = e->pts[i][1] - n[i][1] * r;
                m++;
            }
        }
    }
}

/* 有符号面积 > 0 表示逆时针（y 向上） */
static float signed_area(const float p[GF_EYE_PTS][2])
{
    float s = 0.0f;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        int j = (i + 1) % GF_EYE_PTS;
        s += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    return 0.5f * s;
}

/*
 * 把任意闭合轮廓统一成：顺时针、第 0 点是绕中心方位最接近 π（正左方）的点。
 * 这样胶囊（不论脊线方向）与椭圆的第 i 个点大致处在同一方位，逐点插值不会扭转。
 */
static void canonicalize(float p[GF_EYE_PTS][2])
{
    float tmp[GF_EYE_PTS][2];
    if (signed_area(p) > 0.0f)
    {
        for (int i = 0; i < GF_EYE_PTS; i++)
        {
            tmp[i][0] = p[GF_EYE_PTS - 1 - i][0];
            tmp[i][1] = p[GF_EYE_PTS - 1 - i][1];
        }
        memcpy(p, tmp, sizeof(tmp));
    }
    float cx = 0.0f, cy = 0.0f;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        cx += p[i][0];
        cy += p[i][1];
    }
    cx /= (float)GF_EYE_PTS;
    cy /= (float)GF_EYE_PTS;
    int best = 0;
    float best_d = 1e9f;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        float a = atan2f(p[i][1] - cy, p[i][0] - cx);
        float d = GF_PI - fabsf(a);     /* 离 ±π（正左方）的角距离 */
        if (d < best_d)
        {
            best_d = d;
            best = i;
        }
    }
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        tmp[i][0] = p[(best + i) % GF_EYE_PTS][0];
        tmp[i][1] = p[(best + i) % GF_EYE_PTS][1];
    }
    memcpy(p, tmp, sizeof(tmp));
}

void gf_eye_outline(const gf_eye_t *e, gf_outline_t *o)
{
    if (e->oval[0] > 1e-4f && e->oval[1] > 1e-4f)
    {
        /* 椭圆眼（calm）：原版 SDF 在 min(oval) ≥ 0.08 时完全取椭圆，忽略脊线 */
        for (int i = 0; i < GF_EYE_PTS; i++)
        {
            float a = GF_PI - 2.0f * GF_PI * (float)i / (float)GF_EYE_PTS;
            o->p[i][0] = e->oval[0] * cosf(a);
            o->p[i][1] = e->oval[1] * sinf(a);
        }
    }
    else
    {
        capsule_raw(e, o->p);
    }
    canonicalize(o->p);
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        o->p[i][0] += e->off[0];
        o->p[i][1] += e->off[1];
    }
}

void gf_eye_lerp(const gf_eye_t *a, const gf_eye_t *b, float w, gf_eye_t *o)
{
    o->off[0] = a->off[0] + (b->off[0] - a->off[0]) * w;
    o->off[1] = a->off[1] + (b->off[1] - a->off[1]) * w;
    o->wid = a->wid + (b->wid - a->wid) * w;
    o->oval[0] = 0.0f;
    o->oval[1] = 0.0f;
    for (int i = 0; i < GF_SPINE_N; i++)
    {
        o->pts[i][0] = a->pts[i][0] + (b->pts[i][0] - a->pts[i][0]) * w;
        o->pts[i][1] = a->pts[i][1] + (b->pts[i][1] - a->pts[i][1]) * w;
    }
}

/* 原版 ns：眼睛 → 椭圆参数；ang 从 y 轴量起（竖直 = 0），椭圆眼按长轴方向取 0 或 π/2 */
typedef struct
{
    float cx, cy, ang, half_len, half_w;
} gf_ell_t;

static int eye_is_oval(const gf_eye_t *e)
{
    return e->oval[0] > 1e-4f && e->oval[1] > 1e-4f;
}

static gf_ell_t eye_ell(const gf_eye_t *e)
{
    gf_ell_t r;
    if (eye_is_oval(e))
    {
        r.cx = e->off[0];
        r.cy = e->off[1];
        r.ang = e->oval[0] >= e->oval[1] ? 0.5f * GF_PI : 0.0f;
        r.half_len = fmaxf(e->oval[0], e->oval[1]);
        r.half_w = fminf(e->oval[0], e->oval[1]);
        return r;
    }
    const float *a = e->pts[0], *b = e->pts[GF_SPINE_N - 1];
    r.cx = e->off[0] + 0.5f * (a[0] + b[0]);
    r.cy = e->off[1] + 0.5f * (a[1] + b[1]);
    r.ang = atan2f(b[0] - a[0], b[1] - a[1]);
    r.half_len = 0.5f * sqrtf((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])) + e->wid;
    r.half_w = e->wid;
    return r;
}

void gf_eye_oval_morph(const gf_eye_t *a, const gf_eye_t *b, float w, gf_outline_t *o)
{
    gf_ell_t r = eye_ell(a), t = eye_ell(b);
    float da = t.ang - r.ang;               /* 原版 Wf：角度差卷到 ±π/2 */
    while (da > 0.5f * GF_PI)
    {
        da -= GF_PI;
    }
    while (da < -0.5f * GF_PI)
    {
        da += GF_PI;
    }
    float ang = r.ang + da * w;
    float hl = fmaxf(r.half_len + (t.half_len - r.half_len) * w, 1e-4f);
    float hw = fmaxf(r.half_w + (t.half_w - r.half_w) * w, 1e-4f);
    float cx = r.cx + (t.cx - r.cx) * w, cy = r.cy + (t.cy - r.cy) * w;
    /* ovalMix：目标是椭圆时 1-(1-w)^3 快速混入，离开椭圆时 w^3 慢慢混出 */
    float from = eye_is_oval(a) ? 1.0f : 0.0f, to = eye_is_oval(b) ? 1.0f : 0.0f;
    float k = to > 0.5f ? 1.0f - (1.0f - w) * (1.0f - w) * (1.0f - w) : w * w * w;
    float mix = from + (to - from) * k;

    /*
     * 在随方位旋转的局部坐标系里（u 沿长轴、v 沿短轴）按同一个参数角 θ 采样跑道形与椭圆，
     * 逐点混合后再转回去。两者的第 i 点始终对应同一个 θ，方位转动时不会因重新排序而跳变。
     */
    float half = fmaxf(hl - hw, 0.0f);
    float au = sinf(ang), av = cosf(ang);   /* 长轴方向（从 y 轴量起的 ang） */
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        float th = GF_PI - 2.0f * GF_PI * (float)i / (float)GF_EYE_PTS;
        float c = cosf(th), s = sinf(th);
        /* 跑道形：长轴两端是半径 hw 的半圆，中间是长 2·half 的直边 */
        float su = c >= 0.0f ? half + hw * c : -half + hw * c, sv = hw * s;
        float eu = hl * c, ev = hw * s;     /* 同半轴的椭圆 */
        float u = su + (eu - su) * mix, v = sv + (ev - sv) * mix;
        /* 长轴 u 沿 (au, av)，短轴 v 沿其法向 (-av, au) */
        o->p[i][0] = cx + u * au - v * av;
        o->p[i][1] = cy + u * av + v * au;
    }
    canonicalize(o->p);
}

void gf_outline_lerp(const gf_outline_t *a, const gf_outline_t *b, float w, gf_outline_t *o)
{
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        o->p[i][0] = a->p[i][0] + (b->p[i][0] - a->p[i][0]) * w;
        o->p[i][1] = a->p[i][1] + (b->p[i][1] - a->p[i][1]) * w;
    }
}

static void outline_bounds(const gf_outline_t *o, float *x0, float *x1, float *y0, float *y1)
{
    *x0 = *y0 = 1e9f;
    *x1 = *y1 = -1e9f;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        *x0 = fminf(*x0, o->p[i][0]);
        *x1 = fmaxf(*x1, o->p[i][0]);
        *y0 = fminf(*y0, o->p[i][1]);
        *y1 = fmaxf(*y1, o->p[i][1]);
    }
}

/*
 * 原版 jb：inspecting 两眼一大一小，头转向哪边、哪边的眼睛就大。
 * u = (1 + yaw/满量程)/2，左眼按 (c/a)^u、右眼按 (a/c)^u 缩放（a、c 为两眼原始半宽）。
 * 原版缩放的是不含 off 的脊线与半宽，所以这里绕 off 缩放。
 */
void gf_outline_inspect(gf_outline_t eyes[2], float weight, float yaw_deg)
{
    if (weight < 0.001f)
    {
        return;
    }
    const gf_eye_t *ins = gf_faces[GF_FACE_INSPECTING].eye;
    float a = fmaxf(ins[0].wid, 1e-4f), c = fmaxf(ins[1].wid, 1e-4f);
    float bias = fminf(fmaxf(yaw_deg / gf_consts.inspect_yaw, -1.0f), 1.0f);
    float u = 0.5f * (1.0f + bias);
    float f[2] = { powf(c / a, u), powf(a / c, u) };
    for (int s = 0; s < 2; s++)
    {
        float h = 1.0f + (f[s] - 1.0f) * weight;
        float ox = ins[s].off[0], oy = ins[s].off[1];
        for (int i = 0; i < GF_EYE_PTS; i++)
        {
            eyes[s].p[i][0] = ox + (eyes[s].p[i][0] - ox) * h;
            eyes[s].p[i][1] = oy + (eyes[s].p[i][1] - oy) * h;
        }
    }
}

/*
 * 原版 rl：取眼睛包围盒 w×h，直接换成宽 w、高 hb = h + (w·lid_squash - h)·amount 的跑道形。
 * 每个 amount 都重新生成干净的跑道形（不与原轮廓插值），中途才不会捏出棱角。
 */
void gf_outline_blink(gf_outline_t *o, float amount)
{
    if (amount <= 0.0f)
    {
        return;
    }
    float x0, x1, y0, y1;
    outline_bounds(o, &x0, &x1, &y0, &y1);
    float w = fmaxf(x1 - x0, 1e-4f), h = fmaxf(y1 - y0, w);
    float k = fminf(amount, 1.0f);
    float hb = h + (w * gf_consts.lid_squash - h) * k;
    /*
     * 目标是宽 w、高 hb 的跑道形（原版 Nb）：hb ≥ w 时竖放，hb < w 时横放成一条缝。
     * 半宽取短边的一半，脊线沿长边。
     */
    gf_eye_t pill;
    memset(&pill, 0, sizeof(pill));
    pill.off[0] = 0.5f * (x0 + x1);
    pill.off[1] = 0.5f * (y0 + y1);
    int vertical = hb >= w;
    float lo = vertical ? w : hb, hi = vertical ? hb : w;
    pill.wid = 0.5f * lo;
    float half = 0.5f * (hi - lo);
    for (int i = 0; i < GF_SPINE_N; i++)
    {
        float s = -half + 2.0f * half * (float)i / (float)(GF_SPINE_N - 1);
        pill.pts[i][vertical ? 1 : 0] = s;
    }
    gf_eye_outline(&pill, o);
}

void gf_rot_matrix(const float rot_deg[3], float m[9])
{
    const float d = GF_PI / 180.0f;
    float cx = cosf(rot_deg[0] * d), sx = sinf(rot_deg[0] * d);
    float cy = cosf(rot_deg[1] * d), sy = sinf(rot_deg[1] * d);
    float cz = cosf(rot_deg[2] * d), sz = sinf(rot_deg[2] * d);
    /* Rz · Ry · Rx */
    m[0] = cz * cy;  m[1] = cz * sy * sx - sz * cx;  m[2] = cz * sy * cx + sz * sx;
    m[3] = sz * cy;  m[4] = sz * sy * sx + cz * cx;  m[5] = sz * sy * cx - cz * sx;
    m[6] = -sy;      m[7] = cy * sx;                 m[8] = cy * cx;
}

static void mat_vec(const float m[9], const float v[3], float o[3])
{
    o[0] = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
    o[1] = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
    o[2] = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
}

int gf_outline_project(const gf_outline_t *o, int side, const float m[9], float out[GF_EYE_PTS][2])
{
    float M[3], Cv[3], T[3];
    mat_vec(m, gf_eye_basis[side][0], M);
    mat_vec(m, gf_eye_basis[side][1], Cv);
    mat_vec(m, gf_eye_basis[side][2], T);

    int front = 0;
    for (int i = 0; i < GF_EYE_PTS; i++)
    {
        float S = o->p[i][0], b = o->p[i][1];
        float v = sqrtf(S * S + b * b);
        float k = v > 1e-6f ? sinf(v) / v : 1.0f, c = cosf(v);
        float px = c * M[0] + k * (S * Cv[0] + b * T[0]);
        float py = c * M[1] + k * (S * Cv[1] + b * T[1]);
        float pz = c * M[2] + k * (S * Cv[2] + b * T[2]);
        if (pz > 0.0f)
        {
            front++;
        }
        /*
         * 转到背面（或贴着地平线）的点压到略小于轮廓的圆上（原版沿地平线弧精确裁剪）。
         * 必须留在身体内：眼洞是 NVG_HOLE 子路径，越出身体的部分会被反向填成凸起。
         */
        float l = sqrtf(px * px + py * py);
        if ((pz <= 0.0f || l > EYE_RIM) && l > 1e-6f)
        {
            px *= EYE_RIM / l;
            py *= EYE_RIM / l;
        }
        out[i][0] = px;
        out[i][1] = py;
    }
    return front >= 3 ? GF_EYE_PTS : 0;
}
