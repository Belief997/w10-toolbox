# 微信操作的原语。全部返回单行 JSON，由 Node 侧解析。
#
# 为什么用 PowerShell 而不是加原生模块：
#   截图（System.Drawing）、Win32 键鼠（user32）、OCR（WinRT）这三样
#   Windows PowerShell 5.1 全都自带，不需要编译，也不引第三方依赖。
# 代价是每次调用都要起一个进程（~200-400ms），所以一个动作一次调用，
# 流程编排放在 Node 里，纯逻辑（diff / 定位）留在 Node 侧好测。

param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Out,
  [string]$In,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = ''
)

$ErrorActionPreference = 'Stop'
# 输出用 UTF-8：默认按控制台代码页走，中文 OCR 结果到 Node 那边就成乱码了
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace Win32 -Name Api -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, int e);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@

# 高 DPI：不设这个，截出来的是缩放后的坐标，跟鼠标注入对不上
[Win32.Api]::SetProcessDPIAware() | Out-Null

function Get-WeChatWindow {
  # 4.x 的窗口类是 Qt51514QWindowIcon，标题是「微信」；
  # 不同小版本标题可能是 Weixin，所以按进程兜底
  $h = [Win32.Api]::FindWindow('Qt51514QWindowIcon', '微信')
  if ($h -eq [IntPtr]::Zero) { $h = [Win32.Api]::FindWindow('Qt51514QWindowIcon', 'Weixin') }
  if ($h -eq [IntPtr]::Zero) {
    $p = Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $h = $p.MainWindowHandle }
  }
  return $h
}

function Get-WindowPid($h) {
  if ($h -eq [IntPtr]::Zero) { return 0 }
  $p = 0
  [Win32.Api]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  return [int]$p
}

# 微信的联想框 / 搜索面板是独立的顶层窗口（类名 Qt51514QWindowToolSaveBits），
# hwnd 跟主窗口不一样，但同属 Weixin.exe 进程 —— 挡在上面也不能算"别的窗口"
function Test-SameApp($h, $wechat) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  if ($h -eq $wechat) { return $true }
  $a = Get-WindowPid $h
  return ($a -ne 0 -and $a -eq (Get-WindowPid $wechat))
}

function Get-Rect($h) {
  $r = New-Object Win32.Api+RECT
  [Win32.Api]::GetWindowRect($h, [ref]$r) | Out-Null
  return @{ left = $r.Left; top = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
}

# 键码表：只列流程里用得到的
# 组合键写法沿用 SendKeys 的约定：^ = Ctrl，+ = Shift，% = Alt，后面跟字母/数字/enter/tab/esc/space
function KeyCode([string]$name) {
  $lower = $name.ToLower()
  if ($lower.Length -eq 1) {
    if ($lower -ge 'a' -and $lower -le 'z') { return [byte](0x41 + ([int][char]$lower - 97)) }
    if ($lower -ge '0' -and $lower -le '9') { return [byte](0x30 + ([int][char]$lower - 48)) }
  }
  $map = @{ 'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27 }
  if (-not $map.ContainsKey($lower)) { throw "不认识的按键: $name" }
  return [byte]$map[$lower]
}

function Send-Chord([string]$keys) {
  # 形如 "^v" / "^+a" / "%{ENTER}" / "{ESC}"
  $ctrl = $false; $shift = $false; $alt = $false
  while ($keys.Length -gt 0) {
    $ch = $keys[0]
    if ($ch -eq '^') { $ctrl = $true; $keys = $keys.Substring(1) }
    elseif ($ch -eq '+') { $shift = $true; $keys = $keys.Substring(1) }
    elseif ($ch -eq '%') { $alt = $true; $keys = $keys.Substring(1) }
    else { break }
  }
  $name = $keys.Trim('{', '}')
  $code = KeyCode $name
  if ($ctrl) { [Win32.Api]::keybd_event(0x11, 0, 0, 0) }
  if ($alt) { [Win32.Api]::keybd_event(0x12, 0, 0, 0) }
  if ($shift) { [Win32.Api]::keybd_event(0x10, 0, 0, 0) }
  [Win32.Api]::keybd_event($code, 0, 0, 0)
  Start-Sleep -Milliseconds 15
  [Win32.Api]::keybd_event($code, 0, 2, 0)
  if ($shift) { [Win32.Api]::keybd_event(0x10, 0, 2, 0) }
  if ($alt) { [Win32.Api]::keybd_event(0x12, 0, 2, 0) }
  if ($ctrl) { [Win32.Api]::keybd_event(0x11, 0, 2, 0) }
}

function Await-Task($task, $type) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $net = $asTask.MakeGenericMethod($type).Invoke($null, @($task))
  $net.Wait(-1) | Out-Null
  return $net.Result
}

switch ($Action) {
  'window' {
    $h = Get-WeChatWindow
    if ($h -eq [IntPtr]::Zero) { [pscustomobject]@{ ok = $false; error = '找不到微信窗口' } | ConvertTo-Json -Compress; break }
    $rect = Get-Rect $h
    [pscustomobject]@{ ok = $true; hwnd = $h.ToInt64(); rect = $rect; iconic = [Win32.Api]::IsIconic($h) } | ConvertTo-Json -Compress
  }

  'focus' {
    $h = Get-WeChatWindow
    if ($h -eq [IntPtr]::Zero) { [pscustomobject]@{ ok = $false; error = '找不到微信窗口' } | ConvertTo-Json -Compress; break }
    if ([Win32.Api]::IsIconic($h)) { [Win32.Api]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 200 }

    # Windows 有前台锁：不是"用户正在操作的进程"时 SetForegroundWindow 会静默失败。
    # 常见做法是把自己 attach 到当前前台线程上，借它的权限抢一次前台。
    [Win32.Api]::AllowSetForegroundWindow(-1) | Out-Null
    $fg = [Win32.Api]::GetForegroundWindow()
    $fgThread = [Win32.Api]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $myThread = [Win32.Api]::GetCurrentThreadId()
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
      $attached = [Win32.Api]::AttachThreadInput($myThread, $fgThread, $true)
    }
    try {
      [Win32.Api]::BringWindowToTop($h) | Out-Null
      [Win32.Api]::SetForegroundWindow($h) | Out-Null
      # 抢前台是异步的，给几次机会再判死
      for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 60
        if ([Win32.Api]::GetForegroundWindow() -eq $h) { break }
        [Win32.Api]::SetForegroundWindow($h) | Out-Null
      }
    } finally {
      if ($attached) { [Win32.Api]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
    }
    $now = [Win32.Api]::GetForegroundWindow()

    # 还抢不到就退回"点它一下"：真实鼠标输入会自然把窗口带到前台，
    # 这条路径能绕过 UIPI —— 前台如果是提权窗口（比如管理员模式跑的编辑器），
    # SetForegroundWindow / AttachThreadInput 都会被拒，但点一下还是有效的。
    if ($now -ne $h) {
      $r = Get-Rect $h
      $pt = New-Object Win32.Api+POINT
      $pt.X = $r.left + 40
      $pt.Y = $r.top + 10
      $under = [Win32.Api]::GetAncestor([Win32.Api]::WindowFromPoint($pt), 2)
      if ($under -eq $h) {
        [Win32.Api]::SetCursorPos($pt.X, $pt.Y) | Out-Null
        Start-Sleep -Milliseconds 40
        [Win32.Api]::mouse_event(0x0002, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 30
        [Win32.Api]::mouse_event(0x0004, 0, 0, 0, 0)
        for ($i = 0; $i -lt 8; $i++) {
          Start-Sleep -Milliseconds 50
          if ([Win32.Api]::GetForegroundWindow() -eq $h) { break }
        }
        $now = [Win32.Api]::GetForegroundWindow()
      }
    }

    $fgInfo = @{ ok = (Test-SameApp $now $h); foreground = $now.ToInt64(); hwnd = $h.ToInt64(); rect = (Get-Rect $h) }
    if (-not $fgInfo.ok) {
      $fgInfo.hint = '前台被别的窗口占着，且那个窗口挡在微信上面（提权窗口 / 全屏应用最常见）'
    }
    [pscustomobject]$fgInfo | ConvertTo-Json -Compress
  }

  'verify' {
    $h = Get-WeChatWindow
    $fg = [Win32.Api]::GetForegroundWindow()
    [pscustomobject]@{ ok = ($h -ne [IntPtr]::Zero -and (Test-SameApp $fg $h)); hwnd = $h.ToInt64(); foreground = $fg.ToInt64() } | ConvertTo-Json -Compress
  }

  'key' { Send-Chord $Text; [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress }

  'hit' {
    # 屏幕上那个点最上面是哪个顶层窗口 —— 坐标被别的窗口盖住时可以提前发现
    $pt = New-Object Win32.Api+POINT
    $pt.X = $X; $pt.Y = $Y
    $child = [Win32.Api]::WindowFromPoint($pt)
    $root = [Win32.Api]::GetAncestor($child, 2)
    $h = Get-WeChatWindow
    $target = if ($root -ne [IntPtr]::Zero) { $root } else { $child }
    [pscustomobject]@{
      ok = $true
      hwnd = $target.ToInt64()
      wechat = $h.ToInt64()
      pid = (Get-WindowPid $target)
      wechatPid = (Get-WindowPid $h)
      isWeChat = (Test-SameApp $target $h)
    } | ConvertTo-Json -Compress
  }

  'click' {
    [Win32.Api]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 60
    [Win32.Api]::mouse_event(0x0002, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 40
    [Win32.Api]::mouse_event(0x0004, 0, 0, 0, 0)
    [pscustomobject]@{ ok = $true; x = $X; y = $Y } | ConvertTo-Json -Compress
  }

  'clip' {
    Set-Clipboard -Value $Text
    [pscustomobject]@{ ok = $true; length = $Text.Length } | ConvertTo-Json -Compress
  }

  'shot' {
    $h = Get-WeChatWindow
    if ($h -eq [IntPtr]::Zero) { [pscustomobject]@{ ok = $false; error = '找不到微信窗口' } | ConvertTo-Json -Compress; break }
    $r = Get-Rect $h
    # 存 BMP：无压缩，Node 侧几行就能解析出像素做 diff
    $bmp = New-Object System.Drawing.Bitmap $r.width, $r.height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.left, $r.top, 0, 0, $bmp.Size)
    $g.Dispose()
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    [pscustomobject]@{ ok = $true; path = $Out; rect = $r } | ConvertTo-Json -Compress
  }

  default { [pscustomobject]@{ ok = $false; error = "未知动作: $Action" } | ConvertTo-Json -Compress }
}
