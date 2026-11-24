#include "support.h"

#include <string.h>
#include <math.h>
#include "json_scan.h"

#include "gui_text.h"
#include "gui_scroll_text.h"
#include "gui_img.h"
#include "gui_view.h"
#include "ui_common.h"

#ifndef _HONEYGUI_SIMULATOR_
#include "rtl_ppe.h"
#include "cache.h"
#include "acc_sw_jpeg.h"
#endif
/*============================================================================*
 *              Resource package parsing  (protocol V1.7 sec.8)
 *
 * One entry point: (address, size) of a whole package in, the json's members
 * out.  Nothing is copied, nothing is allocated, no buffer is owned.
 *
 * The document is walked ONCE and that is the whole job.  Resources are binary
 * and are not touched: their offsets come from "resOff", so this module never
 * inspects, decodes or classifies them -- a caller appends the offset to base
 * and gets the bytes.
 *============================================================================*/

/*============================================================================*
 *                          Value coercion
 *============================================================================*/

/** #RRGGBB -> 0xFFRRGGBB.  Anything else (empty, short, not hex) is reported
 *  through the bool so the caller can tell "" from "#000000". */
static bool sup_parse_color(const char *str, uint32_t *out)
{
    uint32_t v = 0;
    int digits = 0;

    if (str == NULL || str[0] == '\0') { return false; }
    if (str[0] == '#') { str++; }

    for (; str[digits] != '\0'; digits++)
    {
        char c = str[digits];
        int d;
        if (c >= '0' && c <= '9') { d = c - '0'; }
        else if (c >= 'a' && c <= 'f') { d = c - 'a' + 10; }
        else if (c >= 'A' && c <= 'F') { d = c - 'A' + 10; }
        else { return false; }
        v = (v << 4) | (uint32_t)d;
        if (digits == 5) { break; }
    }
    if (digits != 5) { return false; }        /* exactly six hex digits */

    *out = 0xFF000000u | v;
    return true;
}

static sup_bg_fx_t sup_bg_fx_from(const char *s)
{
    if (strcmp(s, "breathe") == 0) { return SUP_BG_FX_BREATHE; }
    if (strcmp(s, "pulse")   == 0) { return SUP_BG_FX_PULSE; }
    if (strcmp(s, "open")    == 0) { return SUP_BG_FX_OPEN; }
    if (strcmp(s, "blur")    == 0) { return SUP_BG_FX_BLUR; }
    if (strcmp(s, "rotate")  == 0) { return SUP_BG_FX_ROTATE; }
    return SUP_BG_FX_NONE;                    /* "none" and anything unknown */
}

static sup_text_fx_t sup_text_fx_from(const char *s)
{
    if (strcmp(s, "scroll")    == 0) { return SUP_TEXT_FX_SCROLL; }
    if (strcmp(s, "multiline") == 0) { return SUP_TEXT_FX_MULTILINE; }
    if (strcmp(s, "blink")     == 0) { return SUP_TEXT_FX_BLINK; }
    if (strcmp(s, "rainbow")   == 0) { return SUP_TEXT_FX_RAINBOW; }
    return SUP_TEXT_FX_STATIC;                /* "static" and anything unknown */
}

/*============================================================================*
 *                          json -> sup_pkg_t
 *
 * Defaults first, then let the document override them.  Every key is optional
 * (sec.8 marks only the colours' fallbacks, but a package that omits a field
 * should render with what the table calls its default rather than fail), so
 * there is exactly one place that decides a value the json left out.
 *============================================================================*/

static int sup_read_res_offsets(jsn_t *j, sup_pkg_t *p)
{
    int v;

    if (jsn_array_begin(j) != JSN_OK) { return JSN_ERR; }

    p->res_cnt = 0;
    while (jsn_array_next(j) == JSN_OK)
    {
        if (jsn_read_int(j, &v) != JSN_OK) { return JSN_ERR; }

        /* Over capacity is a hard error, not a truncation: the caller would
         * otherwise silently see fewer resources than the package declares and
         * render a different picture than the one that was sent. */
        if (p->res_cnt >= SUP_RES_MAX)
        {
            gui_log("support: resOff has more than %d entries, package rejected\n",
                    SUP_RES_MAX);
            return JSN_ERR;
        }

        p->res_off[p->res_cnt] = (v < 0) ? 0u : (uint32_t)v;
        p->res_cnt++;
    }
    return JSN_OK;
}

static int sup_parse_json(const uint8_t *data, uint32_t size, sup_pkg_t *p)
{
    jsn_t j;
    char key[24];
    char buf[32];                    /* scratch for enum-ish string values */
    int rc;

    p->text[0]      = '\0';
    p->font_size    = 40;
    p->text_color   = 0xFFFFFFFFu;
    p->stroke_color = 0xFF000000u;
    p->has_stroke   = false;
    p->bg_color     = 0xFFFFFFFFu;
    p->bg_fx        = SUP_BG_FX_NONE;
    p->text_fx      = SUP_TEXT_FX_STATIC;
    p->res_cnt      = 0;

    jsn_init(&j, data, size);
    if (jsn_object_begin(&j) != JSN_OK) { return SUP_E_JSON; }

    while ((rc = jsn_object_next(&j, key, sizeof(key))) == JSN_OK)
    {
        if (strcmp(key, "text") == 0)
        {
            if (jsn_read_string(&j, p->text, sizeof(p->text)) != JSN_OK)
            {
                return SUP_E_JSON;
            }
        }
        else if (strcmp(key, "fontSize") == 0)
        {
            int v = 0;
            if (jsn_read_int(&j, &v) == JSN_OK)
            {
                if (v < 16) { v = 16; }
                if (v > 72) { v = 72; }
                p->font_size = (uint8_t)v;
            }
            else
            {
                jsn_skip_value(&j);
            }
        }
        else if (strcmp(key, "textColor") == 0)
        {
            if (jsn_read_string(&j, buf, sizeof(buf)) == JSN_OK)
            {
                (void)sup_parse_color(buf, &p->text_color);
            }
        }
        else if (strcmp(key, "strokeColor") == 0)
        {
            if (jsn_read_string(&j, buf, sizeof(buf)) == JSN_OK)
            {
                p->has_stroke = sup_parse_color(buf, &p->stroke_color);
                if (!p->has_stroke) { p->stroke_color = 0xFF000000u; }
            }
        }
        else if (strcmp(key, "bgColor") == 0)
        {
            if (jsn_read_string(&j, buf, sizeof(buf)) == JSN_OK)
            {
                (void)sup_parse_color(buf, &p->bg_color);
            }
        }
        else if (strcmp(key, "bgFx") == 0)
        {
            if (jsn_read_string(&j, buf, sizeof(buf)) == JSN_OK)
            {
                p->bg_fx = sup_bg_fx_from(buf);
            }
        }
        else if (strcmp(key, "textFx") == 0)
        {
            if (jsn_read_string(&j, buf, sizeof(buf)) == JSN_OK)
            {
                p->text_fx = sup_text_fx_from(buf);
            }
        }
        else if (strcmp(key, "resOff") == 0)
        {
            /* Present but not an array is a broken package, not a package with
             * no resources: report it rather than silently reporting zero. */
            if (!jsn_is_array(&j) || sup_read_res_offsets(&j, p) != JSN_OK)
            {
                return SUP_E_JSON;
            }
        }
        else
        {
            /* Anything a later protocol revision adds. */
            jsn_skip_value(&j);
        }
    }

    return (rc == JSN_END) ? SUP_OK : SUP_E_JSON;
}

/*============================================================================*
 *                          Entry point
 *============================================================================*/

int sup_pkg_parse(const void *data, uint32_t size, sup_pkg_t *out)
{
    if (out == NULL) { return SUP_E_ARG; }
    memset(out, 0, sizeof(*out));

    if (data == NULL || size == 0) { return SUP_E_ARG; }

    out->base = (const uint8_t *)data;
    out->size = size;

    int rc = sup_parse_json(out->base, size, out);
    if (rc != SUP_OK)
    {
        /* A failed parse leaves nothing usable behind: a caller that ignores
         * the return code must not get a half-filled struct to render. */
        memset(out, 0, sizeof(*out));
    }
    return rc;
}


// UI 
sup_pkg_t *pkg_d = NULL;
sup_pkg_t * sup_dbg_param(void)
{
    if(pkg_d) return pkg_d;

    pkg_d = gui_malloc(sizeof(sup_pkg_t));
    memset(pkg_d, 0, sizeof(*pkg_d));

    // uint32_t base = 0x70536400;
    uint32_t base = 0x01;

    const char *sig_line = "一起为你发光";
    const char *mul_line = "一起\n为你\n发光";

    GUI_UNUSED(sig_line);
    GUI_UNUSED(mul_line);

    memcpy(pkg_d->text, mul_line, sizeof(pkg_d->text));
    pkg_d->font_size = 96;
    pkg_d->text_color = 0xFFFF0000; // #FF0000
    pkg_d->stroke_color = 0;
    pkg_d->bg_color = 0xff7300ff;// #7300ff;
    pkg_d->bg_fx = SUP_BG_FX_ROTATE;
    pkg_d->text_fx = SUP_TEXT_FX_SCROLL;

    pkg_d->res_cnt = 4;
    pkg_d->res_off[0] = 0;
#ifdef _HONEYGUI_SIMULATOR_
    const char *file_pointer = "/MiSans_Medium_vector.bin";
    void *data = NULL; int size = 0;
    gui_vfs_file_t *f = NULL;
     
    do{
        f = gui_vfs_open((const char *)file_pointer, GUI_VFS_READ);
        GUI_ASSERT(f != NULL);
        gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
        size = gui_vfs_tell(f);

        gui_log(" %s %d\n", __FUNCTION__, __LINE__);
        if (size <= 0)
        {
            gui_log("size err %s\n", file_pointer);
            gui_vfs_close(f);
            break;
        }
        gui_vfs_seek(f, 0, GUI_VFS_SEEK_SET);
        data = gui_malloc(size);
        GUI_ASSERT(data != NULL);
        gui_vfs_read(f, (void *)data, size);
        gui_vfs_close(f);

        pkg_d->res_off[1] = (uint32_t)(uintptr_t)data - base;
        gui_log("font 0x%x  off %d size %d\n", data, pkg_d->res_off[1], size);
    }while(0);
    

    file_pointer = "/images/wp-3.bin";
    data = NULL; size = 0;
    f = gui_vfs_open((const char *)file_pointer, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    size = gui_vfs_tell(f);

    if (size <= 0)
    {
        gui_log("size err %s\n", file_pointer);
        gui_vfs_close(f);
        return NULL;
    }
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_SET);
    data = gui_malloc(size);
    GUI_ASSERT(data != NULL);
    gui_vfs_read(f, (void *)data, size);
    gui_vfs_close(f);

    pkg_d->res_off[2] = (uint32_t)(uintptr_t)data - base;
    gui_log("image 0x%x %p off %d size %d\n", data, data, pkg_d->res_off[2], size);


    file_pointer = "/images/wp-3-ring.bin";
    data = NULL; size = 0;
    f = gui_vfs_open((const char *)file_pointer, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    size = gui_vfs_tell(f);

    if (size <= 0)
    {
        gui_log("size err %s\n", file_pointer);
        gui_vfs_close(f);
        return NULL;
    }
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_SET);
    data = gui_malloc(size);
    GUI_ASSERT(data != NULL);
    gui_vfs_read(f, (void *)data, size);
    gui_vfs_close(f);

    pkg_d->res_off[3] = (uint32_t)(uintptr_t)data - base;
    gui_log("image 0x%x %p off %d size %d\n", data, data, pkg_d->res_off[3], size);
#else
    const char *file_pointer = "/MiSans_Medium_vector.bin";
    pkg_d->res_off[1] =  (uint32_t)gui_vfs_get_file_address(file_pointer) - base;
    file_pointer = "/images/wp-3.bin";
    pkg_d->res_off[2] = (uint32_t)gui_vfs_get_file_address(file_pointer) - base; 
    file_pointer = "/images/wp-3-ring.bin";
    pkg_d->res_off[3] = (uint32_t)gui_vfs_get_file_address(file_pointer) - base; 

#endif

    return pkg_d;
}


/*============================================================================*
 *                          Cheer text effects
 *============================================================================*/

#define SUP_TICK_MS             20      /* ~33 fps; 24 fps is the preview rate */
#define SUP_SCROLL_SPEED        116.5f  /* 466 canvas, width / 4 per second    */
#define SUP_SCROLL_SPEED_RAINBOW 295.0f /* 466 canvas px/s                     */
#define SUP_ROLL_SPEED          215.0f  /* 466 canvas px/s                     */
#define SUP_RAINBOW_DEG_PER_SEC 36.0f   /* one full hue turn in 10 s           */
#define SUP_BLINK_CYCLE_MS      1000.0f /* opacity 1 -> 0 -> 1                 */


typedef struct
{
    gui_text_t *text;
    int16_t     width;      /* char_width_sum after layout              */
    int16_t     row_y;      /* top of this row, relative to the block    */
    float       x;          /* current left edge, for the scrolling ones */
    float       speed_mul;  /* 1 + i * 0.4 for a multi-line marquee      */
} sup_line_t;

typedef struct
{
    mainface_src_t *config;
    gui_obj_t      *parent;
    gui_obj_t      *root;
    float          scale;

    gui_win_t      *bg_win;
    gui_win_t      *bg_blur_win;
    gui_win_t      *bg_win_0;
    gui_win_t      *bg_win_1;
    gui_img_t      *bg_img;
    gui_img_t      *bg_ring_img;
    uint32_t        bg_color;

    sup_line_t      line[SUP_CHEER_LINES_MAX];
    uint8_t         count;
    int16_t         row_h;
    int16_t         block_h;
    int16_t         block_y;

    char            text_copy[SUP_CHEER_TEXT_MAX];

    float           phase_ms;
    float           scroll_x;
    float           roll;
    uint8_t         hue;
    uint32_t        last_ms;
    sup_bg_fx_t     bg_fx;
} sup_cheer_t;

static sup_cheer_t s_cheer;

static uint8_t sup_split_lines(const char *src, char *dst, uint16_t dst_size,
                               char *out[SUP_CHEER_LINES_MAX])
{
    uint8_t n = 0;
    char *p;
    uint16_t len;

    if (src == NULL || dst == NULL || dst_size == 0) { return 0; }

    /* strncpy semantics without the warning: copy at most dst_size - 1 bytes
     * and always terminate.  A source longer than the buffer is truncated, which
     * is what the caller's SUP_CHEER_TEXT_MAX copy already did. */
    for (len = 0; len + 1 < dst_size && src[len] != '\0'; len++)
    {
        dst[len] = src[len];
    }
    dst[len] = '\0';

    p = dst;
    while (*p != '\0' && n < SUP_CHEER_LINES_MAX)
    {
        char *start;
        char *end;

        while (*p == '\n') { p++; }              /* skip empty lines */
        if (*p == '\0') { break; }

        start = p;
        while (*p != '\0' && *p != '\n') { p++; }
        end = p;
        if (*p == '\n') { *p++ = '\0'; }

        while (start < end && (*start == ' ' || *start == '\t')) { start++; }
        while (end > start && (end[-1] == ' ' || end[-1] == '\t')) { end--; }
        *end = '\0';

        if (*start != '\0') { out[n++] = start; }
    }
    return n;
}

/** HSL(hue, 1.0, 0.5) -> ARGB8888, via the same sector formula the editing
 *  page's _inkColor() uses. */
static uint32_t sup_rainbow_color(uint8_t hue)
{
    const float s = 1.0f;
    const float l = 0.5f;
    const float a = s * ((l < 1.0f - l) ? l : 1.0f - l);
    uint8_t rgb[3];

    /* channels 0,8,4 are R,G,B in the description's compact form */
    static const uint8_t chan[3] = { 0, 8, 4 };

    for (int i = 0; i < 3; i++)
    {
        float h = (float)hue / 30.0f;
        float k = (float)((chan[i] + (int)h) % 12);
        float m;
        float v;

        /* max(min(k-3, 9-k, 1), -1) */
        m = k - 3.0f;
        if (9.0f - k < m) { m = 9.0f - k; }
        if (1.0f < m)     { m = 1.0f; }
        if (-1.0f > m)    { m = -1.0f; }

        v = l - a * m;
        if (v < 0.0f) { v = 0.0f; }
        if (v > 1.0f) { v = 1.0f; }
        rgb[i] = (uint8_t)(v * 255.0f + 0.5f);
    }
    return 0xFF000000u | ((uint32_t)rgb[0] << 16) |
           ((uint32_t)rgb[1] << 8) | (uint32_t)rgb[2];
}

/** Apply @p alpha to the widget's text colour.  Both font backends multiply
 *  text->color's alpha into every glyph, so this is the portable way to fade
 *  text -- it does not depend on which renderer this build selected. */
static void sup_line_alpha(sup_line_t *ln, uint32_t rgb, uint8_t alpha)
{
    gui_color_t c;

    c.color.argb_full = (rgb & 0x00FFFFFFu) | ((uint32_t)alpha << 24);
    gui_text_color_set(ln->text, c);
}

/*----------------------------------------------------------------------------*
 *  Per-effect tick handlers.
 *----------------------------------------------------------------------------*/

/**
 * multiline -- the whole block rolls bottom to top, wrapping after it has
 * cleared the top.  Every line stays horizontally centred (the widget is the
 * full canvas width and the text mode centres within it).
 */
static void sup_fx_multiline(sup_cheer_t *c, float dt_ms)
{
    int16_t canvas = (int16_t)c->parent->h;
    float span = (float)c->block_h + (float)canvas;

    c->roll += SUP_ROLL_SPEED * dt_ms / 1000.0f;
    if (span > 0.0f)
    {
        while (c->roll >= span) { c->roll -= span; }
    }

    /* starts below the canvas, climbs to just above it */
    int16_t y0 = (int16_t)((float)canvas - c->roll);
    for (uint8_t i = 0; i < c->count; i++)
    {
        gui_text_move((gui_text_t *)c->line[i].text, 0,
                     (int)y0 + c->line[i].row_y);
    }
}

/** blink -- opacity follows a cosine over a one-second cycle. */
static void sup_fx_blink(sup_cheer_t *c, uint32_t rgb)
{
    float sec = c->phase_ms / 1000.0f;
    float cs = cosf(sec * 6.28318530718f);
    uint8_t a = (uint8_t)((0.5f + 0.5f * cs) * 255.0f + 0.5f);

    for (uint8_t i = 0; i < c->count; i++)
    {
        sup_line_alpha(&c->line[i], rgb, a);
    }
}

/** rainbow -- same marquee as scroll, but the colour rides the hue wheel and
 *  textColor is ignored.  All rows move at the same rate. */
static void sup_fx_rainbow(sup_cheer_t *c, float dt_ms)
{
    c->scroll_x += SUP_SCROLL_SPEED_RAINBOW * dt_ms / 1000.0f;

    uint32_t rgb = sup_rainbow_color(c->hue);

    for (uint8_t i = 0; i < c->count; i++)
    {
        sup_line_t *ln = &c->line[i];
        sup_line_alpha(ln, rgb, 0xFF);
    }
}

/*----------------------------------------------------------------------------*
 *  Background effects
 *----------------------------------------------------------------------------*/

static uint8_t sup_bg_opacity(sup_bg_fx_t fx, float sec)
{
    switch (fx)
    {
    case SUP_BG_FX_BREATHE:
    {
        /* 2 s a cycle: opaque -> transparent over the first second, back over
         * the second.  Same shape as the editing page's paintCover(). */
        float u = fmodf(sec, 2.0f);
        float a = (u < 1.0f) ? (1.0f - u) : (u - 1.0f);
        return (uint8_t)(a * 255.0f + 0.5f);
    }

    case SUP_BG_FX_PULSE:
        /* 0.4 s a cycle: image for the first 0.2 s, black for the second. */
        return (fmodf(sec, 0.4f) < 0.2f) ? 0xFF : 0x00;

    case SUP_BG_FX_NONE:
    default:
        return 0xFF;
    }
}
static float sup_bg_scale(sup_bg_fx_t fx, float sec)
{
    float u = 0.f;
    float a = 1.5f;
    switch (fx)
    {
    case SUP_BG_FX_OPEN:
    {
        u = fmodf(sec, 2.5f);
        a = 1.5f;
        if(u<=0.5f)
        {
            a = (1.5f - 0.8f*u);
        }
        else if(u <= 1.f)
        {
            a = 1.1f;
        }
        else if(u<=1.5f)
        {
            u -= 1;
            a = (1.1f - 0.2f*u);
        }
        else
        {
            a = 1.0f;
        }
        return (a);
    }

    case SUP_BG_FX_BLUR:
    {
        u = fmodf(sec, 1.5f);
        a = (u < 0.5f) ? (1.5f - u) : 1.0f;
        return a;
    }

    case SUP_BG_FX_NONE:
    default:
        return 1.f;
    }
}
static uint8_t sup_bg_blur(sup_bg_fx_t fx, float sec)
{
    float u = 0.f;
    float a = 1.f;
    switch (fx)
    {
    case SUP_BG_FX_BLUR:
    {
        u = fmodf(sec, 1.5f);
        a = (u < 0.5f) ? (1.f - u) : 0.f;
        return (uint8_t)(a*BLUR_DEGREE_MAX);
    }

    case SUP_BG_FX_NONE:
    default:
        return 0;
    }
}
static float sup_bg_win(sup_bg_fx_t fx, float sec)
{
    float u = 0.f;
    float a = 0.f;
    switch (fx)
    {
    case SUP_BG_FX_OPEN:
    {
        u = fmodf(sec, 2.5f);
        a = 0.f;
        if(u<=0.5f)
        {
            a = u;
        }
        else if(u <= 1.f)
        {
            a = 0.5f;
        }
        else if(u<=1.5f)
        {
            u -= 1;
            a = (0.5f + u);
        }
        else
        {
            a = 1.0f;
        }
        return (a);
    }

    case SUP_BG_FX_NONE:
    default:
        return 0.f;
    }
}

static float sup_bg_rotate(sup_bg_fx_t fx, float sec)
{
    float u = 0.f;
    float a = 0.f;
    switch (fx)
    {
    case SUP_BG_FX_ROTATE:
    {
        u = fmodf(sec, 2.f);
        a = 0.f;
        if(u <= 1)
        {
            a = -90 + 90.f * u;
        }
        else
        {
            a = 0.0f;
        }
        return (a);
    }

    case SUP_BG_FX_NONE:
    default:
        return 0.f;
    }
}

static void sup_bg_apply(sup_cheer_t *c, float sec)
{
    if ((c->bg_fx == SUP_BG_FX_NONE)) return;

    uint8_t opa = sup_bg_opacity(c->bg_fx, sec);
    gui_img_set_opacity(c->bg_img, opa);

    if(c->bg_fx == SUP_BG_FX_OPEN || c->bg_fx == SUP_BG_FX_BLUR)
    {
        float scale = sup_bg_scale(c->bg_fx, sec);
        gui_win_set_scale_rate(c->bg_win_0, scale, scale);
    }

    if(c->bg_fx == SUP_BG_FX_OPEN)
    {
        uint16_t w = c->parent->w * sup_bg_win(c->bg_fx, sec) * c->scale;
        c->bg_win->base.w = w;
        c->bg_win->base.x = (c->parent->w - w)/2;
        c->bg_win_0->base.x = -1 * c->bg_win->base.x;
    }
 
    if(c->bg_fx == SUP_BG_FX_BLUR)
    {
        uint8_t blur = sup_bg_blur(c->bg_fx, sec);
        gui_win_enable_blur((gui_win_t *)c->bg_blur_win, true);
        gui_win_set_blur_degree((gui_win_t *)c->bg_blur_win, blur);
    }

    if(c->bg_fx == SUP_BG_FX_ROTATE)
    {
        float angle = sup_bg_rotate(c->bg_fx, sec);
        gui_win_set_rotation(c->bg_win_0, angle);
        gui_win_set_rotation(c->bg_win_1, -1*angle);
    }

}

/*----------------------------------------------------------------------------*
 *  Timer
 *----------------------------------------------------------------------------*/

static void sup_cheer_tick(void *obj)
{
    sup_cheer_t *c = &s_cheer;

    if (c->config == NULL || obj == NULL)
    {
        return;
    }

    sup_pkg_t *p = (sup_pkg_t *)c->config->param;
    if (p == NULL) { return; }

    if (get_win_blur_status())
    {
        if((p->text_fx == SUP_TEXT_FX_SCROLL) || (p->text_fx == SUP_TEXT_FX_RAINBOW))
        {
            for (uint8_t i = 0; i < c->count; i++)
            {
                gui_scroll_text_pause((gui_scroll_text_t *)c->line[i].text);
            }
        }
        return;
    }
    else
    {
        if((p->text_fx == SUP_TEXT_FX_SCROLL) || (p->text_fx == SUP_TEXT_FX_RAINBOW))
        {
            for (uint8_t i = 0; i < c->count; i++)
            {
                gui_scroll_text_resume((gui_scroll_text_t *)c->line[i].text);
            }
        }
    }


    uint32_t now = gui_ms_get();

    float dt_ms = (c->last_ms == 0) ? (float)SUP_TICK_MS : (float)(now - c->last_ms);
    c->last_ms = now;
    if (dt_ms > 5.0f * SUP_TICK_MS) { dt_ms = 5.0f * SUP_TICK_MS; }

    c->phase_ms += dt_ms;


    sup_bg_apply(c, c->phase_ms / 1000.0f);

    switch (p->text_fx)
    {
    case SUP_TEXT_FX_SCROLL:
        // sup_fx_scroll(c, dt_ms);
        break;
    case SUP_TEXT_FX_MULTILINE:
        sup_fx_multiline(c, dt_ms);
        break;
    case SUP_TEXT_FX_BLINK:
        sup_fx_blink(c, p->text_color);
        break;
    case SUP_TEXT_FX_RAINBOW:
        c->hue = (uint8_t)((uint32_t)(c->phase_ms * SUP_RAINBOW_DEG_PER_SEC / 1000.0f) % 360u);
        sup_fx_rainbow(c, dt_ms);
        break;
    case SUP_TEXT_FX_STATIC:
    default:
        // sup_fx_static(c);
        break;
    }

    gui_fb_change();
}

// void sup_mix_a_rgb(void)
// {
// #ifndef _HONEYGUI_SIMULATOR_
//     extern bool hw_acc_mix_a_rgb(uint8_t *a, uint16_t a_stride, uint8_t *rgb,
//                       uint16_t rgb_stride, PPE_PIXEL_FORMAT rgb_format,
//                       uint8_t *argb, uint16_t w, uint16_t h);
//     {
//         void *a = (uint8_t *)tear_mask_a8 + 8;
//         void *rgb = (uint8_t *)tearmask_data_old + 8;
//         void *argb = (uint8_t *)tearmask_data_new + 8;
//         hw_acc_mix_a_rgb(a, tear_res_size, rgb, tear_res_size, PPE_RGB565,
//                     argb, tear_res_size, tear_res_size);
//     }
//     {
//         void *a = (uint8_t *)tear_part_a8 + 8;
//         void *rgb = (uint8_t *)tearpart_data_old + 8;
//         void *argb = (uint8_t *)tearpart_data_new + 8;
//         hw_acc_mix_a_rgb(a, tear_part_res_w, rgb, tear_part_res_w, PPE_RGB565,
//                     argb, tear_part_res_w, tear_part_res_h);
//     }
// #endif
// }

static void sup_cheer_build(mainface_src_t *config, gui_obj_t *parent,
                            sup_pkg_t *p)
{
    sup_cheer_t *c = &s_cheer;
    int16_t canvas_w = (int16_t)parent->w;
    int16_t canvas_h = (int16_t)parent->h;
    uint8_t *base = (uint8_t *)config->data;

    c->config = config;
    c->parent = parent;

    c->bg_fx    = p->bg_fx;
    c->bg_color = p->bg_color;

    gui_win_t *bg_win = gui_win_create(parent, 0, 0, 0, canvas_w, canvas_h);
    c->bg_win = bg_win;
    gui_win_t *bg_win_0 = gui_win_create(bg_win, 0, 0, 0, canvas_w, canvas_h);
    c->bg_win_0 = bg_win_0;
    if (p->res_cnt > 2)
    {
        c->bg_img = gui_img_create_from_mem((void *)bg_win_0, 0,
                                            base + p->res_off[2], 0, 0, 0, 0);
        gui_img_set_mode(c->bg_img, IMG_BYPASS_MODE);
    }
    else
    {
        c->bg_img = gui_img_create_from_fs((void *)bg_win_0, 0, "/new_ui/bg_msk.bin", 0, 0, 0, 0);
        gui_img_set_mode((gui_img_t *)c->bg_img, IMG_2D_SW_FIX_A8_FG);
        gui_img_a8_recolor(c->bg_img, p->bg_color);
    }
    uint16_t w = gui_img_get_width((gui_img_t *)c->bg_img);
    float scale = 1.0f * canvas_w / w;
    gui_img_scale((gui_img_t *)c->bg_img, scale, scale);
    ((gui_img_t *)c->bg_img)->need_clip = true;

    if(c->bg_fx == SUP_BG_FX_ROTATE)
    {
        #if 0
{        
#ifndef _HONEYGUI_SIMULATOR_
        extern bool hw_acc_mix_a_rgb(uint8_t *a, uint16_t a_stride, uint8_t *rgb,
                        uint16_t rgb_stride, PPE_PIXEL_FORMAT rgb_format,
                        uint8_t *argb, uint16_t w, uint16_t h);
        int jw = 0, jh = 0, ch = 0;
        uint8_t *jinput = (base + p->res_off[2])+16;
        uint32_t jsize = *(uint32_t*)((uint8_t *)(base + p->res_off[2])+8);
        gui_log("jinput 0x%x, jsize %d\n", jinput, jsize);
        uint8_t *jrgb = (uint8_t *)gui_acc_jpeg_load(jinput, jsize, &jw, &jh, &ch);
        gui_log("jw %d, jh %d\n", jw, jh);
        uint8_t *mixargb = gui_malloc(jw * jh * 4 + 8);
        if(!mixargb)
        {
            gui_log("mixargb malloc fail\n");
            while(1);
        }


        void *a = (uint8_t *)(base + p->res_off[3]) + 8;
        void *rgb = (uint8_t *)jrgb + 8;
        void *argb = (uint8_t *)mixargb + 8;

        gui_log_hex("a", a, 200);
        gui_log_hex("rgb", rgb, 200);
        
        hw_acc_mix_a_rgb(a, 480, rgb, 480, PPE_RGB565,
                    argb, 480, 480);
        gui_log_hex("argb", argb, 200);
        gui_acc_jpeg_release(jrgb);

        
        gui_rgb_data_head_t *ph = (gui_rgb_data_head_t *)mixargb;
        memset(ph, 0, sizeof(gui_rgb_data_head_t));
        ph->type = ARGB8888;
        ph->w = jw;
        ph->h = jh;
        p->res_off[3] = mixargb - base;
#endif
}
#endif

        gui_win_t *bg_win_1 = gui_win_create(bg_win, 0, 0, 0, canvas_w, canvas_h);
        c->bg_win_1 = bg_win_1;
        c->bg_ring_img = gui_img_create_from_mem((void *)bg_win_1, 0,
                                            base + p->res_off[3], 0, 0, 0, 0);
        gui_img_set_mode(c->bg_ring_img, IMG_SRC_OVER_MODE);
        gui_img_scale((gui_img_t *)c->bg_ring_img, scale, scale);
        ((gui_img_t *)c->bg_ring_img)->need_clip = true;
    }

    if(c->bg_fx == SUP_BG_FX_BLUR)
    {
        c->bg_blur_win = gui_win_create(parent, 0, 0, 0, canvas_w-1, canvas_h-1);
    }

    /* ---- split the slogan ---- */
    char *lines[SUP_CHEER_LINES_MAX];
    uint8_t n = sup_split_lines(p->text, c->text_copy, sizeof(c->text_copy), lines);
    gui_log("%s \n", p->text);
    c->count = n;                     /* 0 is legal: an image-only package */

    c->row_h   = (int16_t)((float)p->font_size * SUP_CHEER_LINE_SPACING + 0.5f);
    c->block_h = (int16_t)(c->row_h * n);
 
    c->block_y = (int16_t)((canvas_h - c->block_h) / 2);

    /* ---- create every line, then measure it ---- */

    for (uint8_t i = 0; i < n; i++)
    {
        sup_line_t *ln = &c->line[i];

        ln->row_y = (int16_t)(i * c->row_h);
        /* 1 + i * 0.4: lower rows slide faster in a multi-line marquee */
        ln->speed_mul = 1.0f + (float)i * 0.4f;

        if((p->text_fx != SUP_TEXT_FX_SCROLL) && (p->text_fx != SUP_TEXT_FX_RAINBOW))
        {
            ln->text = gui_text_create((gui_obj_t *)parent, "sup_line",
                                    0, (int16_t)(c->block_y + ln->row_y),
                                    canvas_w, (int16_t)(c->row_h + p->font_size / 4));
            if (ln->text == NULL) { continue; }

            gui_text_set(ln->text, lines[i], GUI_FONT_SRC_TTF,
                        sup_color(p->text_color), (uint16_t)strlen(lines[i]),
                        p->font_size);
            gui_text_type_set(ln->text, base + p->res_off[1], FONT_SRC_MEMADDR);
            gui_text_mode_set(ln->text, MID_CENTER);
            gui_text_set_line_height(ln->text, c->row_h);

            gui_text_layout_measure(ln->text);
            ln->width = ln->text->char_width_sum;
        }
        else
        {
            ln->text = (gui_text_t *)gui_scroll_text_create((gui_obj_t *)parent, "sup_line",
                        0, (int16_t)(c->block_y + ln->row_y),
                        canvas_w, (int16_t)(c->row_h + p->font_size / 4));
            if (ln->text == NULL) { continue; }

            gui_scroll_text_set((gui_scroll_text_t *)ln->text, lines[i], GUI_FONT_SRC_TTF,
                        sup_color(p->text_color), (uint16_t)strlen(lines[i]),
                        p->font_size);
            gui_scroll_text_type_set((gui_scroll_text_t *)ln->text, base + p->res_off[1], FONT_SRC_MEMADDR);
            gui_text_mode_set(ln->text, MID_CENTER);
        }
    }
    

    /* ---- animation ---- */
    switch (p->text_fx)
    {
    case SUP_TEXT_FX_STATIC:
        break;                      

    case SUP_TEXT_FX_SCROLL:
    case SUP_TEXT_FX_RAINBOW:
    {
        c->scroll_x = 0.0f;
        for (uint8_t i = 0; i < n; i++)
        {
            gui_text_layout_measure((gui_text_t *)c->line[i].text);
            if(p->text_fx == SUP_TEXT_FX_SCROLL)
            {
                gui_scroll_text_scroll_set((gui_scroll_text_t *)c->line[i].text, SCROLL_X, canvas_w, canvas_w, (uint16_t)((canvas_w*2 + c->line[i].text->char_width_sum)*1000/(295.f*(1+0.4f*i))), 0);
            }
            else
            {
                gui_scroll_text_scroll_set((gui_scroll_text_t *)c->line[i].text, SCROLL_X, canvas_w, canvas_w, (uint16_t)((canvas_w*2 + c->line[i].text->char_width_sum)*1000/295.f), 0);
            }
        }
    }
    break;

    case SUP_TEXT_FX_MULTILINE:
    {
        c->roll = 0.0f;
        for (uint8_t i = 0; i < n; i++)
        {
            gui_text_move((gui_text_t *)c->line[i].text, c->line[i].x,
                        (int)canvas_h + c->line[i].row_y);
        }
    }
    break;

    default:
        break;
    }

    switch(c->bg_fx){
        case SUP_BG_FX_NONE:    /* 静止 */
        case SUP_BG_FX_BREATHE: /* 呼吸 -- not implemented; falls through to no-op */
        case SUP_BG_FX_PULSE:   /* 爆闪 -- not implemented; falls through to no-op */
        default:
            break;
        case SUP_BG_FX_OPEN:
        {
            gui_win_set_scale_rate(c->bg_win_0, 1.5f, 1.5f);
            c->bg_win->base.w = 0;
            c->bg_win->base.x = parent->w/2;
            c->bg_win_0->base.x = -1 * c->bg_win->base.x;

        }
        break;
        case SUP_BG_FX_BLUR:
        {
            gui_win_set_scale_rate(c->bg_win_0, 1.5f, 1.5f);
            gui_win_enable_blur((gui_win_t *)c->bg_blur_win, true);
            gui_win_set_blur_degree((gui_win_t *)c->bg_blur_win, BLUR_DEGREE_MAX);
        }
        break;
        case SUP_BG_FX_ROTATE:
        {
            gui_win_set_rotation(c->bg_win_0, -90);
            gui_win_set_rotation(c->bg_win_1, 90);
        }
        break;
    }
    
    
    gui_obj_create_timer(parent, SUP_TICK_MS, true, sup_cheer_tick);
    gui_obj_start_timer(parent);

    gui_fb_change();
}


void sup_ui(mainface_src_t *config, gui_obj_t *parent, float scale)
{
    gui_log("sup ui ---->\n");
    if (config == NULL || parent == NULL) { return; }

    config->param = sup_dbg_param();

    sup_pkg_t *param = (sup_pkg_t *)config->param;
    if (param == NULL) { return; }
    {
        gui_log("param  %d 0x%x 0x%x 0x%x\n", param->res_cnt, param->res_off[0], param->res_off[1], param->res_off[2]);
    }

    gui_log("parent  w %d h %d scale %f\n", parent->w, parent->h, (double)scale);

    memset(&s_cheer, 0, sizeof(s_cheer));
    s_cheer.scale = scale;
    gui_win_t *sup_win = gui_win_create(parent, "sup_win_int", 0, 0, parent->w, parent->h);
    gui_win_set_scale_rate(sup_win, scale, scale);
    sup_cheer_build(config, (gui_obj_t *)sup_win, param);
}