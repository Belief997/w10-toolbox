/**
 * grok_emoji.c — 把表情挂到 HoneyGUI：全尺寸 canvas + 帧定时器 + 按下戳一下 + 表情轮播
 *
 * 表情动作与眼形取自参考网页（grokbot.yin.wiki）的原版数据，见 grok_face_data.c 文件头的版权说明。
 *
 * PFB 分段渲染时 canvas 回调每帧会按分段调用多次，所以动画只在定时器里推进一次，
 * 绘制回调只回放当前帧的几何。
 */
#include "grok_emoji.h"
#include "grok_face.h"
#include "gui_api.h"
#include "gui_obj.h"
#include "gui_obj_event.h"
#include "gui_canvas.h"
#include "gui_fb.h"

#define GROK_FRAME_MS   16
#define GROK_HOLD_MS    6000    /* 每个表情停留时长 */

/* 轮播顺序：兴奋 → 好奇 → 困惑 → 困倦 → 计算中 → 待机，循环 */
static const grok_expr_t k_sequence[] =
{
    GROK_EXPR_EXCITED,
    GROK_EXPR_CURIOUS,
    GROK_EXPR_CONFUSED,
    GROK_EXPR_DROWSY,
    GROK_EXPR_COMPUTING,
    GROK_EXPR_IDLE,
};
#define SEQUENCE_N ((uint32_t)(sizeof(k_sequence) / sizeof(k_sequence[0])))

static uint32_t s_last_ms;
static uint32_t s_expr_ms;
static uint32_t s_seq_pos;

static void grok_canvas_draw(gui_canvas_t *canvas)
{
    grok_face_draw(canvas->vg, GUI_BASE(canvas)->w, GUI_BASE(canvas)->h);
}

static void grok_frame_tick(void *obj)
{
    GUI_UNUSED(obj);
    uint32_t now = gui_ms_get();
    if (now - s_expr_ms >= GROK_HOLD_MS)
    {
        s_expr_ms = now;
        grok_expr_t next = k_sequence[s_seq_pos];
        s_seq_pos = (s_seq_pos + 1) % SEQUENCE_N;
        grok_face_set_expression(next);
        gui_log("grok emoji -> %s\n", grok_face_expression_name(next));
    }
    grok_face_advance((float)(now - s_last_ms) / 1000.0f);
    s_last_ms = now;
    gui_fb_change();
}

static void grok_canvas_pressed(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
    grok_face_poke();
}

void grok_emoji_create(void *parent)
{
    gui_obj_t *p = GUI_BASE(parent);
    gui_canvas_t *canvas = gui_canvas_create(parent, "grok_emoji", NULL, 0, 0, p->w, p->h);
    gui_canvas_set_canvas_cb(canvas, grok_canvas_draw);
    /* 按下即触发：CLICKED 要等 300ms 排除双击才上报，戳一下会显得迟钝 */
    gui_obj_add_event_cb(canvas, grok_canvas_pressed, GUI_EVENT_TOUCH_PRESSED, NULL);

    s_last_ms = gui_ms_get();
    s_expr_ms = s_last_ms;
    s_seq_pos = 0;
    grok_face_init(s_last_ms);
    gui_obj_create_timer(GUI_BASE(canvas), GROK_FRAME_MS, true, grok_frame_tick);
    gui_obj_start_timer(GUI_BASE(canvas));
}
