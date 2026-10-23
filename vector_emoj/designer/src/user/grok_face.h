/**
 * grok_face.h — 表情的计算与绘制核心
 *
 * 只依赖 NanoVG，不依赖 HoneyGUI 控件层，便于脱离框架单独验证。
 * HoneyGUI 侧的挂载（canvas / 定时器 / 触摸 / 表情轮播）见 grok_emoji.c。
 */
#ifndef GROK_FACE_H
#define GROK_FACE_H

#include <stdint.h>
#include "nanovg.h"

typedef enum
{
    GROK_EXPR_IDLE,         /* 待机 */
    GROK_EXPR_EXCITED,      /* 兴奋 */
    GROK_EXPR_CURIOUS,      /* 好奇 */
    GROK_EXPR_CONFUSED,     /* 困惑 */
    GROK_EXPR_DROWSY,       /* 困倦 */
    GROK_EXPR_COMPUTING,    /* 计算中 */
    GROK_EXPR_COUNT
} grok_expr_t;

/* 重置为待机表情；seed 决定 clip 的洗牌顺序 */
void grok_face_init(uint32_t seed);

/* 推进动画 dt 秒。每帧只调用一次（不要放进 canvas 绘制回调） */
void grok_face_advance(float dt);

/* 把当前帧画到 w×h 区域中央。只回放 advance 算好的几何，可被多次调用 */
void grok_face_draw(NVGcontext *vg, float w, float h);

/* 戳一下：弹簧回弹 + 眨眼 */
void grok_face_poke(void);

/* 切换表情：姿态从当前画面过渡接入新动作，眼形逐参数变形，任意时刻切换都不跳变 */
void grok_face_set_expression(grok_expr_t expr);

grok_expr_t grok_face_get_expression(void);

const char *grok_face_expression_name(grok_expr_t expr);

/* 调试/对拍用：直接切到表情 expr，从它第 index 条 clip 的开头起播（不经 bridge） */
void grok_face_debug_start(grok_expr_t expr, int index);

#endif // GROK_FACE_H
