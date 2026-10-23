#include "gui_api.h"
#include "gui_view.h"
#include "gui_components_init.h"
#include "gui_vfs.h"

/* @protected start entry_includes */
// Add user includes here
#include "grok_emoji.h"
/* @protected end entry_includes */

static int app_init(void)
{
#ifdef _HONEYGUI_SIMULATOR_
    // Simulator: Mount POSIX filesystem
    gui_vfs_mount_posix("/", "./assets");
#else
    // SOC: Mount romfs from flash address
    gui_vfs_mount_romfs("/", (void *)0x70536400, 0);
#endif

    /* @protected start app_init_pre */
    // Add user initialization code here (runs before the main view is created)
    /* @protected end app_init_pre */

    gui_view_create(gui_obj_get_root(), "GrokMainView", 0, 0, 0, 0);

    /* @protected start app_init_post */
    // Add user initialization code here (runs after the main view is created)
    grok_emoji_create(gui_view_get("GrokMainView"));
    /* @protected end app_init_post */

    return 0;
}

GUI_INIT_APP_EXPORT(app_init);
