using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class ShellLayer {
    internal delegate bool EnumProc(IntPtr window, IntPtr unused);
    [StructLayout(LayoutKind.Sequential)] internal struct Corners { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct Device {
        public int size; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string description; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string id; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string key;
    }
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc callback,IntPtr unused);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern IntPtr FindWindowEx(IntPtr parent,IntPtr previous,string type,string title);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern int GetClassName(IntPtr window,StringBuilder name,int size);
    [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr window,uint command);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr window,out Corners frame);
    [DllImport("user32.dll")] internal static extern int MapWindowPoints(IntPtr from,IntPtr to,ref Corners frame,uint count);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern bool EnumDisplayDevices(string adapter,uint index,ref Device device,uint flags);
    internal static string MonitorId(Screen screen){Device device=new Device();device.size=Marshal.SizeOf(typeof(Device));if(!EnumDisplayDevices(screen.DeviceName,0,ref device,1)||String.IsNullOrEmpty(device.id))throw new Exception("无法获取显示器的稳定标识。");using(SHA256 sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(device.id))).Replace("-","");}
    internal static IntPtr DesktopView(out IntPtr host){IntPtr shell=GetShellWindow(),view=IntPtr.Zero,group=IntPtr.Zero;uint owner;GetWindowThreadProcessId(shell,out owner);
        if(shell!=IntPtr.Zero&&owner!=0)EnumWindows(delegate(IntPtr window,IntPtr unused){uint process;GetWindowThreadProcessId(window,out process);if(process!=owner||!IsWindowVisible(window))return true;StringBuilder name=new StringBuilder(64);GetClassName(window,name,64);if(name.ToString()!="Progman"&&name.ToString()!="WorkerW")return true;
            IntPtr candidate=FindWindowEx(window,IntPtr.Zero,"SHELLDLL_DefView",null);if(candidate==IntPtr.Zero||!IsWindowVisible(candidate)||FindWindowEx(candidate,IntPtr.Zero,"SysListView32",null)==IntPtr.Zero)return true;view=candidate;group=window;return false;},IntPtr.Zero);host=group;return view;}
    internal static bool Above(IntPtr window,IntPtr view){for(IntPtr sibling=GetWindow(window,2);sibling!=IntPtr.Zero;sibling=GetWindow(sibling,2))if(sibling==view)return true;return false;}
}

internal sealed class DesktopForm:Form {
    internal IntPtr ShellParent;
    protected override CreateParams CreateParams { get {CreateParams result=base.CreateParams;result.Parent=ShellParent;result.Style=(result.Style&~unchecked((int)0x80cf0000))|0x46000000;result.ExStyle=(result.ExStyle & ~0x40000)|0x80;return result;} }
    protected override bool ShowWithoutActivation {get{return true;}}
}
internal sealed class MonitorSurface:IDisposable {
    internal readonly Screen Screen;internal readonly string Id;internal readonly DesktopForm Window;internal readonly WebView2 View;internal bool Ready;internal bool Painted;
    internal MonitorSurface(Screen screen,IntPtr parent){Screen=screen;Id=ShellLayer.MonitorId(screen);Window=new DesktopForm{ShellParent=parent,Text="eNest 自由桌面",FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,AutoScaleMode=AutoScaleMode.None,StartPosition=FormStartPosition.Manual,BackColor=Color.FromArgb(47,82,83)};View=new WebView2{Dock=DockStyle.Fill};Window.Controls.Add(View);var handle=Window.Handle;}
    public void Dispose(){View.Dispose();Window.Dispose();}
}
internal sealed class DesktopLoop:ApplicationContext {
    readonly Control dispatcher=new Control();readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=6*1024*1024,RecursionLimit=40};
    readonly Dictionary<string,MonitorSurface> monitors=new Dictionary<string,MonitorSurface>();readonly string page,cache;readonly System.Windows.Forms.Timer health=new System.Windows.Forms.Timer{Interval=1200};CoreWebView2Environment browser;IntPtr host,desktop;int generation;bool closing,initialized;
    internal DesktopLoop(string assets){page=new Uri(Path.Combine(assets,"native.html")).AbsoluteUri;cache=Path.Combine(Path.GetTempPath(),"enest-free-desktop-"+Guid.NewGuid().ToString("N"));var handle=dispatcher.Handle;
        health.Tick+=delegate{try{if(monitors.Values.Any(item=>item.Painted)&&(!ShellLayer.IsWindowVisible(host)||!ShellLayer.IsWindowVisible(desktop)||monitors.Values.Any(item=>item.Painted&&!Valid(item))))Fail("Explorer 桌面层已改变，已退出接管。");}catch{Fail("Explorer 桌面句柄已失效，已退出接管。");}};
        SystemEvents.DisplaySettingsChanged+=DisplayChanged;new Thread(ReadInput){IsBackground=true}.Start();}
    void Post(Action action){try{if(!closing)dispatcher.BeginInvoke(action);}catch(InvalidOperationException){} }
    void Write(object value){Console.Out.WriteLine(json.Serialize(value));Console.Out.Flush();}
    void Fail(string reason){if(closing)return;Write(new { @event="error", reason=reason });ExitThread();}
    void DisplayChanged(object sender,EventArgs args){Post(delegate{if(initialized&&browser!=null)Rebuild();});}
    void ReadInput(){try{using(var stream=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false,true))){var pending=new StringBuilder();var chunk=new char[8192];int count;while((count=stream.Read(chunk,0,chunk.Length))>0){int start=0;for(int index=0;index<count;index++)if(chunk[index]=='\n'){pending.Append(chunk,start,index-start);if(pending.Length>5*1024*1024)throw new InvalidDataException();string line=pending.ToString();pending.Length=0;start=index+1;dispatcher.Invoke((Action)(()=>Receive(line)));}pending.Append(chunk,start,count-start);if(pending.Length>5*1024*1024)throw new InvalidDataException();}}}catch{}finally{Post(ExitThread);}}
    static string Member(Dictionary<string,object> obj,string name){object value;return obj.TryGetValue(name,out value)?value as string:null;}
    async void Receive(string line){try{var packet=json.Deserialize<Dictionary<string,object>>(line);string op=Member(packet,"op");if(op=="init"){if(initialized)return;initialized=true;browser=await CoreWebView2Environment.CreateAsync(null,cache,new CoreWebView2EnvironmentOptions("--disable-extensions"));if(!closing)Rebuild();return;}
        if(op!="render"&&op!="wallpaper"&&op!="notice")return;string id=Member(packet,"screen");foreach(var item in monitors.Values.ToArray()){if(!item.Ready||(!String.IsNullOrEmpty(id)&&id!=item.Id))continue;await item.View.CoreWebView2.ExecuteScriptAsync("window.enestDesktopReceive("+line+")");if(closing||!monitors.ContainsValue(item))return;if(op=="render"&&!item.Painted){item.Window.Show();if(!Place(item)||!Valid(item)){Fail("系统拒绝可交互的桌面层，恢复普通工作区。");return;}item.Painted=true;}}}
        catch{if(!closing)Fail("WebView2 或桌面控制通道不可用，恢复普通工作区。");}}
    bool Place(MonitorSurface item){Rectangle rect=item.Screen.Bounds;var bounds=new ShellLayer.Corners{left=rect.Left,top=rect.Top,right=rect.Right,bottom=rect.Bottom};ShellLayer.MapWindowPoints(IntPtr.Zero,host,ref bounds,2);return ShellLayer.SetWindowPos(item.Window.Handle,IntPtr.Zero,bounds.left,bounds.top,bounds.right-bounds.left,bounds.bottom-bounds.top,0x0010|0x0020);}
    bool Valid(MonitorSurface item){ShellLayer.Corners frame;Rectangle want=item.Screen.Bounds;return ShellLayer.IsWindow(host)&&ShellLayer.GetParent(item.Window.Handle)==host&&ShellLayer.GetParent(desktop)==host&&ShellLayer.Above(item.Window.Handle,desktop)&&ShellLayer.GetWindowRect(item.Window.Handle,out frame)&&Math.Abs(frame.left-want.Left)<=2&&Math.Abs(frame.top-want.Top)<=2&&Math.Abs(frame.right-want.Right)<=2&&Math.Abs(frame.bottom-want.Bottom)<=2;}
    object Descriptor(MonitorSurface item){uint dpi=ShellLayer.GetDpiForWindow(item.Window.Handle);if(dpi==0)throw new Exception();double scale=96.0/dpi;Rectangle full=item.Screen.Bounds,work=item.Screen.WorkingArea;return new {id=item.Id,label=item.Screen.DeviceFriendlyName(),primary=item.Screen.Primary,insets=new {left=(work.Left-full.Left)*scale,top=(work.Top-full.Top)*scale,right=(full.Right-work.Right)*scale,bottom=(full.Bottom-work.Bottom)*scale}};}
    async void Rebuild(){int own=++generation;try{health.Stop();foreach(var item in monitors.Values)item.Dispose();monitors.Clear();desktop=ShellLayer.DesktopView(out host);if(desktop==IntPtr.Zero||host==IntPtr.Zero)throw new Exception();Screen[] all=Screen.AllScreens;if(all.Length<1||all.Length>16)throw new Exception();
        foreach(var screen in all){var item=new MonitorSurface(screen,host);monitors.Add(item.Id,item);if(!Place(item)||!Valid(item))throw new Exception();}
        foreach(var item in monitors.Values.ToArray()){await item.View.EnsureCoreWebView2Async(browser);if(own!=generation||closing)return;var core=item.View.CoreWebView2;core.Settings.AreDevToolsEnabled=false;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;core.Settings.AreDefaultScriptDialogsEnabled=false;core.Settings.IsStatusBarEnabled=false;core.Settings.IsZoomControlEnabled=false;
            core.NavigationStarting+=(sender,args)=>{if(!String.Equals(args.Uri,page,StringComparison.OrdinalIgnoreCase))args.Cancel=true;};core.NewWindowRequested+=(sender,args)=>{args.Handled=true;};core.PermissionRequested+=(sender,args)=>{args.State=CoreWebView2PermissionState.Deny;};core.DownloadStarting+=(sender,args)=>{args.Cancel=true;};core.ProcessFailed+=(sender,args)=>{if(own==generation&&!closing)Fail("桌面网页进程已退出。");};
            core.WebMessageReceived+=(sender,args)=>{if(own!=generation||closing||!String.Equals(args.Source,page,StringComparison.OrdinalIgnoreCase))return;string text=args.TryGetWebMessageAsString();if(text==null||text.Length>20000)return;var action=json.Deserialize<Dictionary<string,object>>(text);if(Member(action,"action")=="ready"){item.Ready=true;if(monitors.Values.All(monitor=>monitor.Ready))Write(new {@event="attached",screens=monitors.Values.Select(Descriptor).ToArray()});}else Write(new {@event="action",screen=item.Id,action=action});};core.Navigate(page);
        }health.Start();}catch{if(own==generation&&!closing)Fail("未找到可交互且低于应用的 Explorer 桌面层，保留普通工作区。");}}
    protected override void ExitThreadCore(){if(closing)return;closing=true;++generation;health.Stop();SystemEvents.DisplaySettingsChanged-=DisplayChanged;foreach(var item in monitors.Values)item.Dispose();monitors.Clear();dispatcher.Dispose();base.ExitThreadCore();try{Directory.Delete(cache,true);}catch(IOException){}catch(UnauthorizedAccessException){} }
}
internal static class Program {
    internal static string DeviceFriendlyName(this Screen screen){ShellLayer.Device device=new ShellLayer.Device();device.size=Marshal.SizeOf(typeof(ShellLayer.Device));return ShellLayer.EnumDisplayDevices(screen.DeviceName,0,ref device,1)&&!String.IsNullOrWhiteSpace(device.description)?device.description:screen.DeviceName;}
    [STAThread] static int Main(string[] args){if(args.Length!=1)return 2;Console.OutputEncoding=new UTF8Encoding(false);try{if(!ShellLayer.SetProcessDpiAwarenessContext(new IntPtr(-4)))throw new Exception();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new DesktopLoop(Path.GetFullPath(args[0])));return 0;}catch{Console.WriteLine("{\"event\":\"error\",\"reason\":\"Windows desktop layer unavailable\"}");return 1;}}
}
