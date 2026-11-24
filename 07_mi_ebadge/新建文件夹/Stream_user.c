/**
 * USER-OWNED FILE - GENERATED ONCE BY HONEYGUI AUTOGEN.
 * This file is not overwritten after creation; edit it freely.
 */
#include "Stream_user.h"
#include "gui_img.h"
#include "gui_vfs.h"


#define STREAM_COLOR_WHITE          0xFFFFFFFF
#define STREAM_COLOR_VIDEO          0xFFDB382C
#define STREAM_COLOR_SHOT_NUM       0xFF181818
#define STREAM_COLOR_TMR_NOTSET     0xFF2B2B2B

#define STREAM_OPACITY_DOT_DF       (51)
#define STREAM_OPACITY_DOT_HL       (255)


static uint8_t cam_mode = STREAM_MODE_PHOTO;
static uint8_t cam_tmr_en = true;
static uint8_t cam_isrecording = false;

static uint8_t cam_preview_num = 0;
static uint8_t cam_preview_idx = 0;
#define CAM_PREVIEW_SHOW  (cam_preview_num > 0 ? true : false)

static uint8_t* img_preview_round;  // ARGB8565 RLE
static uint32_t img_preview_round_size;
static img_preview_node_t* img_preview_root;


static void img_preview_list_add(uint8_t* img_data, uint32_t img_size);
static uint8_t* img_preview_list_get_prev_data(void);
static uint8_t* img_preview_list_get_next_data(void);

// debug used image preview list

typedef struct { char* img; char* img_sm; } img_previw_d_t;


static const img_previw_d_t img_previw_d5[5] = { 
    {"/images/wp-1.bin", "/preview/pre-11.bin"}, 
    {"/images/wp-2.bin", "/preview/pre-22.bin"}, 
    {"/images/wp-3.bin", "/preview/pre-33.bin"}, 
    {"/images/wp-360.bin", "/preview/pre-44.bin"}, 
    // {"/images/wp-tear.bin", "/preview/pre-44.bin"}, 
    {"/images/wallpaper_default.bin", "/preview/pre-55.bin"} 
};

static uint8_t img_preview_d_idx = 0;
static uint8_t* img_preview_d_data = 0;
static uint32_t img_preview_d_sz = 0;
static uint8_t* img_preview_d_mdata = 0;
static uint32_t img_preview_d_msz = 0;

static void img_preview_d_load(void)
{
    uint8_t idx = img_preview_d_idx % 5;
    img_preview_d_idx++;

#ifndef _HONEYGUI_SIMULATOR_
    img_preview_d_data  = (uint8_t *)gui_vfs_get_file_address(img_previw_d5[idx].img);
    gui_vfs_file_t *f = gui_vfs_open((const char *)img_previw_d5[idx].img, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    img_preview_d_sz = gui_vfs_tell(f);
    gui_vfs_close(f);

    img_preview_d_mdata = (uint8_t *)gui_vfs_get_file_address(img_previw_d5[idx].img_sm);
    f = gui_vfs_open((const char *)img_previw_d5[idx].img_sm, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    img_preview_d_msz = gui_vfs_tell(f);
    gui_vfs_close(f);

#else

    if(img_preview_d_data)
    {
        gui_free(img_preview_d_data);
        img_preview_d_data = NULL;
    }
    if(img_preview_d_mdata)
    {
        gui_free(img_preview_d_mdata);
        img_preview_d_mdata = NULL;
    }
    img_preview_d_sz = 0;
    img_preview_d_msz = 0;

    uint8_t *file_pointer = img_previw_d5[idx].img;
    void *data = NULL; int size = 0;
    gui_vfs_file_t *f = gui_vfs_open((const char *)file_pointer, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    size = gui_vfs_tell(f);

    if (size <= 0)
    {
        gui_vfs_close(f);
        return;
    }
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_SET);
    data = gui_malloc(size);
    GUI_ASSERT(data != NULL);
    gui_vfs_read(f, (void *)data, size);
    gui_vfs_close(f);
    img_preview_d_sz = size;
    img_preview_d_data = data;

    file_pointer = img_previw_d5[idx].img_sm;
    f = gui_vfs_open((const char *)file_pointer, GUI_VFS_READ);
    GUI_ASSERT(f != NULL);
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_END);
    size = gui_vfs_tell(f);

    if (size <= 0)
    {
        gui_vfs_close(f);
        return;
    }
    gui_vfs_seek(f, 0, GUI_VFS_SEEK_SET);
    data = gui_malloc(size);
    GUI_ASSERT(data != NULL);
    gui_vfs_read(f, (void *)data, size);
    gui_vfs_close(f);
    img_preview_d_msz = size;
    img_preview_d_mdata = data;

#endif
}

static void img_preview_d_recv(void)
{
    img_preview_d_load();
            
    if(img_preview_round)
    {
        gui_free(img_preview_round);
    }
    img_preview_round = gui_malloc(img_preview_d_msz);
    img_preview_round_size = img_preview_d_msz;
    memcpy(img_preview_round, img_preview_d_mdata, img_preview_d_msz);
    gui_img_set_src((gui_img_t *)img_pre_sm, img_preview_round, IMG_SRC_MEMADDR);
    img_preview_list_add(img_preview_d_data, img_preview_d_sz);
    gui_fb_change();
}



/* ============================ view_cam_ctl ============================ */

static void str_cam_photo_ui(void);
static void str_cam_video_ui(void);

static void stream_img_timer_cb(void *p)
{
    gui_img_t * img_frame = (gui_img_t *)p;
    int w = gui_img_get_width(img_frame);
    int screen_w = gui_get_screen_width();
    
    float scale = 1.0f;
    if(w < screen_w)
    {
        // stream 360(368) -> screen 466 
        scale = 1.0f * screen_w / 360;
    }
    else if(w + 16 < screen_w)
    {
        // stream 466(480) -> screen 360 
        scale = 1.0f * screen_w / 466;
    }
    // gui_log("stream w %d h %d %f\n", w, h, scale);
    gui_img_scale((gui_img_t *)img_frame, scale, scale);
}


void view_cam_ctl_timer_0_cb_impl(void)
{
    gui_log("view_cam_ctl_timer_0_cb_impl  cam_mode=%d  cam_tmr_en=%d  cam_isrecording=%d  cam_preview_num=%d\n", cam_mode, cam_tmr_en, cam_isrecording, cam_preview_num);

    gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
    if(CAM_PREVIEW_SHOW)
    {
        gui_img_set_src((gui_img_t *)img_pre_sm, img_preview_round, IMG_SRC_MEMADDR);
    }
    if(cam_mode == STREAM_MODE_PHOTO)
    {
        str_cam_photo_ui();
    }
    else
    {
        str_cam_video_ui();
    }

    {
        gui_img_t * img_frame = streaming_1->img;
        gui_obj_create_timer((gui_obj_t *)img_frame, 10, true, stream_img_timer_cb);
        gui_obj_start_timer((gui_obj_t *)img_frame);
    }
}

static void str_cam_photo_ui(void)
{
    gui_img_a8_recolor((gui_img_t *)img_shot, STREAM_COLOR_WHITE);
    gui_img_scale((gui_img_t *)img_shot, 1.0f, 1.0f);
    gui_img_a8_recolor(img_shot_num, STREAM_COLOR_SHOT_NUM);
    gui_obj_hidden((gui_obj_t *)img_shot_num, !cam_tmr_en);
    gui_img_a8_mix_alpha(img_cam_dot0, STREAM_OPACITY_DOT_HL);
    gui_img_a8_mix_alpha(img_cam_dot1, STREAM_OPACITY_DOT_DF);
    gui_obj_hidden((gui_obj_t *)img_cam_dot0, false);
    gui_obj_hidden((gui_obj_t *)img_cam_dot1, false);

    gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
}
static void str_cam_video_ui(void)
{
    gui_img_a8_recolor((gui_img_t *)img_shot, STREAM_COLOR_VIDEO);
    gui_img_a8_mix_alpha(img_cam_dot0, STREAM_OPACITY_DOT_DF);
    gui_img_a8_mix_alpha(img_cam_dot1, STREAM_OPACITY_DOT_HL);
    gui_obj_hidden((gui_obj_t *)img_cam_dot0, false);
    gui_obj_hidden((gui_obj_t *)img_cam_dot1, false);

    gui_img_a8_recolor(img_shot_num, STREAM_COLOR_WHITE);
    gui_obj_hidden((gui_obj_t *)img_shot_num, !cam_tmr_en);

    gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
}

void str_cam_swipe_left(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
    if((cam_mode == STREAM_MODE_PHOTO) && (!cam_isrecording))
    {
        cam_mode = STREAM_MODE_VIDEO;
        str_cam_video_ui();
    }

}
void str_cam_swipe_right(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
    if((cam_mode == STREAM_MODE_VIDEO) && (!cam_isrecording))
    {
        cam_mode = STREAM_MODE_PHOTO;
        str_cam_photo_ui();
    }
}





void str_click_win_album(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
}

/*  img_tmr_num animation callback */
static uint32_t img_tmr_num_start_ms = 0;
static uint8_t img_tmr_num_started = false;
static uint32_t img_tmr_num_prev_elapsed_ms = 0;
void img_tmr_num_animation_reset(void)
{
    img_tmr_num_start_ms = 0;
    img_tmr_num_started = false;
    img_tmr_num_prev_elapsed_ms = 0;
}

void img_tmr_num_timer_0_cb_impl(void)
{
    uint32_t now_ms = gui_ms_get();
    

    cam_isrecording = true;
    if(!img_tmr_num_started)
    {
        img_tmr_num_start_ms = now_ms;
    }
    img_tmr_num_started = true;
    

    uint32_t total_elapsed_ms = now_ms - img_tmr_num_start_ms;
    img_tmr_num_prev_elapsed_ms = total_elapsed_ms;

    // gui_log("img_tmr_num_timer_0_cb_impl  %lu\n", total_elapsed_ms);
    if(total_elapsed_ms <= 1000)
    {
        gui_obj_hidden((gui_obj_t *)img_tmr_num, false);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_5.bin", IMG_SRC_FILESYS);
        gui_fb_change();
    }
    else if(total_elapsed_ms <= 2000)
    {
        gui_obj_hidden((gui_obj_t *)img_tmr_num, false);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_4.bin", IMG_SRC_FILESYS);
        gui_fb_change();
    }
    else if(total_elapsed_ms <= 3000)
    {
        gui_obj_hidden((gui_obj_t *)img_tmr_num, false);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_3.bin", IMG_SRC_FILESYS);
        gui_fb_change();
    }
    else if(total_elapsed_ms <= 4000)
    {
        gui_obj_hidden((gui_obj_t *)img_tmr_num, false);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_2.bin", IMG_SRC_FILESYS);
        gui_fb_change();
    }
    else if(total_elapsed_ms <= 5000)
    {
        gui_obj_hidden((gui_obj_t *)img_tmr_num, false);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_1.bin", IMG_SRC_FILESYS);
        gui_fb_change();   
    }
    else
    {
        gui_log("count down done\n");
        gui_obj_stop_timer(GUI_BASE(img_tmr_num));
        gui_obj_hidden((gui_obj_t *)img_tmr_num, true);
        gui_img_set_src((gui_img_t *)img_tmr_num, "/stream/cam_5.bin", IMG_SRC_FILESYS);

        if(cam_mode == STREAM_MODE_PHOTO)
        {
            cam_isrecording = false;
            cam_preview_num++;
            img_preview_d_recv();



            gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
            gui_obj_hidden((gui_obj_t *)win_shot, false);
            gui_obj_hidden((gui_obj_t *)img_cam_setting, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot0, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot1, false);
        }
        else
        {
            gui_log("start record\n");
            gui_obj_hidden((gui_obj_t *)win_shot, false);
            gui_obj_hidden((gui_obj_t *)img_shot_num, true);

            img_shot_preset_animation_reset();
            gui_obj_create_timer(GUI_BASE(img_shot), 20, true, img_shot_timer_0_cb);
            gui_obj_start_timer(GUI_BASE(img_shot));
        }
    }


}
void str_click_win_shot(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);

    if(cam_mode == STREAM_MODE_PHOTO)
    {
        gui_log("shot photo\n");
        if(cam_tmr_en == true)
        {
            gui_obj_hidden((gui_obj_t *)img_tmr_num, false);

            img_tmr_num_animation_reset();
            gui_obj_create_timer(GUI_BASE(img_tmr_num), 50, true, img_tmr_num_timer_0_cb);
            gui_obj_start_timer(GUI_BASE(img_tmr_num));

            gui_obj_hidden((gui_obj_t *)win_album, true);
            gui_obj_hidden((gui_obj_t *)win_shot, true);
            gui_obj_hidden((gui_obj_t *)img_cam_setting, true);
            gui_obj_hidden((gui_obj_t *)img_cam_dot0, true);
            gui_obj_hidden((gui_obj_t *)img_cam_dot1, true);
        }
        else
        {
            cam_preview_num++;
            img_preview_d_recv();
            gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
            gui_obj_hidden((gui_obj_t *)img_cam_setting, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot0, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot1, false);
        }
        gui_obj_hidden((gui_obj_t *)img_shot_num, !cam_tmr_en);
    }
    else  //(cam_mode == STREAM_MODE_VIDEO)
    {
        if(cam_isrecording)
        {
            cam_isrecording = false;
            gui_log("stop record\n");
            img_shot_preset_animation_reset();
            gui_obj_create_timer(GUI_BASE(img_shot), 20, true, img_shot_timer_1_cb);
            gui_obj_start_timer(GUI_BASE(img_shot));

            cam_preview_num++;
            img_preview_d_recv();

            gui_obj_hidden((gui_obj_t *)win_album, !CAM_PREVIEW_SHOW);
            gui_obj_hidden((gui_obj_t *)img_cam_setting, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot0, false);
            gui_obj_hidden((gui_obj_t *)img_cam_dot1, false);
            gui_obj_hidden((gui_obj_t *)img_shot_num, !cam_tmr_en);
        }
        else
        {
            cam_isrecording = true;
            if(cam_tmr_en == true)
            {
                gui_obj_hidden((gui_obj_t *)img_tmr_num, false);

                img_tmr_num_animation_reset();
                gui_obj_create_timer(GUI_BASE(img_tmr_num), 50, true, img_tmr_num_timer_0_cb);
                gui_obj_start_timer(GUI_BASE(img_tmr_num));

                gui_obj_hidden((gui_obj_t *)win_shot, true);
                
            }
            else
            {
                gui_log("start record\n");
                img_shot_preset_animation_reset();
                gui_obj_create_timer(GUI_BASE(img_shot), 20, true, img_shot_timer_0_cb);
                gui_obj_start_timer(GUI_BASE(img_shot));
            }

            gui_obj_hidden((gui_obj_t *)win_album, true);
            gui_obj_hidden((gui_obj_t *)img_cam_setting, true);
            gui_obj_hidden((gui_obj_t *)img_cam_dot0, true);
            gui_obj_hidden((gui_obj_t *)img_cam_dot1, true);
        }
    }



}


/* ============================ view_cam_setting ============================ */

static void str_setting_set(uint8_t idx);
static void str_setting_notset(uint8_t idx);



void view_cam_setting_timer_0_cb_impl(void)
{
    if (cam_tmr_en == true)
    {
        str_setting_notset(0);
        str_setting_set(1);
    }
    else
    {
        str_setting_set(0);
        str_setting_notset(1);
    }
    
}

static void str_setting_set(uint8_t idx)
{
    if(idx == 0)
    {
        gui_img_set_src((gui_img_t *)img_tmr_btn0, "/stream/cam_set.bin", IMG_SRC_FILESYS);
        gui_img_set_mode((gui_img_t *)img_tmr_btn0, IMG_SRC_OVER_MODE);
    }
    else if(idx == 1)
    {
        gui_img_set_src((gui_img_t *)img_tmr_btn1, "/stream/cam_set.bin", IMG_SRC_FILESYS);
        gui_img_set_mode((gui_img_t *)img_tmr_btn1, IMG_SRC_OVER_MODE);
    }
    gui_fb_change();
}
static void str_setting_notset(uint8_t idx)
{
    if(idx == 0)
    {
        gui_img_set_src((gui_img_t *)img_tmr_btn0, "/stream/cam_notset.bin", IMG_SRC_FILESYS);
        gui_img_set_mode((gui_img_t *)img_tmr_btn0, IMG_2D_SW_FIX_A8_FG);
        gui_img_a8_recolor((gui_img_t *)img_tmr_btn0, STREAM_COLOR_TMR_NOTSET);
    }
    else if(idx == 1)
    {
        gui_img_set_src((gui_img_t *)img_tmr_btn1, "/stream/cam_notset.bin", IMG_SRC_FILESYS);
        gui_img_set_mode((gui_img_t *)img_tmr_btn1, IMG_2D_SW_FIX_A8_FG);
        gui_img_a8_recolor((gui_img_t *)img_tmr_btn1, STREAM_COLOR_TMR_NOTSET);
    }
    gui_fb_change();
}

// str_click_tmr_off
void str_click_lst_0(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);

    cam_tmr_en = false;
    str_setting_set(0);
    str_setting_notset(1);
}

// str_click_tmr_on
void str_click_lst_1(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);

    cam_tmr_en = true;
    str_setting_notset(0);
    str_setting_set(1);
}



/* ============================ view_cam_preview ============================ */

typedef struct { int16_t x; int16_t y; } ui_pos_t;

/* 466 round screen，12x12 round dot，左上角坐标，从上到下；参考点 (438,227)，R = 211 */
static const ui_pos_t dot_pos_1[1] = { {438, 227} };
static const ui_pos_t dot_pos_2[2] = { {438, 216}, {438, 238} };
static const ui_pos_t dot_pos_3[3] = { {437, 205}, {438, 227}, {437, 249} };
static const ui_pos_t dot_pos_4[4] = { {435, 194}, {438, 216}, {438, 238}, {435, 260} };
static const ui_pos_t dot_pos_5[5] = { {433, 183}, {437, 205}, {438, 227}, {437, 249}, {433, 271} };

static const ui_pos_t *const dot_pos_tbl[6] = {
    0, dot_pos_1, dot_pos_2, dot_pos_3, dot_pos_4, dot_pos_5
};


static gui_img_t *img_pre_dot[5] = {NULL, NULL, NULL, NULL, NULL};


static void str_pre_show_dot(void);
static void str_pre_set_dot(void);


void view_cam_preview_timer_0_cb_impl(void)
{
    gui_log("view_cam_preview_timer_0_cb_impl  cam_preview_num=%d\n", cam_preview_num);
    img_pre_dot[0] = img_pre0;
    img_pre_dot[1] = img_pre1;
    img_pre_dot[2] = img_pre2;
    img_pre_dot[3] = img_pre3;
    img_pre_dot[4] = img_pre4;

    cam_preview_idx = 0;
    str_pre_show_dot();
    str_pre_set_dot();
    gui_img_set_src((gui_img_t *)img_prepic, img_preview_root->img_data, IMG_SRC_MEMADDR);
    uint16_t w = gui_img_get_width((gui_img_t *)img_prepic);
    float scale = 1.0f * gui_get_screen_width() / w;
    gui_img_scale((gui_img_t *)img_prepic, scale, scale);
    gui_fb_change();
}

static void str_pre_set_dot(void)
{
    gui_log("str_pre_set_dot=%d  cam_preview_num=%d\n", cam_preview_idx, cam_preview_num);

    for(uint8_t i = 0; i < 5; i++)
    {
        gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[i], STREAM_OPACITY_DOT_DF);
    }

    if(cam_preview_num <= 5)
    {
        gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[cam_preview_idx], STREAM_OPACITY_DOT_HL);
    }
    else
    {
        if(cam_preview_idx <= 2)// 0,1,2
        {
            gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[cam_preview_idx], STREAM_OPACITY_DOT_HL);
        }
        else if(cam_preview_idx >= (cam_preview_num - 3))
        {
            gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[cam_preview_idx - (cam_preview_num - 5)], STREAM_OPACITY_DOT_HL);
        }
        else
        {
            gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[2], STREAM_OPACITY_DOT_HL);
        }
    }
}

static void str_pre_show_dot(void)
{
    gui_log("str_pre_show_dot  cam_preview_num=%d\n", cam_preview_num);
    uint8_t num = cam_preview_num > 5 ? 5 : cam_preview_num;
    for(uint8_t i = 0; i < 5; i++)
    {
        if(i < num)
        {
            gui_log("str_pre_show_dot  i=%d  pos=(%d,%d)\n", i, dot_pos_tbl[num][i].x, dot_pos_tbl[num][i].y);
            gui_obj_hidden((gui_obj_t *)img_pre_dot[i], false);
            gui_img_set_pos((gui_img_t *)img_pre_dot[i], dot_pos_tbl[num][i].x, dot_pos_tbl[num][i].y);
            gui_img_a8_mix_alpha((gui_img_t *)img_pre_dot[i], STREAM_OPACITY_DOT_DF);
        }
        else
        {
            gui_obj_hidden((gui_obj_t *)img_pre_dot[i], true);
        }
    }
    gui_fb_change();
}


static img_preview_node_t* img_preview_list_get_node(uint8_t index);
void str_pre_swipe_up(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
    if(cam_preview_idx < (cam_preview_num - 1))
    {
        cam_preview_idx++;
        str_pre_set_dot();
        // uint8_t* img_data = img_preview_list_get_next_data();
        uint8_t* img_data = img_preview_list_get_node(cam_preview_idx)->img_data;
        gui_log("img_data 0x%x", img_data);
        if(img_data != NULL)
        {
            gui_img_set_src((gui_img_t *)img_prepic, img_data, IMG_SRC_MEMADDR);
            uint16_t w = gui_img_get_width((gui_img_t *)img_prepic);
            float scale = 1.0f * gui_get_screen_width() / w;
            gui_img_scale((gui_img_t *)img_prepic, scale, scale);
        }
        gui_fb_change();
    }
}

void str_pre_swipe_dn(void *obj, gui_event_t *e)
{
    GUI_UNUSED(obj);
    GUI_UNUSED(e);
    if(cam_preview_idx > 0)
    {
        cam_preview_idx--;
        str_pre_set_dot();
        // uint8_t* img_data = img_preview_list_get_prev_data();
        uint8_t* img_data = img_preview_list_get_node(cam_preview_idx)->img_data;
        gui_log("img_data 0x%x", img_data);
        if(img_data != NULL)
        {
            gui_img_set_src((gui_img_t *)img_prepic, img_data, IMG_SRC_MEMADDR);
            uint16_t w = gui_img_get_width((gui_img_t *)img_prepic);
            float scale = 1.0f * gui_get_screen_width() / w;
            gui_img_scale((gui_img_t *)img_prepic, scale, scale);
        }
        gui_fb_change();
    }
}


/* ============================ preview link list ============================*/


static img_preview_node_t* img_preview_cur_node;

static void img_update_preview_round(uint8_t* img_data, uint32_t img_size)
{
    uint8_t* lst_data = img_preview_round;

    uint8_t* new_data = (uint8_t*)gui_malloc(img_size);
    if(new_data == NULL)
    {
        gui_log("img_set_preview_round: failed to allocate memory for img_preview_round\n");
        return;
    }
    memcpy(new_data, img_data, img_size);
    img_preview_round_size = img_size;
    img_preview_round = new_data;

    if(lst_data != NULL)
    {
        gui_free(lst_data);
    }
}

static void img_preview_list_init(void)
{
    img_preview_root = NULL;
    img_preview_round = NULL;
    img_preview_round_size = 0;
}

static void img_preview_list_add(uint8_t* img_data, uint32_t img_size)
{
    img_preview_node_t* new_node = (img_preview_node_t*)gui_malloc(sizeof(img_preview_node_t));
    if(!new_node)
    {
        gui_log("img_preview_list_add: failed to allocate memory for new_node\n");
        return;
    }
#ifndef _HONEYGUI_SIMULATOR_
    new_node->img_data = img_data;
#else
    new_node->img_data = (uint8_t*)gui_malloc(img_size);
    if(new_node->img_data == NULL)
    {
        gui_log("img_preview_list_add: failed to allocate memory for img_data\n");
        gui_free(new_node);
        return;
    }
    memcpy(new_node->img_data, img_data, img_size);
#endif
    new_node->prev = NULL;
    new_node->next = NULL;

    if (img_preview_root == NULL) {
        img_preview_root = new_node;
    } else {
        img_preview_node_t* current = img_preview_root;
        img_preview_root = new_node;
        img_preview_root->next = current;
        current->prev = img_preview_root;
    }
    img_preview_cur_node = img_preview_root;
    gui_log("add img 0x%x", new_node->img_data);
}

void img_preview_list_clear(void)
{
    img_preview_node_t* current = img_preview_root;
    while (current != NULL) {
        img_preview_node_t* next_node = current->next;
#ifndef _HONEYGUI_SIMULATOR_

#else
        if(current->img_data) gui_free(current->img_data);
#endif
        gui_free(current);
        current = next_node;
    }
    img_preview_root = NULL;
    img_preview_round = NULL;
    img_preview_round_size = 0;
    img_preview_cur_node = NULL;

    // gui_img_set_src((gui_img_t *)img_prepic, "/images/wp-1.bin", IMG_SRC_FILESYS);
    cam_preview_num = 0;
    cam_preview_idx = 0;
}

static img_preview_node_t* img_preview_list_get_node(uint8_t index)
{
    img_preview_node_t* current = img_preview_root;
    uint8_t i = 0;
    while (current != NULL && i < index) {
        current = current->next;
        i++;
    }
    return current;
}

static uint8_t* img_preview_list_get_prev_data(void)
{
    img_preview_node_t* current = img_preview_root;
    if (current == NULL) {
        return NULL;
    }
    if (current->prev != NULL) {
        current = current->prev;
    }
    img_preview_cur_node = current;
    return current->img_data;
}

static uint8_t* img_preview_list_get_next_data(void)
{
    img_preview_node_t* current = img_preview_root;
    if (current == NULL) {
        return NULL;
    }
    if (current->next != NULL) {
        current = current->next;
    }
    img_preview_cur_node = current;
    return current->img_data;
}




/* ============================ Live-video stream ============================*/

#define APP_STREAM_FRAME_TYPICAL   (50u * 1024u)   /* ordinary preview frame    */
#define APP_STREAM_TYPICAL_COUNT    20

/* Ascending buf_size -- stp_acquire_free() walks the array in order and takes
 * the first class that fits, so an unsorted array would defeat the best fit. */
static const stp_class_cfg_t s_stream_classes[] =
{
    { .buf_size = APP_STREAM_FRAME_TYPICAL, .buf_count = APP_STREAM_TYPICAL_COUNT },
};

/* The one transport this board owns.  NULL until app_stream_transport_init()
 * has run; both ends fetch it through the getter below. */
static stp_transport_t *s_stream_tp = NULL;

/*
 * Shared accessor for the live-video transport.  Used by:
 *   - the designer gui_stream widget (consumer) to bind on creation, and
 *   - app/protocol/wifi_xfer/stream_sink.c (producer) to push preview frames.
 * Returns NULL before the transport has been created; the producer fetches it
 * lazily and re-tries, so it does not depend on running after this.
 */
stp_transport_t *gui_stream_transport_get(void)
{
    return s_stream_tp;
}

/*
 * Create the shared transport exactly once.  Called from easy_demoEntry.c
 * app_init() (SOC only), after flashdb_prepare() and before the main view is
 * created -- so the consumer's getter call already sees a valid handle.
 */
int app_stream_transport_init(void)
{
    stp_config_t cfg;
    stp_config_default(&cfg);
    cfg.align              = 8;
    cfg.classes            = s_stream_classes;
    cfg.class_count        = (uint32_t)(sizeof(s_stream_classes) /
                                        sizeof(s_stream_classes[0]));
    /* Only read by stp_consume(), which the widget does not call -- it selects
     * acquire_latest / acquire_oldest from its own drop_mode.  Set to match that
     * anyway: the two disagreeing would mislead the next reader. */
    cfg.drop_mode          = STP_DROP_UNCONDITIONAL;
    cfg.allow_oversize_fit = true;

    s_stream_tp = stp_instance_create(&cfg);
    if (s_stream_tp == NULL)
    {
        gui_log("app_stream: stp_instance_create failed\n");
        return -1;
    }

    gui_log("app_stream: transport ready (%u x %u KB KB)\n",
            (unsigned)APP_STREAM_TYPICAL_COUNT,
            (unsigned)(APP_STREAM_FRAME_TYPICAL / 1024u));
    return 0;
}

/*============================================================================*
 * CMD 0x0F remote-control callbacks (spec v2 section 2, principle 2)
 *----------------------------------------------------------------------------*
 * State parsing itself lives in app/l2_handlers/hmi_l2_cmd_remote.c
 * (parse_state_report -- the ONLY writer of the authoritative state mirror).
 * UI-side wiring is just: register a callback, pull latest via getters, redraw.
 *
 * BEWARE: these callbacks run on the BLE / L2 RX thread, NOT on the GUI thread.
 * Do NOT touch widgets directly here -- either only log (P0 today), or post a
 * message to the GUI thread when you add zoom / recording indicator controls.
 *============================================================================*/
static void on_remote_state_changed(void)
{
#ifdef _HONEYGUI_SIMULATOR_
    gui_log("on_remote_state_changed");
#else
#if 0 /* V1.2 migration: hmi_l2_cmd_remote parked -- state mirror lives in the
       * excluded app/l2_handlers/.  Re-point at the app/protocol/ handler when
       * CMD 0x0F lands there. */
    gui_log("remote: STATE zoom=%u.%02ux rec=%d facing=%s shot(has=%d id=%u)\n",
            (unsigned)(hmi_l2_remote_state_zoom_x100() / 100u),
            (unsigned)(hmi_l2_remote_state_zoom_x100() % 100u),
            (int)hmi_l2_remote_state_recording(),
            hmi_l2_remote_state_facing() ? "front" : "back",
            (int)hmi_l2_remote_state_has_last_shot(),
            (unsigned)hmi_l2_remote_state_last_shot_id());
    /* TODO(ui): once zoom label / rec-dot widgets exist, post a redraw msg
     * to the GUI thread from here (do NOT call widget APIs directly). */

    ui_remote_change(hmi_l2_remote_state_zoom_x100());
#endif
#endif
}

static void on_remote_shot_ready(uint16_t shot_id)
{
    gui_log("remote: LAST_SHOT_READY id=%u\n", (unsigned)shot_id);
    /* TODO(ui): pop a "new photo" hint / trigger thumbnail refresh. */
}

static void on_remote_ctrl_result(uint8_t key, uint8_t code)
{
    /* App rejected one of our requests (success is signaled implicitly through
     * STATE_REPORT -- see spec section 5.2). */
    gui_log("remote: CTRL_RESULT key=0x%02x code=0x%02x (%s)\n",
            (unsigned)key, (unsigned)code,
            code == 0x01 ? "unsupported" :
            code == 0x02 ? "busy" :
            code == 0x03 ? "out_of_range" :
            code == 0x04 ? "not_ready" : "unknown");
    /* TODO(ui): toast the error to the user. */
}

int app_remote_ctrl_init(void)
{
#ifdef _HONEYGUI_SIMULATOR_
    gui_log("app_remote_ctrl_init\n");
#else
#if 0 /* V1.2 migration: hmi_l2_cmd_remote parked -- nothing to register against
       * until CMD 0x0F is reimplemented under app/protocol/handlers/. */
    hmi_l2_remote_set_state_cb(on_remote_state_changed);
    hmi_l2_remote_set_shot_cb(on_remote_shot_ready);
    hmi_l2_remote_set_ctrl_result_cb(on_remote_ctrl_result);
#else
    (void)on_remote_state_changed;
    (void)on_remote_shot_ready;
    (void)on_remote_ctrl_result;
#endif
#endif
    gui_log("app_remote: callbacks registered (CMD 0x0F)\n");
    return 0;
}
