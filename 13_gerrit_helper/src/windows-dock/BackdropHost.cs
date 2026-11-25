using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.UI.Composition;

// 真·亚克力底层窗口。
//
// 为什么必须走原生：Electron 的 backgroundMaterial / Acrylic 是 HWND 级的，
// 只能糊一个矩形；透明窗里的 backdrop-filter 模糊的是页面自己的合成层，
// 不是桌面。要"磨砂 + 任意轮廓"，只能自己在桌面合成器上铺一层
// HostBackdropBrush，再用几何裁剪成和网页里一模一样的形状。
//
// 协议（stdin/stdout，一行一个 JSON）：
//   收 {op:"update", id, hwnd, x, y, width, height, shapeKey, commands, opacity}
//      {op:"dispose", id}
//   发 {type:"ready"} / {type:"attached", id} / {type:"error", message}

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDesktopCompositorInterop
{
    void CreateDesktopWindowTarget(IntPtr hwnd, bool topmost, out IntPtr target);
}

class BackdropHost
{
    delegate IntPtr WindowProc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass
    {
        public uint size, style;
        public WindowProc proc;
        public int clsExtra, winExtra;
        public IntPtr instance, icon, cursor, background;
        public string menu, name;
        public IntPtr smallIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Message
    {
        public IntPtr hwnd; public uint message; public UIntPtr wparam; public IntPtr lparam;
        public uint time; public int x, y; public uint extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct QueueOptions { public int size, thread, apartment; }

    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int left, top, right, bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WindowClass data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(
        uint ex, string cls, string name, uint style, int x, int y, int w, int h,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(
        IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr hwnd, bool enable);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint delay, IntPtr proc);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("CoreMessaging.dll")] static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);

    public class Command
    {
        public string op { get; set; }
        public string id { get; set; }
        public string hwnd { get; set; }
        public string shapeKey { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public float opacity { get; set; }
        public object[][] commands { get; set; }
    }

    sealed class Surface : IDisposable
    {
        public IntPtr hwnd, owner;
        CompositionTarget target;
        ContainerVisual root;
        SpriteVisual visual;
        CompositionBrush brush;
        CompositionGeometricClip clip;
        CompositionPathGeometry path;
        CommandCurve geometry;
        string shapeKey;

        public Surface(Command command)
        {
            owner = new IntPtr(long.Parse(command.hwnd));
            // 不带重定向位图：透明像素属于桌面。
            // TOOLWINDOW / NOACTIVATE / TRANSPARENT / TOPMOST 让它不参与输入、
            // Alt-Tab 和任务栏。这里不能加任何 HWND 级材质 API —— 那个只能是矩形。
            hwnd = CreateWindowExW(
                0x00080000 | 0x08000000 | 0x00000080 | 0x00000020 | 0x00000008,
                ClassName, "Gerrit Helper Backdrop", 0x80000000,
                command.x, command.y, command.width, command.height,
                IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (hwnd == IntPtr.Zero) throw new Exception("无法创建亚克力窗口");
            EnableWindow(hwnd, false);
            try
            {
                IntPtr raw;
                ((IDesktopCompositorInterop)(object)compositor).CreateDesktopWindowTarget(hwnd, true, out raw);
                try { target = (CompositionTarget)Marshal.GetObjectForIUnknown(raw); }
                finally { Marshal.Release(raw); }
                root = compositor.CreateContainerVisual();
                root.Opacity = 0;
                brush = compositor.CreateHostBackdropBrush(); // ← 桌面背后真正的内容
                visual = compositor.CreateSpriteVisual();
                visual.Brush = brush;
                visual.BorderMode = CompositionBorderMode.Soft; // 边缘柔和过渡
                root.Children.InsertAtTop(visual);
                target.Root = root;
            }
            catch { Dispose(); throw; }
        }

        public void Update(Command command)
        {
            if (!IsWindow(owner)) throw new Exception("内容窗口已不存在");
            Rect bounds;
            if (!GetWindowRect(owner, out bounds)) throw new Exception("读不到内容窗口位置");
            int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
            var size = new Vector2(width, height);

            if (shapeKey != command.shapeKey)
            {
                var nextGeometry = new CommandCurve(command.commands);
                CompositionPathGeometry nextPath = null;
                CompositionGeometricClip nextClip = null;
                try
                {
                    nextPath = compositor.CreatePathGeometry(new CompositionPath(nextGeometry));
                    nextClip = compositor.CreateGeometricClip(nextPath);
                    visual.Clip = nextClip;
                }
                catch
                {
                    if (nextClip != null) nextClip.Dispose();
                    if (nextPath != null) nextPath.Dispose();
                    nextGeometry.Dispose();
                    throw;
                }
                if (clip != null) clip.Dispose();
                if (path != null) path.Dispose();
                if (geometry != null) geometry.Dispose();
                geometry = nextGeometry; path = nextPath; clip = nextClip;
                shapeKey = command.shapeKey;
            }

            if (root.Size != size) { root.Size = size; visual.Size = size; }
            float opacity = Math.Max(0, Math.Min(1, command.opacity));
            if (root.Opacity != opacity) root.Opacity = opacity;

            // 永远紧贴在内容窗口正下方，不能盖到文字上
            Rect previous;
            bool moved = !GetWindowRect(hwnd, out previous)
                || previous.left != bounds.left || previous.top != bounds.top
                || previous.right != bounds.right || previous.bottom != bounds.bottom;
            bool visible = IsWindowVisible(hwnd);
            bool wanted = opacity > 0 && IsWindowVisible(owner);
            bool reorder = wanted && GetWindow(hwnd, 3) != owner; // GW_HWNDPREV
            if (moved || visible != wanted || reorder)
            {
                uint flags = 0x0010 | 0x0200; // NOACTIVATE | NOOWNERZORDER
                if (!moved) flags |= 0x0003;  // NOMOVE | NOSIZE
                if (!reorder) flags |= 0x0004; // NOZORDER
                if (visible != wanted) flags |= wanted ? 0x0040u : 0x0080u;
                if (!SetWindowPos(hwnd, owner, bounds.left, bounds.top, width, height, flags))
                    throw new Exception("亚克力窗口定位失败");
            }
        }

        public bool OwnerExists() { return IsWindow(owner); }

        // 父进程卡住时不能把玻璃留在上一个位置
        public void HideIfDetached()
        {
            if (!IsWindowVisible(hwnd)) return;
            Rect a, b;
            if (!IsWindowVisible(owner) || !GetWindowRect(owner, out a) || !GetWindowRect(hwnd, out b)
                || a.left != b.left || a.top != b.top || a.right != b.right || a.bottom != b.bottom)
                ShowWindow(hwnd, 0);
        }

        public void Dispose()
        {
            if (hwnd != IntPtr.Zero) { ShowWindow(hwnd, 0); DestroyWindow(hwnd); hwnd = IntPtr.Zero; }
            if (target != null) { target.Root = null; target.Dispose(); target = null; }
            if (visual != null) { visual.Clip = null; visual.Dispose(); visual = null; }
            if (clip != null) { clip.Dispose(); clip = null; }
            if (path != null) { path.Dispose(); path = null; }
            if (geometry != null) { geometry.Dispose(); geometry = null; }
            if (brush != null) { brush.Dispose(); brush = null; }
            if (root != null) { root.Dispose(); root = null; }
        }
    }

    const string ClassName = "GerritHelperBackdrop";
    const uint UpdateMessage = 0x8001, EndMessage = 0x8002;
    static readonly WindowProc callback = Proc;
    static readonly ConcurrentQueue<string> input = new ConcurrentQueue<string>();
    static readonly Dictionary<string, Surface> surfaces = new Dictionary<string, Surface>();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static Compositor compositor;
    static IntPtr instance, host, queue;
    static Process parent;

    static void Report(object message)
    {
        Console.WriteLine(json.Serialize(message));
        Console.Out.Flush();
    }

    static void Apply(string line)
    {
        var command = json.Deserialize<Command>(line);
        if (command.op == "dispose")
        {
            Surface old;
            if (surfaces.TryGetValue(command.id, out old)) { surfaces.Remove(command.id); old.Dispose(); }
            return;
        }
        if (command.op != "update" || command.width <= 0 || command.height <= 0
            || command.width > 32768 || command.height > 32768
            || command.commands == null || String.IsNullOrEmpty(command.shapeKey))
            throw new Exception("无效的 backdrop 指令");

        Surface surface;
        bool created = !surfaces.TryGetValue(command.id, out surface);
        if (created) { surface = new Surface(command); surfaces.Add(command.id, surface); }
        surface.Update(command);
        if (created) Report(new { type = "attached", id = command.id });
    }

    static IntPtr Proc(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam)
    {
        try
        {
            if (message == 0x84) return new IntPtr(-1); // HTTRANSPARENT：不接鼠标
            if (message == 0x21) return new IntPtr(3);  // MA_NOACTIVATE
            if (message == UpdateMessage)
            {
                string line;
                while (input.TryDequeue(out line)) Apply(line);
                return IntPtr.Zero;
            }
            if (message == EndMessage) { PostQuitMessage(0); return IntPtr.Zero; }
            if (message == 0x113) // WM_TIMER：父进程没了就自己退，别留残影
            {
                if (parent.HasExited) { PostQuitMessage(0); return IntPtr.Zero; }
                foreach (var id in new List<string>(surfaces.Keys))
                {
                    var surface = surfaces[id];
                    if (!surface.OwnerExists()) { surfaces.Remove(id); surface.Dispose(); }
                    else surface.HideIfDetached();
                }
                return IntPtr.Zero;
            }
            return DefWindowProcW(hwnd, message, wparam, lparam);
        }
        catch (Exception error)
        {
            try { Report(new { type = "error", message = error.Message }); } catch { }
            PostQuitMessage(1);
            return IntPtr.Zero;
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            parent = Process.GetProcessById(int.Parse(args[0]));
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(
                new QueueOptions { size = 12, thread = 2, apartment = 2 }, out queue));
            compositor = new Compositor();

            instance = Marshal.GetHINSTANCE(typeof(BackdropHost).Module);
            var cls = new WindowClass
            {
                name = ClassName,
                size = (uint)Marshal.SizeOf(typeof(WindowClass)),
                proc = callback,
                instance = instance
            };
            if (RegisterClassExW(ref cls) == 0) throw new Exception("注册窗口类失败");
            host = CreateWindowExW(0, ClassName, "", 0, 0, 0, 0, 0,
                new IntPtr(-3) /* HWND_MESSAGE */, IntPtr.Zero, instance, IntPtr.Zero);
            if (host == IntPtr.Zero) throw new Exception("创建消息窗口失败");
            SetTimer(host, new UIntPtr(1), 500, IntPtr.Zero);

            var reader = new Thread(() =>
            {
                try
                {
                    using (var stream = new StreamReader(Console.OpenStandardInput()))
                    {
                        string line;
                        while ((line = stream.ReadLine()) != null)
                        {
                            if (line.Length > 65536) break;
                            input.Enqueue(line);
                            if (!PostMessageW(host, UpdateMessage, UIntPtr.Zero, IntPtr.Zero)) break;
                        }
                    }
                }
                catch { }
                PostMessageW(host, EndMessage, UIntPtr.Zero, IntPtr.Zero);
            });
            reader.IsBackground = true;
            reader.Start();

            Report(new { type = "ready", protocol = 1 });

            Message message;
            while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessageW(ref message);
            }
            return (int)message.wparam.ToUInt64();
        }
        catch (Exception error)
        {
            try { Report(new { type = "error", message = error.Message }); } catch { }
            return 1;
        }
        finally
        {
            foreach (var surface in surfaces.Values) surface.Dispose();
            if (host != IntPtr.Zero) DestroyWindow(host);
            if (compositor != null) compositor.Dispose();
            if (queue != IntPtr.Zero) Marshal.Release(queue);
            if (parent != null) parent.Dispose();
        }
    }
}
