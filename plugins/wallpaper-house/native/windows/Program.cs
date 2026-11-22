using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WallpaperHouse
{
    public class HostConfig
    {
        public string token = "";
        public int parentPid;
        public string dataDir = "";
        public ContentConfig content = new ContentConfig();
        public SettingsConfig settings = new SettingsConfig();
    }

    public class ContentConfig
    {
        public string type = "image";
        public string url = "";
        public string title = "";
    }

    public class SettingsConfig
    {
        public int fpsLimit = 30;
        public bool mute = true;
        public bool pauseOnFullscreen = true;
        public bool pauseOnBattery = true;
        public bool pauseOnLock = true;
        public bool lowPower = false;
        public string quality = "high";
    }

    public static class NativeMethods
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetParent(IntPtr child, IntPtr parent);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetParent(IntPtr child);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern uint RegisterWindowMessage(string message);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("shell32.dll")]
        public static extern int SHQueryUserNotificationState(out int state);

        [DllImport("kernel32.dll")]
        public static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

        public const uint WM_SPAWN_WORKER = 0x052C;
        public const int SW_SHOW = 5;
        public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SystemPowerStatus
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte Reserved1;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }

    public class MainForm : Form
    {
        private readonly HostConfig config;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly StreamWriter output;
        private StreamWriter controlWriter;
        private readonly object outputLock = new object();
        private readonly WebView2 webView;
        private LocalMediaServer mediaServer;
        private TcpListener listener;
        private System.Windows.Forms.Timer attachTimer;
        private System.Windows.Forms.Timer pauseTimer;
        private System.Threading.Timer parentWatchdog;
        private NativeMethods.EnumWindowsProc enumCallback;
        private uint taskbarCreatedMessage;
        private bool paused;
        private volatile bool sessionLocked;
        private string pauseReason = "";
        private bool closing;

        public MainForm(HostConfig hostConfig, StreamWriter standardOutput)
        {
            config = hostConfig;
            output = standardOutput;
            Text = "eNest wallpaper host";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Bounds = SystemInformation.VirtualScreen;
            AutoScaleMode = AutoScaleMode.None;
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.Black;
            Controls.Add(webView);
            enumCallback = new NativeMethods.EnumWindowsProc(FindWorkerWindow);
            taskbarCreatedMessage = NativeMethods.RegisterWindowMessage("TaskbarCreated");
            SystemEvents.SessionSwitch += OnSessionSwitch;
            StartControlServer();
            StartWatchdog();
            Shown += delegate { AttachToDesktop(); };
            pauseTimer = new System.Windows.Forms.Timer();
            pauseTimer.Interval = 1000;
            pauseTimer.Tick += delegate { CheckPauseRules(); };
            pauseTimer.Start();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            InitializeWebView();
        }

        protected override void WndProc(ref Message message)
        {
            if (taskbarCreatedMessage != 0 && message.Msg == (int)taskbarCreatedMessage)
            {
                AttachToDesktop();
            }
            base.WndProc(ref message);
        }

        private async void InitializeWebView()
        {
            try
            {
                if (!string.IsNullOrEmpty(config.dataDir))
                {
                    Directory.CreateDirectory(config.dataDir);
                }
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --enable-gpu-rasterization --ignore-gpu-blocklist --enable-zero-copy --enable-accelerated-video-decode --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, config.dataDir, options);
                await webView.EnsureCoreWebView2Async(environment);
                webView.ZoomFactor = QualityZoom();
                CoreWebView2 core = webView.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                core.Settings.IsWebMessageEnabled = false;
                core.Settings.IsBuiltInErrorPageEnabled = false;
                core.IsMuted = config.settings.mute;
                core.NavigationCompleted += OnNavigationCompleted;
                string url = config.content == null ? "" : config.content.url;
                if (string.IsNullOrEmpty(url))
                {
                    Emit("{\"event\":\"error\",\"message\":\"missing content url\"}");
                    return;
                }
                string navigateUrl = url;
                Uri fileUri;
                if (Uri.TryCreate(url, UriKind.Absolute, out fileUri) && fileUri.IsFile)
                {
                    bool webContent = string.Equals(config.content == null ? "image" : config.content.type, "web", StringComparison.OrdinalIgnoreCase);
                    mediaServer = new LocalMediaServer(fileUri.LocalPath, webContent);
                    mediaServer.Start();
                    navigateUrl = mediaServer.BaseUrl + (webContent ? "/index.html" : "/player.html");
                }
                Emit("{\"event\":\"navigating\",\"url\":" + serializer.Serialize(navigateUrl) + "}");
                core.Navigate(navigateUrl);
                StartAttachTimer();
                Emit("{\"event\":\"ready\"}");
            }
            catch (Exception error)
            {
                Emit("{\"event\":\"error\",\"message\":" + serializer.Serialize(error.Message) + "}");
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (!args.IsSuccess)
            {
                Emit("{\"event\":\"error\",\"message\":" + serializer.Serialize("navigation failed: " + args.WebErrorStatus + " url=" + (webView.Source == null ? "" : webView.Source.ToString()) + " http=" + args.HttpStatusCode) + "}");
                return;
            }
            ApplyContentScript();
        }

        private async void ApplyContentScript()
        {
            if (webView.CoreWebView2 == null) return;
            string type = config.content == null ? "image" : config.content.type;
            bool web = string.Equals(type, "web", StringComparison.OrdinalIgnoreCase);
            string script = BuildContentScript(web);
            try
            {
                await webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch
            {
                // 页面尚未完成或已导航；下一次事件再试。
            }
        }

        private string BuildContentScript(bool web)
        {
            string mute = config.settings.mute ? "true" : "false";
            string fps = EffectiveFpsLimit().ToString();
            string style = web ? "" :
                "var s=document.createElement('style');s.textContent='html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video,img{width:100%;height:100%;object-fit:cover}video::-webkit-media-controls{display:none!important}';document.documentElement.appendChild(s);";
            return "(function(){try{" + style +
                "var m=" + mute + ";var v=document.querySelectorAll('video,audio');for(var i=0;i<v.length;i++){try{v[i].muted=m;if(m){v[i].volume=0}else{v[i].volume=1}}catch(e){}}" +
                "var video=document.querySelector('video');if(video){video.controls=false;video.loop=true;video.autoplay=true;video.play().catch(function(){});}" +
                (web ? "" : "var fps=" + fps + ";if(fps>0&&!window.__whFpsGuard){window.__whFpsGuard=true;var raf=window.requestAnimationFrame.bind(window);var last=0;window.requestAnimationFrame=function(cb){return raf(function(t){if(t-last>=1000/fps){last=t;cb(t)}else{window.requestAnimationFrame(cb)}})}}") +
                (paused ? "var p=document.querySelectorAll('video,audio');for(var j=0;j<p.length;j++){try{p[j].pause()}catch(e){}}" : "") +
                "}catch(e){}})();";
        }

        private async void SetPaused(bool next, string reason)
        {
            if (paused == next && pauseReason == reason) return;
            paused = next;
            pauseReason = reason;
            if (webView.CoreWebView2 == null) return;
            string script = paused
                ? "document.querySelectorAll('video,audio').forEach(function(v){try{v.pause()}catch(e){}})"
                : "document.querySelectorAll('video,audio').forEach(function(v){try{v.play().catch(function(){})}catch(e){}})";
            try { await webView.CoreWebView2.ExecuteScriptAsync(script); } catch { }
            if (paused) Emit("{\"event\":\"paused\",\"reason\":" + serializer.Serialize(reason) + "}");
            else Emit("{\"event\":\"resumed\"}");
        }

        private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
        {
            if (closing) return;
            bool locked = e.Reason == SessionSwitchReason.SessionLock;
            bool unlocked = e.Reason == SessionSwitchReason.SessionUnlock;
            if (!locked && !unlocked) return;
            sessionLocked = locked;
            try { BeginInvoke(new Action(CheckPauseRules)); } catch { }
        }

        private void CheckPauseRules()
        {
            if (closing || webView.CoreWebView2 == null) return;
            string reason = "";
            if (config.settings.pauseOnLock && sessionLocked) reason = "lock";
            if (string.IsNullOrEmpty(reason) && config.settings.pauseOnFullscreen)
            {
                try
                {
                    IntPtr foreground = NativeMethods.GetForegroundWindow();
                    uint foregroundProcess;
                    NativeMethods.GetWindowThreadProcessId(foreground, out foregroundProcess);
                    bool self = foregroundProcess == (uint)Process.GetCurrentProcess().Id;
                    int state;
                    if (!self && foreground != IntPtr.Zero && NativeMethods.SHQueryUserNotificationState(out state) == 0 && (state == 2 || state == 3)) reason = "fullscreen";
                }
                catch { }
            }
            if (string.IsNullOrEmpty(reason) && config.settings.pauseOnBattery)
            {
                try
                {
                    SystemPowerStatus status;
                    if (NativeMethods.GetSystemPowerStatus(out status) && status.ACLineStatus == 0) reason = "battery";
                }
                catch { }
            }
            SetPaused(!string.IsNullOrEmpty(reason), reason);
        }

        private void StartAttachTimer()
        {
            if (attachTimer != null) return;
            attachTimer = new System.Windows.Forms.Timer();
            attachTimer.Interval = 5000;
            attachTimer.Tick += delegate
            {
                if (closing) return;
                IntPtr parent = NativeMethods.GetParent(Handle);
                if (parent == IntPtr.Zero || !NativeMethods.IsWindow(parent)) AttachToDesktop();
            };
            attachTimer.Start();
        }

        private void AttachToDesktop()
        {
            try
            {
                IntPtr progman = NativeMethods.FindWindow("Progman", null);
                IntPtr ignored;
                if (progman != IntPtr.Zero)
                {
                    NativeMethods.SendMessageTimeout(progman, NativeMethods.WM_SPAWN_WORKER, IntPtr.Zero, IntPtr.Zero, 0, 1000, out ignored);
                }
                IntPtr worker = IntPtr.Zero;
                NativeMethods.EnumWindows(enumCallback, IntPtr.Zero);
                worker = lastWorker;
                if (worker == IntPtr.Zero) worker = progman;
                if (worker == IntPtr.Zero) return;
                NativeMethods.SetParent(Handle, worker);
                Rectangle screen = SystemInformation.VirtualScreen;
                NativeMethods.SetWindowPos(Handle, NativeMethods.HWND_BOTTOM, 0, 0, screen.Width, screen.Height, NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);
                NativeMethods.ShowWindow(worker, NativeMethods.SW_SHOW);
                Emit("{\"event\":\"attached\",\"parent\":" + worker.ToInt64() + "}");
            }
            catch
            {
                // Explorer 可能正在重启；定时器会重试。
            }
        }

        private IntPtr lastWorker = IntPtr.Zero;

        private bool FindWorkerWindow(IntPtr top, IntPtr parameter)
        {
            IntPtr shellView = NativeMethods.FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shellView != IntPtr.Zero)
            {
                IntPtr worker = NativeMethods.FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                if (worker != IntPtr.Zero) lastWorker = worker;
            }
            return true;
        }

        private void StartControlServer()
        {
            try
            {
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                EmitRaw("READY " + port);
                Thread thread = new Thread(ControlLoop);
                thread.IsBackground = true;
                thread.Start();
            }
            catch (Exception error)
            {
                Emit("{\"event\":\"error\",\"message\":" + serializer.Serialize(error.Message) + "}");
            }
        }

        private void ControlLoop()
        {
            try
            {
                TcpClient client = listener.AcceptTcpClient();
                using (NetworkStream stream = client.GetStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    string first = reader.ReadLine();
                    if (string.IsNullOrEmpty(first)) return;
                    Dictionary<string, object> hello = serializer.Deserialize<Dictionary<string, object>>(first);
                    object token;
                    if (hello == null || !hello.TryGetValue("token", out token) || Convert.ToString(token) != config.token) return;
                    controlWriter = writer;
                    writer.WriteLine("{\"event\":\"ready\"}");
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (string.IsNullOrEmpty(line)) continue;
                        Dictionary<string, object> command;
                        try { command = serializer.Deserialize<Dictionary<string, object>>(line); }
                        catch { continue; }
                        if (command == null) continue;
                        object name;
                        command.TryGetValue("cmd", out name);
                        string cmd = Convert.ToString(name) ?? "";
                        if (cmd == "stop")
                        {
                            BeginInvoke(new Action(Close));
                            return;
                        }
                        if (cmd == "pause") { BeginInvoke(new Action(delegate { SetPaused(true, "command"); })); continue; }
                        if (cmd == "resume") { BeginInvoke(new Action(delegate { SetPaused(false, ""); })); continue; }
                        if (cmd == "settings")
                        {
                            object settingsValue;
                            if (command.TryGetValue("settings", out settingsValue))
                            {
                                BeginInvoke(new Action(delegate { ApplySettings(settingsValue); }));
                            }
                        }
                    }
                }
            }
            catch
            {
                if (!closing) BeginInvoke(new Action(Close));
            }
        }

        private int EffectiveFpsLimit()
        {
            int fps = Math.Max(0, Math.Min(60, config.settings.fpsLimit));
            if (!config.settings.lowPower) return fps;
            return fps == 0 ? 24 : Math.Min(fps, 24);
        }

        private double QualityZoom()
        {
            string quality = (config.settings.quality ?? "").ToLowerInvariant();
            double zoom = quality == "low" ? 0.75 : quality == "medium" ? 0.9 : 1.0;
            return config.settings.lowPower ? Math.Min(zoom, 0.9) : zoom;
        }

        private void ApplySettings(object value)
        {
            Dictionary<string, object> record = value as Dictionary<string, object>;
            if (record == null) return;
            object entry;
            if (record.TryGetValue("fpsLimit", out entry)) config.settings.fpsLimit = SafeInt(entry, config.settings.fpsLimit);
            if (record.TryGetValue("mute", out entry)) config.settings.mute = SafeBool(entry, config.settings.mute);
            if (record.TryGetValue("pauseOnFullscreen", out entry)) config.settings.pauseOnFullscreen = SafeBool(entry, config.settings.pauseOnFullscreen);
            if (record.TryGetValue("pauseOnBattery", out entry)) config.settings.pauseOnBattery = SafeBool(entry, config.settings.pauseOnBattery);
            if (record.TryGetValue("pauseOnLock", out entry)) config.settings.pauseOnLock = SafeBool(entry, config.settings.pauseOnLock);
            if (record.TryGetValue("lowPower", out entry)) config.settings.lowPower = SafeBool(entry, config.settings.lowPower);
            if (record.TryGetValue("quality", out entry)) config.settings.quality = Convert.ToString(entry) ?? config.settings.quality;
            if (webView.CoreWebView2 != null)
            {
                webView.CoreWebView2.IsMuted = config.settings.mute;
                webView.ZoomFactor = QualityZoom();
            }
            ApplyContentScript();
            CheckPauseRules();
        }

        private static int SafeInt(object value, int fallback)
        {
            try { return Convert.ToInt32(value); } catch { return fallback; }
        }

        private static bool SafeBool(object value, bool fallback)
        {
            try { return Convert.ToBoolean(value); } catch { return fallback; }
        }

        private void StartWatchdog()
        {
            parentWatchdog = new System.Threading.Timer(delegate
            {
                try
                {
                    if (config.parentPid > 0)
                    {
                        Process.GetProcessById(config.parentPid);
                        return;
                    }
                }
                catch
                {
                }
                try { BeginInvoke(new Action(Close)); } catch { }
            }, null, 2000, 2000);
        }

        private void Emit(string json)
        {
            lock (outputLock)
            {
                try { output.WriteLine(json); output.Flush(); } catch { }
                try { if (controlWriter != null) { controlWriter.WriteLine(json); controlWriter.Flush(); } } catch { }
            }
        }

        private void EmitRaw(string line)
        {
            lock (outputLock)
            {
                try { output.WriteLine(line); output.Flush(); } catch { }
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            closing = true;
            try { if (attachTimer != null) attachTimer.Stop(); } catch { }
            try { if (pauseTimer != null) pauseTimer.Stop(); } catch { }
            try { if (parentWatchdog != null) parentWatchdog.Dispose(); } catch { }
            try { if (listener != null) listener.Stop(); } catch { }
            try { SystemEvents.SessionSwitch -= OnSessionSwitch; } catch { }
            try { if (mediaServer != null) mediaServer.Dispose(); } catch { }
            base.OnFormClosed(e);
            Application.Exit();
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            try
            {
                string configPath = null;
                for (int index = 0; index < args.Length; index++)
                {
                    if (string.Equals(args[index], "--config", StringComparison.OrdinalIgnoreCase) && index + 1 < args.Length)
                    {
                        configPath = args[index + 1];
                        break;
                    }
                }
                if (string.IsNullOrEmpty(configPath) || !File.Exists(configPath))
                {
                    output.WriteLine("ERROR missing --config");
                    return;
                }
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                HostConfig config = serializer.Deserialize<HostConfig>(File.ReadAllText(configPath, Encoding.UTF8));
                if (config == null || string.IsNullOrEmpty(config.token))
                {
                    output.WriteLine("ERROR invalid config");
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (MainForm form = new MainForm(config, output))
                {
                    Application.Run(form);
                }
            }
            catch (Exception error)
            {
                output.WriteLine("ERROR " + error.Message.Replace("\r", " ").Replace("\n", " "));
            }
        }
    }
}
