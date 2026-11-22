#include <arpa/inet.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <gtk/gtk.h>
#include <json-glib/json-glib.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>
#include <webkit2/webkit2.h>

#ifdef HAVE_GTK_LAYER_SHELL
#include <gtk-layer-shell.h>
#endif

#include <algorithm>
#include <atomic>
#include <cmath>
#include <fstream>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Settings {
  int fpsLimit = 30;
  bool mute = true;
  bool pauseOnFullscreen = true;
  bool pauseOnBattery = true;
  bool pauseOnLock = true;
  bool lowPower = false;
  std::string quality = "high";
};

struct Config {
  std::string token;
  pid_t parentPid = 0;
  std::string type = "image";
  std::string url;
  Settings settings;
};

Config g_config;
GtkWidget *g_window = nullptr;
WebKitWebView *g_webView = nullptr;
std::atomic<bool> g_running{true};
std::atomic<bool> g_paused{false};
std::string g_pauseReason;
std::mutex g_controlMutex;
int g_controlFd = -1;
bool g_authorized = false;

std::string jsonEscape(const std::string &value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) out += ' ';
        else out += c;
    }
  }
  return out;
}

void sendLine(int fd, const std::string &line) {
  if (fd < 0) return;
  std::string data = line + "\n";
  size_t offset = 0;
  while (offset < data.size()) {
    ssize_t written = send(fd, data.data() + offset, data.size() - offset, MSG_NOSIGNAL);
    if (written <= 0) return;
    offset += static_cast<size_t>(written);
  }
}

void emitEvent(const std::string &event, const std::string &extra = "") {
  std::lock_guard<std::mutex> lock(g_controlMutex);
  if (!g_authorized || g_controlFd < 0) return;
  sendLine(g_controlFd, "{\"event\":\"" + jsonEscape(event) + "\"" + (extra.empty() ? "" : "," + extra) + "}");
}

std::string buildContentScript() {
  bool web = g_config.type == "web";
  std::string style = web ? "" :
      "var s=document.createElement('style');s.textContent='html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video,img{width:100%;height:100%;object-fit:cover}';document.documentElement.appendChild(s);";
  std::string mute = g_config.settings.mute ? "true" : "false";
  int fpsLimit = std::max(0, std::min(60, g_config.settings.fpsLimit));
  if (g_config.settings.lowPower) fpsLimit = fpsLimit == 0 ? 24 : std::min(fpsLimit, 24);
  std::string fps = std::to_string(fpsLimit);
  std::string script = "(function(){try{" + style +
      "var m=" + mute + ";var v=document.querySelectorAll('video,audio');for(var i=0;i<v.length;i++){v[i].muted=m;if(m){v[i].volume=0}}"
      "var video=document.querySelector('video');if(video){video.controls=false;video.loop=true;video.muted=m;video.play().catch(function(){})}";
  script += "var fps=" + fps + ";if(fps>0&&!window.__whFpsGuard){window.__whFpsGuard=true;var raf=window.requestAnimationFrame.bind(window);var last=0;window.requestAnimationFrame=function(cb){return raf(function(t){if(t-last>=1000/fps){last=t;cb(t)}else{window.requestAnimationFrame(cb)}})}}";
  if (g_paused.load()) {
    script += "var p=document.querySelectorAll('video,audio');for(var j=0;j<p.length;j++){try{p[j].pause()}catch(e){}}";
  }
  script += "}catch(e){}})();";
  return script;
}

void runScript(const std::string &script) {
  if (!g_webView) return;
  webkit_web_view_run_javascript(g_webView, script.c_str(), nullptr, nullptr, nullptr);
}

void applyContentScript() {
  runScript(buildContentScript());
}

void setPaused(bool paused, const std::string &reason) {
  if (g_paused.load() == paused && g_pauseReason == reason) return;
  g_paused.store(paused);
  g_pauseReason = reason;
  runScript(paused
      ? "document.querySelectorAll('video,audio').forEach(function(v){try{v.pause()}catch(e){}})"
      : "document.querySelectorAll('video,audio').forEach(function(v){try{v.play().catch(function(){})}catch(e){}})");
  emitEvent(paused ? "paused" : "resumed", ",\"reason\":\"" + jsonEscape(reason) + "\"");
}

bool onBattery() {
  namespace fs = std::filesystem;
  std::error_code error;
  for (const auto &entry : fs::directory_iterator("/sys/class/power_supply", error)) {
    const fs::path statusPath = entry.path() / "status";
    if (!fs::exists(statusPath, error)) continue;
    std::ifstream stream(statusPath);
    std::string status;
    if (stream && std::getline(stream, status)) {
      if (status.find("Discharging") != std::string::npos) return true;
    }
  }
  return false;
}

bool screenLocked() {
  static gint64 checkedAt = 0;
  static bool locked = false;
  const gint64 now = g_get_monotonic_time();
  if (now - checkedAt < 2 * G_USEC_PER_SEC) return locked;
  checkedAt = now;
  GError *error = nullptr;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &error);
  if (!bus) {
    if (error) g_error_free(error);
    locked = false;
    return locked;
  }
  GVariant *result = g_dbus_connection_call_sync(
      bus,
      "org.freedesktop.ScreenSaver",
      "/org/freedesktop/ScreenSaver",
      "org.freedesktop.ScreenSaver",
      "GetActive",
      nullptr,
      G_VARIANT_TYPE("(b)"),
      G_DBUS_CALL_FLAGS_NO_AUTO_START,
      120,
      nullptr,
      &error);
  if (result) {
    gboolean active = FALSE;
    g_variant_get(result, "(b)", &active);
    locked = active != FALSE;
    g_variant_unref(result);
  } else {
    locked = false;
    if (error) g_error_free(error);
  }
  g_object_unref(bus);
  return locked;
}

double qualityZoom() {
  double zoom = g_config.settings.quality == "low" ? 0.75 : g_config.settings.quality == "medium" ? 0.9 : 1.0;
  return g_config.settings.lowPower ? std::min(zoom, 0.9) : zoom;
}

void checkPauseRules() {
  if (!g_running.load()) return;
  std::string reason;
  if (g_config.settings.pauseOnLock && screenLocked()) reason = "lock";
  if (reason.empty() && g_config.settings.pauseOnBattery && onBattery()) reason = "battery";
  setPaused(!reason.empty(), reason);
}

std::string readLine(int fd) {
  std::string line;
  char ch = 0;
  while (line.size() < 65536) {
    ssize_t count = recv(fd, &ch, 1, 0);
    if (count <= 0) return {};
    if (ch == '\n') break;
    if (ch != '\r') line.push_back(ch);
  }
  return line;
}

bool jsonBool(JsonObject *object, const char *name, bool fallback) {
  if (!json_object_has_member(object, name)) return fallback;
  return json_object_get_boolean_member(object, name);
}

int jsonInt(JsonObject *object, const char *name, int fallback) {
  if (!json_object_has_member(object, name)) return fallback;
  return static_cast<int>(json_object_get_int_member(object, name));
}

std::string jsonString(JsonObject *object, const char *name, const std::string &fallback = "") {
  if (!json_object_has_member(object, name)) return fallback;
  const char *value = json_object_get_string_member(object, name);
  return value ? value : fallback;
}

void applySettings(JsonObject *settings) {
  if (!settings) return;
  g_config.settings.fpsLimit = jsonInt(settings, "fpsLimit", g_config.settings.fpsLimit);
  g_config.settings.mute = jsonBool(settings, "mute", g_config.settings.mute);
  g_config.settings.pauseOnFullscreen = jsonBool(settings, "pauseOnFullscreen", g_config.settings.pauseOnFullscreen);
  g_config.settings.pauseOnBattery = jsonBool(settings, "pauseOnBattery", g_config.settings.pauseOnBattery);
  g_config.settings.pauseOnLock = jsonBool(settings, "pauseOnLock", g_config.settings.pauseOnLock);
  g_config.settings.lowPower = jsonBool(settings, "lowPower", g_config.settings.lowPower);
  const std::string quality = jsonString(settings, "quality", g_config.settings.quality);
  if (!quality.empty()) g_config.settings.quality = quality;
  if (g_webView) webkit_web_view_set_zoom_level(g_webView, qualityZoom());
  applyContentScript();
  checkPauseRules();
}

gboolean quitCallback(gpointer) {
  g_running.store(false);
  if (g_window) gtk_widget_destroy(g_window);
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

gboolean applySettingsCallback(gpointer data) {
  JsonObject *settings = static_cast<JsonObject *>(data);
  applySettings(settings);
  json_object_unref(settings);
  return G_SOURCE_REMOVE;
}

gboolean pauseCallback(gpointer data) {
  int mode = GPOINTER_TO_INT(data);
  setPaused(mode == 1, mode == 1 ? "command" : "");
  return G_SOURCE_REMOVE;
}

void controlLoop(int fd) {
  std::string first = readLine(fd);
  if (first.empty()) return;
  JsonParser *parser = json_parser_new();
  if (!json_parser_load_from_data(parser, first.c_str(), -1, nullptr)) {
    g_object_unref(parser);
    close(fd);
    return;
  }
  JsonNode *root = json_parser_get_root(parser);
  JsonObject *object = root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : nullptr;
  if (!object || jsonString(object, "token") != g_config.token) {
    g_object_unref(parser);
    close(fd);
    return;
  }
  g_object_unref(parser);
  {
    std::lock_guard<std::mutex> lock(g_controlMutex);
    g_controlFd = fd;
    g_authorized = true;
    sendLine(fd, "{\"event\":\"ready\"}");
  }
  emitEvent("attached", ",\"parent\":0");
  while (g_running.load()) {
    std::string line = readLine(fd);
    if (line.empty()) break;
    JsonParser *commandParser = json_parser_new();
    if (!json_parser_load_from_data(commandParser, line.c_str(), -1, nullptr)) {
      g_object_unref(commandParser);
      continue;
    }
    JsonNode *commandRoot = json_parser_get_root(commandParser);
    JsonObject *command = commandRoot && JSON_NODE_HOLDS_OBJECT(commandRoot) ? json_node_get_object(commandRoot) : nullptr;
    const std::string name = command ? jsonString(command, "cmd") : "";
    if (name == "stop") {
      g_object_unref(commandParser);
      g_idle_add(quitCallback, nullptr);
      break;
    }
    if (name == "pause" || name == "resume") {
      g_idle_add(pauseCallback, GINT_TO_POINTER(name == "pause" ? 1 : 0));
    } else if (name == "settings" && command && json_object_has_member(command, "settings")) {
      JsonNode *settingsNode = json_object_get_member(command, "settings");
      if (settingsNode && JSON_NODE_HOLDS_OBJECT(settingsNode)) {
        JsonObject *settings = json_object_ref(json_node_get_object(settingsNode));
        g_idle_add(applySettingsCallback, settings);
      }
    }
    g_object_unref(commandParser);
  }
  {
    std::lock_guard<std::mutex> lock(g_controlMutex);
    if (g_controlFd == fd) {
      g_controlFd = -1;
      g_authorized = false;
    }
  }
  close(fd);
  if (g_running.load()) g_idle_add(quitCallback, nullptr);
}

void startControlServer() {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    std::cerr << "ERROR socket failed" << std::endl;
    return;
  }
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 || listen(fd, 1) != 0) {
    std::cerr << "ERROR bind/listen failed" << std::endl;
    close(fd);
    return;
  }
  socklen_t length = sizeof(address);
  getsockname(fd, reinterpret_cast<sockaddr *>(&address), &length);
  std::cout << "READY " << ntohs(address.sin_port) << std::endl;
  std::cout.flush();
  std::thread([fd]() {
    int client = accept(fd, nullptr, nullptr);
    if (client >= 0) controlLoop(client);
    close(fd);
  }).detach();
}

gboolean watchdogCallback(gpointer) {
  if (g_config.parentPid > 0 && kill(g_config.parentPid, 0) != 0) {
    g_running.store(false);
    gtk_main_quit();
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

gboolean pauseTimerCallback(gpointer) {
  checkPauseRules();
  return G_SOURCE_CONTINUE;
}

void onLoadChanged(WebKitWebView *webView, WebKitLoadEvent event, gpointer) {
  if (event == WEBKIT_LOAD_FINISHED) applyContentScript();
}

void onWindowDestroy(GtkWidget *, gpointer) {
  g_running.store(false);
  gtk_main_quit();
}

void createWindow() {
  GdkDisplay *display = gdk_display_get_default();
  GdkMonitor *monitor = gdk_display_get_primary_monitor(display);
  GdkRectangle geometry{0, 0, 1920, 1080};
  if (monitor) gdk_monitor_get_geometry(monitor, &geometry);

  g_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_decorated(GTK_WINDOW(g_window), FALSE);
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(g_window), TRUE);
  gtk_window_set_skip_pager_hint(GTK_WINDOW(g_window), TRUE);
  gtk_window_set_accept_focus(GTK_WINDOW(g_window), FALSE);
  gtk_window_set_keep_below(GTK_WINDOW(g_window), TRUE);
  gtk_window_set_default_size(GTK_WINDOW(g_window), geometry.width, geometry.height);
  gtk_window_move(GTK_WINDOW(g_window), geometry.x, geometry.y);
  if (GDK_IS_X11_DISPLAY(display)) {
    gtk_widget_realize(g_window);
    GdkWindow *gdkWindow = gtk_widget_get_window(g_window);
    if (gdkWindow) gdk_window_set_type_hint(gdkWindow, GDK_WINDOW_TYPE_DESKTOP);
  } else {
#ifdef HAVE_GTK_LAYER_SHELL
    gtk_layer_init_for_window(GTK_WINDOW(g_window));
    gtk_layer_set_layer(GTK_WINDOW(g_window), GTK_LAYER_SHELL_LAYER_BACKGROUND);
    gtk_layer_set_anchor(GTK_WINDOW(g_window), GTK_LAYER_SHELL_EDGE_LEFT, TRUE);
    gtk_layer_set_anchor(GTK_WINDOW(g_window), GTK_LAYER_SHELL_EDGE_RIGHT, TRUE);
    gtk_layer_set_anchor(GTK_WINDOW(g_window), GTK_LAYER_SHELL_EDGE_TOP, TRUE);
    gtk_layer_set_anchor(GTK_WINDOW(g_window), GTK_LAYER_SHELL_EDGE_BOTTOM, TRUE);
    gtk_layer_set_exclusive_zone(GTK_WINDOW(g_window), -1);
    gtk_layer_set_namespace(GTK_WINDOW(g_window), "wallpaper-house");
#else
    std::cerr << "ERROR GNOME/KDE Wayland is not supported without gtk-layer-shell" << std::endl;
    std::exit(2);
#endif
  }

  g_webView = WEBKIT_WEB_VIEW(webkit_web_view_new());
  WebKitSettings *settings = webkit_web_view_get_settings(g_webView);
  webkit_settings_set_enable_webgl(settings, TRUE);
  webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
  webkit_settings_set_enable_media(settings, TRUE);
  webkit_settings_set_enable_mediasource(settings, TRUE);
  webkit_settings_set_hardware_acceleration_policy(settings, WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS);
  g_signal_connect(g_webView, "load-changed", G_CALLBACK(onLoadChanged), nullptr);
  webkit_web_view_set_zoom_level(g_webView, qualityZoom());
  gtk_container_add(GTK_CONTAINER(g_window), GTK_WIDGET(g_webView));
  g_signal_connect(g_window, "destroy", G_CALLBACK(onWindowDestroy), nullptr);
  gtk_widget_show_all(g_window);
  gtk_window_present(GTK_WINDOW(g_window));
  gtk_widget_set_size_request(GTK_WIDGET(g_webView), geometry.width, geometry.height);
  webkit_web_view_load_uri(g_webView, g_config.url.c_str());
  emitEvent("attached", ",\"parent\":0");
}

bool parseConfig(const std::string &path) {
  JsonParser *parser = json_parser_new();
  GError *error = nullptr;
  if (!json_parser_load_from_file(parser, path.c_str(), &error)) {
    std::cerr << "ERROR config: " << (error ? error->message : "parse failed") << std::endl;
    if (error) g_error_free(error);
    g_object_unref(parser);
    return false;
  }
  JsonNode *root = json_parser_get_root(parser);
  JsonObject *object = root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : nullptr;
  if (!object) {
    g_object_unref(parser);
    return false;
  }
  g_config.token = jsonString(object, "token");
  g_config.parentPid = static_cast<pid_t>(jsonInt(object, "parentPid", 0));
  if (json_object_has_member(object, "content")) {
    JsonNode *contentNode = json_object_get_member(object, "content");
    if (contentNode && JSON_NODE_HOLDS_OBJECT(contentNode)) {
      JsonObject *content = json_node_get_object(contentNode);
      g_config.type = jsonString(content, "type", "image");
      g_config.url = jsonString(content, "url");
    }
  }
  if (json_object_has_member(object, "settings")) {
    JsonNode *settingsNode = json_object_get_member(object, "settings");
    if (settingsNode && JSON_NODE_HOLDS_OBJECT(settingsNode)) applySettings(json_node_get_object(settingsNode));
  }
  g_object_unref(parser);
  return !g_config.token.empty() && !g_config.url.empty();
}

}  // namespace

int main(int argc, char **argv) {
  std::string configPath;
  for (int index = 1; index < argc; index++) {
    if (std::strcmp(argv[index], "--config") == 0 && index + 1 < argc) configPath = argv[++index];
  }
  if (configPath.empty() || !parseConfig(configPath)) {
    std::cerr << "ERROR missing or invalid --config" << std::endl;
    return 1;
  }
  gtk_init(&argc, &argv);
  startControlServer();
  createWindow();
  g_timeout_add_seconds(2, watchdogCallback, nullptr);
  g_timeout_add_seconds(1, pauseTimerCallback, nullptr);
  gtk_main();
  g_running.store(false);
  return 0;
}
