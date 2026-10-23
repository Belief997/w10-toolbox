/* grok_face_ids.h — 由 tools/gen_grok_face_data.mjs 生成，请勿手改 */
#ifndef GROK_FACE_IDS_H
#define GROK_FACE_IDS_H

enum
{
    GF_CLIP_IDLE_B,
    GF_CLIP_IDLE_D,
    GF_CLIP_IDLE_A,
    GF_CLIP_DONE_C,
    GF_CLIP_WORKING_B,
    GF_CLIP_BLOCKED_A,
    GF_CLIP_BLOCKED_C,
    GF_CLIP_WORKING_A,
    GF_CLIP_WORKING_C,
    GF_CLIP_WORKING_D,
    GF_CLIP_WORKING_E,
    GF_CLIP_WORKING_F,
    GF_CLIP_COUNT
};

enum
{
    GF_FACE_NEUTRAL,
    GF_FACE_INSPECTING,
    GF_FACE_HAPPY,
    GF_FACE_SURPRISED,
    GF_FACE_CONFUSED,
    GF_FACE_SLEEPY,
    GF_FACE_CALM,
    GF_FACE_COUNT
};

#define GF_SPINE_N 21

#endif // GROK_FACE_IDS_H
