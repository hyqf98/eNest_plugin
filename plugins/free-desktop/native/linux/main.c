#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <webkit2/webkit2.h>
#include <json-glib/json-glib.h>
#include <stdio.h>
#include <string.h>
#ifdef DESK_LAYER_SHELL
#include <gdk/gdkwayland.h>
#include <gtk-layer-shell.h>
#endif

typedef struct { gchar *id,*label; GtkWidget *window; WebKitWebView *view; GdkRectangle full,work; gboolean ready,painted,primary; } Surface;
static GPtrArray *surfaces;
static GdkDisplay *display;
static WebKitWebContext *context;
static gchar *page;
static GString *input;
static gboolean wayland,initialized,retiring,rebuilding,attached;
static guint rebuild_timer,attempts;
static gint64 last_check;

static const gchar *text(JsonObject *obj,const gchar *key){JsonNode *node=json_object_get_member(obj,key);return node&&JSON_NODE_HOLDS_VALUE(node)&&json_node_get_value_type(node)==G_TYPE_STRING?json_node_get_string(node):"";}
static void output(JsonObject *obj){JsonNode *node=json_node_new(JSON_NODE_OBJECT);json_node_take_object(node,obj);gchar *line=json_to_string(node,FALSE);g_print("%s\n",line);fflush(stdout);g_free(line);json_node_free(node);}
static void fail(const gchar *reason){if(retiring)return;retiring=TRUE;JsonObject *msg=json_object_new();json_object_set_string_member(msg,"event","error");json_object_set_string_member(msg,"reason",reason);output(msg);gtk_main_quit();}
static void dispose_surface(gpointer data){Surface *surface=data;if(surface->view){WebKitUserContentManager *bridge=webkit_web_view_get_user_content_manager(surface->view);g_signal_handlers_disconnect_by_data(bridge,surface);webkit_user_content_manager_unregister_script_message_handler(bridge,"desktop");webkit_web_view_stop_loading(surface->view);}if(surface->window)gtk_widget_destroy(surface->window);g_free(surface->id);g_free(surface->label);g_free(surface);}
static void descriptor(JsonArray *list,Surface *surface){JsonObject *item=json_object_new(),*insets=json_object_new();json_object_set_string_member(item,"id",surface->id);json_object_set_string_member(item,"label",surface->label);json_object_set_boolean_member(item,"primary",surface->primary);
    json_object_set_int_member(insets,"left",surface->work.x-surface->full.x);json_object_set_int_member(insets,"top",surface->work.y-surface->full.y);json_object_set_int_member(insets,"right",surface->full.x+surface->full.width-surface->work.x-surface->work.width);json_object_set_int_member(insets,"bottom",surface->full.y+surface->full.height-surface->work.y-surface->work.height);json_object_set_object_member(item,"insets",insets);json_array_add_object_element(list,item);}
static unsigned long *property(Display *server,Window window,Atom key,Atom type,unsigned long *count){Atom actual;int format;unsigned long remaining;unsigned char *buffer=NULL;*count=0;if(XGetWindowProperty(server,window,key,0,32768,False,type,&actual,&format,count,&remaining,&buffer)!=Success||actual!=type||format!=32||remaining){if(buffer)XFree(buffer);*count=0;return NULL;}return (unsigned long*)buffer;}
static gboolean has_atom(Display *server,Window window,Atom key,Atom wanted){unsigned long count=0,*list=property(server,window,key,XA_ATOM,&count);gboolean found=FALSE;for(unsigned long index=0;index<count;index++)if(list[index]==wanted){found=TRUE;break;}if(list)XFree(list);return found;}
static gboolean ours(Window window){for(guint index=0;index<surfaces->len;index++){Surface *item=g_ptr_array_index(surfaces,index);GdkWindow *native=gtk_widget_get_window(item->window);if(native&&GDK_WINDOW_XID(native)==window)return TRUE;}return FALSE;}
static gboolean positioned(Surface *surface){
    if(!gtk_widget_get_mapped(surface->window))return FALSE;
    if(wayland){
#ifdef DESK_LAYER_SHELL
        return gtk_layer_is_layer_window(GTK_WINDOW(surface->window))&&gtk_layer_get_layer(GTK_WINDOW(surface->window))==GTK_LAYER_SHELL_LAYER_BOTTOM&&gtk_layer_get_keyboard_mode(GTK_WINDOW(surface->window))==GTK_LAYER_SHELL_KEYBOARD_MODE_ON_DEMAND&&gtk_widget_get_allocated_width(surface->window)>16&&gtk_widget_get_allocated_height(surface->window)>16;
#else
        return FALSE;
#endif
    }
    Display *server=GDK_DISPLAY_XDISPLAY(display);Window window=GDK_WINDOW_XID(gtk_widget_get_window(surface->window)),root=DefaultRootWindow(server);Atom type=XInternAtom(server,"_NET_WM_WINDOW_TYPE",False),desktop=XInternAtom(server,"_NET_WM_WINDOW_TYPE_DESKTOP",False),normal=XInternAtom(server,"_NET_WM_WINDOW_TYPE_NORMAL",False);unsigned long count=0;gboolean seen=FALSE,valid=TRUE;
    gdk_x11_display_error_trap_push(display);
    if(!has_atom(server,window,type,desktop))valid=FALSE;
    unsigned long *order=property(server,root,XInternAtom(server,"_NET_CLIENT_LIST_STACKING",False),XA_WINDOW,&count);
    for(unsigned long index=0;valid&&index<count;index++){Window other=order[index];if(other==window){seen=TRUE;continue;}if(ours(other))continue;XWindowAttributes info;if(!XGetWindowAttributes(server,other,&info)||info.map_state!=IsViewable)continue;
        unsigned long types_count=0,*types=property(server,other,type,XA_ATOM,&types_count);gboolean is_desktop=FALSE,is_normal=types_count==0;
        for(unsigned long lookup=0;lookup<types_count;lookup++){if(types[lookup]==desktop)is_desktop=TRUE;if(types[lookup]==normal)is_normal=TRUE;}if(types)XFree(types);
        if((seen&&is_desktop)||(!seen&&is_normal))valid=FALSE;}
    if(order)XFree(order);gint left,top,width,height;GdkWindow *native=gtk_widget_get_window(surface->window);gdk_window_get_origin(native,&left,&top);width=gdk_window_get_width(native);height=gdk_window_get_height(native);
    int error=gdk_x11_display_error_trap_pop(display);return !error&&seen&&valid&&ABS(left-surface->full.x)<=2&&ABS(top-surface->full.y)<=2&&ABS(width-surface->full.width)<=2&&ABS(height-surface->full.height)<=2;
}
static gboolean health(gpointer unused){if(retiring)return G_SOURCE_REMOVE;if(!initialized||rebuilding||!surfaces->len)return G_SOURCE_CONTINUE;gint64 now=g_get_monotonic_time();if(attached&&!attempts&&now-last_check<5*G_TIME_SPAN_SECOND)return G_SOURCE_CONTINUE;last_check=now;gboolean all=TRUE;for(guint index=0;index<surfaces->len;index++){Surface *item=g_ptr_array_index(surfaces,index);if(!item->ready||!positioned(item)){all=FALSE;break;}}
    if(!all){if(++attempts>(attached?3:12))fail("合成器未维持可交互的桌面层，保留普通工作区。");return G_SOURCE_CONTINUE;}attempts=0;
    if(!attached){attached=TRUE;JsonArray *list=json_array_new();for(guint index=0;index<surfaces->len;index++)descriptor(list,g_ptr_array_index(surfaces,index));JsonObject *packet=json_object_new();json_object_set_string_member(packet,"event","attached");json_object_set_array_member(packet,"screens",list);output(packet);}return G_SOURCE_CONTINUE;}
static void action(WebKitUserContentManager *manager,WebKitJavascriptResult *result,gpointer data){Surface *item=data;if(retiring||rebuilding||g_strcmp0(webkit_web_view_get_uri(item->view),page))return;JSCValue *value=webkit_javascript_result_get_js_value(result);if(!jsc_value_is_string(value))return;gchar *body=jsc_value_to_string(value);if(!body||strlen(body)>20000){g_free(body);return;}JsonNode *node=json_from_string(body,NULL);g_free(body);if(!node||!JSON_NODE_HOLDS_OBJECT(node)){if(node)json_node_free(node);return;}JsonObject *act=json_node_get_object(node);
    if(!strcmp(text(act,"action"),"ready")){item->ready=TRUE;health(NULL);}else if(attached){JsonObject *packet=json_object_new();json_object_set_string_member(packet,"event","action");json_object_set_string_member(packet,"screen",item->id);json_object_set_member(packet,"action",json_node_copy(node));output(packet);}json_node_free(node);}
static gboolean navigation(WebKitWebView *view,WebKitPolicyDecision *policy,WebKitPolicyDecisionType type,gpointer data){if(type==WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION){webkit_policy_decision_ignore(policy);return TRUE;}if(type==WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION){WebKitNavigationAction *action=webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(policy));if(g_strcmp0(webkit_uri_request_get_uri(webkit_navigation_action_get_request(action)),page)){webkit_policy_decision_ignore(policy);return TRUE;}}return FALSE;}
static gboolean deny_permission(WebKitWebView *view,WebKitPermissionRequest *request,gpointer data){webkit_permission_request_deny(request);return TRUE;}
static gboolean deny_menu(WebKitWebView *view,WebKitContextMenu *menu,GdkEvent *event,WebKitHitTestResult *hit,gpointer data){return TRUE;}
static void process_ended(WebKitWebView *view,WebKitWebProcessTerminationReason why,gpointer data){if(!rebuilding&&!retiring)fail("桌面网页进程已退出。");}
static gboolean denied_close(GtkWidget *window,GdkEvent *event,gpointer data){fail("桌面窗口已关闭。");return TRUE;}
static gboolean configure(gpointer unused){rebuild_timer=0;if(retiring)return G_SOURCE_REMOVE;rebuilding=TRUE;attached=FALSE;attempts=0;g_ptr_array_set_size(surfaces,0);int count=gdk_display_get_n_monitors(display);if(count<1||count>16){fail("无法识别显示器布局。");return G_SOURCE_REMOVE;}GdkMonitor *primary=gdk_display_get_primary_monitor(display);if(!primary)primary=gdk_display_get_monitor(display,0);
    for(int index=0;index<count;index++){GdkMonitor *monitor=gdk_display_get_monitor(display,index);Surface *item=g_new0(Surface,1);item->window=gtk_window_new(GTK_WINDOW_TOPLEVEL);item->primary=monitor==primary;gdk_monitor_get_geometry(monitor,&item->full);gdk_monitor_get_workarea(monitor,&item->work);
        gchar *connector=gdk_screen_get_monitor_plug_name(gdk_display_get_default_screen(display),index);const gchar *model=gdk_monitor_get_model(monitor),*maker=gdk_monitor_get_manufacturer(monitor);if(!connector&&!model){dispose_surface(item);fail("无法识别显示器，不接管桌面。");return G_SOURCE_REMOVE;}
        gchar *identity=g_strdup_printf("%s:%s:%s",maker?maker:"",model?model:"",connector?connector:"");item->id=g_compute_checksum_for_string(G_CHECKSUM_SHA256,identity,-1);g_free(identity);item->label=g_strdup(model&&*model?model:connector);g_free(connector);
        for(guint previous=0;previous<surfaces->len;previous++)if(!strcmp(((Surface*)g_ptr_array_index(surfaces,previous))->id,item->id)){dispose_surface(item);fail("无法区分相同的显示器，不接管桌面。");return G_SOURCE_REMOVE;}
        g_ptr_array_add(surfaces,item);GtkWindow *window=GTK_WINDOW(item->window);gtk_window_set_decorated(window,FALSE);gtk_window_set_title(window,"eNest 自由桌面");gtk_window_set_skip_taskbar_hint(window,TRUE);gtk_window_set_skip_pager_hint(window,TRUE);gtk_window_set_focus_on_map(window,FALSE);
        if(wayland){
#ifdef DESK_LAYER_SHELL
            gtk_layer_init_for_window(window);gtk_layer_set_namespace(window,"enest-free-desktop");gtk_layer_set_monitor(window,monitor);gtk_layer_set_layer(window,GTK_LAYER_SHELL_LAYER_BOTTOM);gtk_layer_set_keyboard_mode(window,GTK_LAYER_SHELL_KEYBOARD_MODE_ON_DEMAND);for(int edge=0;edge<GTK_LAYER_SHELL_EDGE_ENTRY_NUMBER;edge++)gtk_layer_set_anchor(window,edge,TRUE);gtk_layer_set_exclusive_zone(window,0);item->work=item->full;
#endif
        }else{gtk_window_set_type_hint(window,GDK_WINDOW_TYPE_HINT_DESKTOP);gtk_window_stick(window);gtk_window_move(window,item->full.x,item->full.y);gtk_window_set_default_size(window,item->full.width,item->full.height);}
        WebKitUserContentManager *bridge=webkit_user_content_manager_new();g_signal_connect(bridge,"script-message-received::desktop",G_CALLBACK(action),item);webkit_user_content_manager_register_script_message_handler(bridge,"desktop");item->view=g_object_new(WEBKIT_TYPE_WEB_VIEW,"web-context",context,"user-content-manager",bridge,NULL);g_object_unref(bridge);
        WebKitSettings *settings=webkit_web_view_get_settings(item->view);webkit_settings_set_enable_developer_extras(settings,FALSE);webkit_settings_set_javascript_can_open_windows_automatically(settings,FALSE);webkit_settings_set_allow_universal_access_from_file_urls(settings,FALSE);
        g_signal_connect(item->view,"decide-policy",G_CALLBACK(navigation),NULL);g_signal_connect(item->view,"permission-request",G_CALLBACK(deny_permission),NULL);g_signal_connect(item->view,"context-menu",G_CALLBACK(deny_menu),NULL);g_signal_connect(item->view,"web-process-terminated",G_CALLBACK(process_ended),NULL);g_signal_connect(window,"delete-event",G_CALLBACK(denied_close),NULL);
        gtk_container_add(GTK_CONTAINER(window),GTK_WIDGET(item->view));gtk_widget_set_opacity(item->window,0);gtk_widget_realize(item->window);cairo_region_t *empty=cairo_region_create();gtk_widget_input_shape_combine_region(item->window,empty);cairo_region_destroy(empty);gtk_widget_show_all(item->window);webkit_web_view_load_uri(item->view,page);
    }rebuilding=FALSE;return G_SOURCE_REMOVE;}
static void changed(GdkScreen *screen,gpointer data){if(!initialized||retiring)return;if(rebuild_timer)g_source_remove(rebuild_timer);rebuild_timer=g_timeout_add(250,configure,NULL);}
static void paint_done(GObject *object,GAsyncResult *result,gpointer data){gchar *id=data;GError *error=NULL;JSCValue *value=webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(object),result,&error);if(value)g_object_unref(value);for(guint index=0;!retiring&&index<surfaces->len;index++){Surface *item=g_ptr_array_index(surfaces,index);if(item->view!=WEBKIT_WEB_VIEW(object)||strcmp(id,item->id))continue;if(error){fail("无法绘制桌面，已恢复原桌面。");break;}if(!item->painted){gtk_widget_input_shape_combine_region(item->window,NULL);gtk_widget_set_opacity(item->window,1);item->painted=TRUE;}break;}g_clear_error(&error);g_free(id);}
static void receive(const gchar *line){JsonNode *node=json_from_string(line,NULL);if(!node||!JSON_NODE_HOLDS_OBJECT(node)){if(node)json_node_free(node);fail("桌面控制通道已断开。");return;}JsonObject *packet=json_node_get_object(node);const gchar *op=text(packet,"op");if(!strcmp(op,"init")){if(!initialized){initialized=TRUE;configure(NULL);}json_node_free(node);return;}
    if(!strcmp(op,"render")||!strcmp(op,"wallpaper")||!strcmp(op,"notice")){const gchar *id=text(packet,"screen");gchar *script=g_strdup_printf("window.enestDesktopReceive(%s)",line);for(guint index=0;index<surfaces->len;index++){Surface *item=g_ptr_array_index(surfaces,index);if(!item->ready||(*id&&strcmp(id,item->id)))continue;if(!strcmp(op,"render"))webkit_web_view_evaluate_javascript(item->view,script,-1,NULL,NULL,NULL,paint_done,g_strdup(item->id));else webkit_web_view_evaluate_javascript(item->view,script,-1,NULL,NULL,NULL,NULL,NULL);}g_free(script);}json_node_free(node);}
static gboolean incoming(GIOChannel *channel,GIOCondition condition,gpointer data){if(condition&(G_IO_HUP|G_IO_ERR|G_IO_NVAL)){gtk_main_quit();return G_SOURCE_REMOVE;}gchar buffer[16384];gsize count;GIOStatus status=g_io_channel_read_chars(channel,buffer,sizeof(buffer),&count,NULL);if(status==G_IO_STATUS_EOF||status==G_IO_STATUS_ERROR){gtk_main_quit();return G_SOURCE_REMOVE;}
    g_string_append_len(input,buffer,count);gchar *newline;while((newline=memchr(input->str,'\n',input->len))){gsize size=newline-input->str;if(size>5*1024*1024){fail("桌面消息过大。");return G_SOURCE_REMOVE;}*newline=0;receive(input->str);g_string_erase(input,0,size+1);}if(input->len>5*1024*1024){fail("桌面消息过大。");return G_SOURCE_REMOVE;}return G_SOURCE_CONTINUE;}
int main(int argc,char **argv){if(argc!=2)return 2;gchar *file=g_build_filename(argv[1],"native.html",NULL);page=g_filename_to_uri(file,NULL,NULL);g_free(file);if(!page||!gtk_init_check(NULL,NULL))return 1;display=gdk_display_get_default();wayland=!GDK_IS_X11_DISPLAY(display);gboolean supported=FALSE;
    if(wayland){
#ifdef DESK_LAYER_SHELL
        supported=GDK_IS_WAYLAND_DISPLAY(display)&&gtk_layer_is_supported()&&gtk_layer_get_protocol_version()>=4;
#endif
    }else if(g_ascii_strcasecmp(g_getenv("XDG_SESSION_TYPE")?g_getenv("XDG_SESSION_TYPE"):"","wayland")&&!(g_getenv("WAYLAND_DISPLAY")&&*g_getenv("WAYLAND_DISPLAY"))){GdkScreen *screen=gdk_display_get_default_screen(display);supported=gdk_x11_screen_supports_net_wm_hint(screen,gdk_atom_intern_static_string("_NET_WM_WINDOW_TYPE_DESKTOP"))&&gdk_x11_screen_supports_net_wm_hint(screen,gdk_atom_intern_static_string("_NET_CLIENT_LIST_STACKING"));}
    if(!supported){JsonObject *packet=json_object_new();json_object_set_string_member(packet,"event","error");json_object_set_string_member(packet,"reason","当前合成器不支持可交互的桌面层（Wayland 需 layer-shell v4；不使用 XWayland 伪装桌面）。");output(packet);return 1;}
    surfaces=g_ptr_array_new_with_free_func(dispose_surface);input=g_string_new(NULL);context=webkit_web_context_new_ephemeral();GIOChannel *channel=g_io_channel_unix_new(0);g_io_channel_set_encoding(channel,NULL,NULL);g_io_channel_set_flags(channel,g_io_channel_get_flags(channel)|G_IO_FLAG_NONBLOCK,NULL);g_io_add_watch(channel,G_IO_IN|G_IO_HUP|G_IO_ERR|G_IO_NVAL,incoming,NULL);g_signal_connect(gdk_display_get_default_screen(display),"monitors-changed",G_CALLBACK(changed),NULL);g_signal_connect(gdk_display_get_default_screen(display),"size-changed",G_CALLBACK(changed),NULL);g_timeout_add(420,health,NULL);gtk_main();retiring=TRUE;g_ptr_array_free(surfaces,TRUE);g_io_channel_unref(channel);g_object_unref(context);g_string_free(input,TRUE);g_free(page);return 0;}
