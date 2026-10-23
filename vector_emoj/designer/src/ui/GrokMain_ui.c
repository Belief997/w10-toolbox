/**
 * GrokMain UI Implementation (Auto-generated, do not modify manually)
 */
#include "GrokMain_ui.h"
#include "../callbacks/GrokMain_callbacks.h"
#include "../user/GrokMain_user.h"
#include <stddef.h>

// Component handle definitions


// Create GrokMainView (hg_view)
static void GrokMainView_switch_out(gui_view_t *view)
{
    GUI_UNUSED(view);
}

static void GrokMainView_switch_in(gui_view_t *view)
{
    // Set animation step
    gui_view_set_animate_step(view, 100);

    // Set opacity
    gui_view_set_opacity(view, 255);

    // Set background color
    gui_view_set_bg_color(view, gui_rgb(0, 0, 0));

    // Bind timer: Animation 1
    gui_obj_create_timer((gui_obj_t *)view, 3000, true, view_poweron_timer_0_cb);
    gui_obj_start_timer((gui_obj_t *)view);

    GUI_UNUSED(view);
}
GUI_VIEW_INSTANCE("GrokMainView", false, GrokMainView_switch_in, GrokMainView_switch_out, false);
