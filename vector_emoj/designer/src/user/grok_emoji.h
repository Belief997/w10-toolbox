/**
 * grok_emoji.h — 待机表情的 HoneyGUI 挂载入口
 */
#ifndef GROK_EMOJI_H
#define GROK_EMOJI_H

/* 在 parent（通常是 GrokMainView）上铺一块同尺寸 canvas，从待机开始，依次轮播兴奋/好奇/困惑/困倦 */
void grok_emoji_create(void *parent);

#endif // GROK_EMOJI_H
