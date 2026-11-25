using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Windows.Graphics;

// 把渲染层那套 M / L / C / Z 命令列表变成 D2D 几何，交给 CompositionPathGeometry。
// 这样原生材质和网页里画的轮廓用的是同一份数据，边缘不会差一个像素。
//
// ICurveGeometryInterop 是 windows.graphics.interop.h 里的公开契约
// （第三方几何接入 Composition 的官方口子），不是私有 API。

[ComVisible(true), Guid("0657AF73-53FD-47CF-84FF-C8492D2A80A3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICurveGeometryInterop
{
    [PreserveSig] int GetGeometry(out IntPtr geometry);
    [PreserveSig] int TryGetGeometryUsingFactory(IntPtr factory, out IntPtr geometry);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class CommandCurve : IGeometrySource2D, ICurveGeometryInterop, IDisposable
{
    [StructLayout(LayoutKind.Sequential)] public struct Point { public float X, Y; public Point(float x, float y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct Bezier { public Point A, B, C; }
    [StructLayout(LayoutKind.Sequential)] public struct Bounds { public float Left, Top, Right, Bottom; }

    [DllImport("d2d1.dll")]
    static extern int D2D1CreateFactory(uint type, ref Guid iid, IntPtr options, out IntPtr factory);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreatePathFn(IntPtr self, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OpenPathFn(IntPtr self, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SinkCallFn(IntPtr self, uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void BeginFigureFn(IntPtr self, Point point, uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void AddLineFn(IntPtr self, Point point);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void AddBezierFn(IntPtr self, ref Bezier curve);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CloseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBoundsFn(IntPtr self, IntPtr transform, out Bounds bounds);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ContainsFn(IntPtr self, Point point, IntPtr transform, float tolerance, out int contains);

    IntPtr factory, geometry;

    static T Method<T>(IntPtr instance, int slot)
    {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size), typeof(T));
    }

    public CommandCurve(IEnumerable<object[]> commands)
    {
        var iid = new Guid("06152247-6F50-465A-9245-118BFD3B6007"); // ID2D1Factory
        Marshal.ThrowExceptionForHR(D2D1CreateFactory(0, ref iid, IntPtr.Zero, out factory));
        try
        {
            Marshal.ThrowExceptionForHR(Method<CreatePathFn>(factory, 10)(factory, out geometry));
            IntPtr sink;
            Marshal.ThrowExceptionForHR(Method<OpenPathFn>(geometry, 17)(geometry, out sink));
            try
            {
                Method<SinkCallFn>(sink, 3)(sink, 1); // SetFillMode(WINDING)
                bool open = false;
                foreach (var command in commands)
                {
                    string op = (string)command[0];
                    if (op == "M")
                    {
                        if (open) Method<SinkCallFn>(sink, 8)(sink, 1); // EndFigure(closed)
                        Method<BeginFigureFn>(sink, 5)(sink, new Point(Convert.ToSingle(command[1]), Convert.ToSingle(command[2])), 0);
                        open = true;
                    }
                    else if (op == "L")
                    {
                        Method<AddLineFn>(sink, 10)(sink, new Point(Convert.ToSingle(command[1]), Convert.ToSingle(command[2])));
                    }
                    else if (op == "C")
                    {
                        var curve = new Bezier
                        {
                            A = new Point(Convert.ToSingle(command[1]), Convert.ToSingle(command[2])),
                            B = new Point(Convert.ToSingle(command[3]), Convert.ToSingle(command[4])),
                            C = new Point(Convert.ToSingle(command[5]), Convert.ToSingle(command[6]))
                        };
                        Method<AddBezierFn>(sink, 11)(sink, ref curve);
                    }
                    else if (op == "Z")
                    {
                        Method<SinkCallFn>(sink, 8)(sink, 1);
                        open = false;
                    }
                    else throw new ArgumentException("Unsupported command: " + op);
                }
                if (open) Method<SinkCallFn>(sink, 8)(sink, 1);
                Marshal.ThrowExceptionForHR(Method<CloseFn>(sink, 9)(sink));
            }
            finally { Marshal.Release(sink); }
        }
        catch { Dispose(); throw; }
    }

    public Bounds GetBounds()
    {
        Bounds result;
        Marshal.ThrowExceptionForHR(Method<GetBoundsFn>(geometry, 4)(geometry, IntPtr.Zero, out result));
        return result;
    }

    public bool Contains(float x, float y)
    {
        int result;
        Marshal.ThrowExceptionForHR(Method<ContainsFn>(geometry, 7)(
            geometry, new Point(x, y), IntPtr.Zero, 0.25f, out result));
        return result != 0;
    }

    public int GetGeometry(out IntPtr value)
    {
        value = geometry;
        if (value == IntPtr.Zero) return unchecked((int)0x80004005);
        Marshal.AddRef(value);
        return 0;
    }

    public int TryGetGeometryUsingFactory(IntPtr source, out IntPtr value)
    {
        value = IntPtr.Zero;
        return unchecked((int)0x80004001); // E_NOTIMPL：走 GetGeometry 那条
    }

    public void Dispose()
    {
        if (geometry != IntPtr.Zero) { Marshal.Release(geometry); geometry = IntPtr.Zero; }
        if (factory != IntPtr.Zero) { Marshal.Release(factory); factory = IntPtr.Zero; }
        GC.SuppressFinalize(this);
    }

    ~CommandCurve() { Dispose(); }
}
