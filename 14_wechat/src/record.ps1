# 通用动作录制器 —— 不预设流程，你做什么就记什么。
#
# 记四样东西，顺序就是发生顺序：
#   click  按下鼠标那一刻的光标位置，转成"相对窗口左上角"
#   paste  轮询剪贴板，内容一变就记一步（回放时用我们自己的文本）
#   key    enter / tab（发送和跳转就这两个）
#   wait   两次动作之间的停顿，超过 400ms 就记下来，回放节奏才跟手
#
# 为什么轮询而不是 SetWindowsHookEx：
#   钩子要跑消息循环、被系统判慢还会被摘钩，对"记几步"是过度设计。
#   8ms 轮询按键状态足够，也不会因为漏调 CallNextHookEx 卡住系统鼠标。
#
# 用法：
#   -Mode session   录一整段，Esc 结束 → { ok, steps:[...] }
#   -Mode single    只等一次点击 → { ok, rel, abs }（编辑器里"重录这个点"用）

param(
  [string]$Out = 'build/recorded.json',
  [string]$Mode = 'session',
  [int]$MaxClicks = 0,
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace W -Name Api -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@

function Get-WeChatWindow {
  $h = [W.Api]::FindWindow('Qt51514QWindowIcon', '微信')
  if ($h -eq [IntPtr]::Zero) { $h = [W.Api]::FindWindow('Qt51514QWindowIcon', 'Weixin') }
  if ($h -eq [IntPtr]::Zero) {
    $p = Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $h = $p.MainWindowHandle }
  }
  return $h
}

# 必须声明 DPI 感知：否则 GetCursorPos / GetWindowRect 返回的是"虚拟化"坐标，
# 在 150% 缩放的屏幕上会比物理像素小 1/1.5 —— 录出来的相对坐标拿去回放，点击会整体偏左偏上。
# 回放侧（win.ps1）一直是感知的，这里补齐两边才在同一个坐标系。
[W.Api]::SetProcessDPIAware() | Out-Null

$hwnd = Get-WeChatWindow
if ($hwnd -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $false; error = '找不到微信窗口' } | ConvertTo-Json -Compress
  exit 1
}
if ([W.Api]::IsIconic($hwnd)) { [W.Api]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 150 }
[W.Api]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 200

$rect = New-Object W.Api+RECT
[W.Api]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$left = $rect.Left
$top = $rect.Top
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ($Mode -eq 'single') { [pscustomobject]@{ ok = $true; stage = 'armed' } | ConvertTo-Json -Compress }

# ---- 录制 HUD ----------------------------------------------------------
# 录制时你要盯着微信点，坐标显示应该在屏幕上、而不是在浏览器标签里。
# 无边框 + TopMost + 不进任务栏，放在工作区右下角（避开微信窗口）。
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$hud = New-Object System.Windows.Forms.Form
$hud.FormBorderStyle = 'None'
$hud.StartPosition = 'Manual'
$hud.TopMost = $true
$hud.ShowInTaskbar = $false
$hud.BackColor = [System.Drawing.Color]::FromArgb(22, 26, 32)
$hud.Size = New-Object System.Drawing.Size(250, 58)
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$hud.Location = New-Object System.Drawing.Point(($work.Right - 270), ($work.Bottom - 78))
$hudLabel = New-Object System.Windows.Forms.Label
$hudLabel.Dock = 'Fill'
$hudLabel.AutoSize = $false
$hudLabel.TextAlign = 'MiddleLeft'
$hudLabel.Padding = New-Object System.Windows.Forms.Padding(10, 0, 0, 0)
$hudLabel.ForeColor = [System.Drawing.Color]::FromArgb(230, 237, 243)
$hudLabel.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$hudLabel.Text = "录制中…"
$hud.Controls.Add($hudLabel)
$hud.Show()
# 显示后可能抢走焦点，立刻把微信拉回来
[W.Api]::SetForegroundWindow($hwnd) | Out-Null

$steps = New-Object System.Collections.ArrayList
$lastActionAt = Get-Date
$lastWaitAt = -1
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$wasDown = $false
$wasEnter = $false
$wasTab = $false
try { $lastClip = (Get-Clipboard -Raw -ErrorAction SilentlyContinue) } catch { $lastClip = $null }
$lastClipCheck = Get-Date
$clicks = 0

function Add-Step($step) {
  $null = $steps.Add($step)
  $script:lastActionAt = Get-Date
  [pscustomobject]@{ ok = $true; stage = 'step'; step = $step } | ConvertTo-Json -Compress -Depth 5
}

$lastHud = Get-Date

while ((Get-Date) -lt $deadline) {
  $now = Get-Date

  # HUD：实时相对坐标 + 已录步数
  if (($now - $lastHud).TotalMilliseconds -ge 30) {
    $lastHud = $now
    $pt = New-Object W.Api+POINT
    [W.Api]::GetCursorPos([ref]$pt) | Out-Null
    $hudLabel.Text = "相对窗口  $($pt.X - $left), $($pt.Y - $top)`n已录 $($steps.Count) 步 · 按 Esc 结束"
    [System.Windows.Forms.Application]::DoEvents()
  }

  # 停顿也记下来（两次动作之间 ≥400ms，且这一步还没补过 wait）
  $gap = ($now - $lastActionAt).TotalMilliseconds
  if ($steps.Count -gt 0 -and $gap -ge 400 -and $lastWaitAt -ne $steps.Count) {
    $null = $steps.Add([pscustomobject]@{ type = 'wait'; ms = [int][Math]::Min(5000, $gap) })
    $lastWaitAt = $steps.Count
    [pscustomobject]@{ ok = $true; stage = 'step'; step = $steps[$steps.Count - 1] } | ConvertTo-Json -Compress
  }

  # 0x8000 = 现在还按着；0x0001 = 上次调用之后按过（能抓到极快的点击/按键）
  $stateL = [W.Api]::GetAsyncKeyState(0x01)
  $down = (($stateL -band 0x8000) -ne 0)
  $tapL = (($stateL -band 0x0001) -ne 0)
  if (($down -and -not $wasDown) -or ($tapL -and -not $wasDown)) {
    $p = New-Object W.Api+POINT
    [W.Api]::GetCursorPos([ref]$p) | Out-Null
    $inside = ($p.X -ge $left -and $p.X -lt ($left + $width) -and $p.Y -ge $top -and $p.Y -lt ($top + $height))
    if (-not $inside) { $wasDown = $down; Start-Sleep -Milliseconds 8; continue }
    $clicks += 1
    Add-Step ([pscustomobject]@{
      type = 'click'
      name = "点击 $clicks"
      rel = @{ x = $p.X - $left; y = $p.Y - $top }
      abs = @{ x = $p.X; y = $p.Y }
    })
    if ($Mode -eq 'single') { break }
    if ($MaxClicks -gt 0 -and $clicks -ge $MaxClicks) { break }
  }
  $wasDown = $down

  # 组合键：^ = Ctrl，+ = Shift，% = Alt
  $ctrlDown = (([W.Api]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0)
  $shiftDown = (([W.Api]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0)
  $altDown = (([W.Api]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0)
  foreach ($code in (0x41..0x5A) + (0x30..0x39)) {
    $st = [W.Api]::GetAsyncKeyState($code)
    $tapped = ((($st -band 0x0001) -ne 0) -or (($st -band 0x8000) -ne 0))
    if (-not $tapped) { continue }
    $char = [char]$code
    # Windows PowerShell 5.1 不支持 `if` 当表达式用，只能这样拼
    $chord = ''
    if ($ctrlDown) { $chord += '^' }
    if ($altDown) { $chord += '%' }
    if ($shiftDown) { $chord += '+' }
    $chord += $char.ToString().ToLower()
    # Ctrl+V 不记：粘贴那一步已经代表它了，再记一遍回放会粘两次
    if ($chord -eq "^v") { continue }
    if ($script:heldKeys -notcontains $code) {
      $script:heldKeys += $code
      Add-Step ([pscustomobject]@{ type = 'key'; key = $chord })
    }
  }
  # 松开后清掉，才能再记下一次
  $script:heldKeys = @($script:heldKeys | Where-Object { (([W.Api]::GetAsyncKeyState($_)) -band 0x8000) -ne 0 })

  $stateEnter = [W.Api]::GetAsyncKeyState(0x0D)
  $enter = ((($stateEnter -band 0x8000) -ne 0) -or (($stateEnter -band 0x0001) -ne 0))
  if ($enter -and -not $wasEnter) { Add-Step ([pscustomobject]@{ type = 'key'; key = 'enter' }) }
  $wasEnter = $enter

  $stateTab = [W.Api]::GetAsyncKeyState(0x09)
  $tab = ((($stateTab -band 0x8000) -ne 0) -or (($stateTab -band 0x0001) -ne 0))
  if ($tab -and -not $wasTab) { Add-Step ([pscustomobject]@{ type = 'key'; key = 'tab' }) }
  $wasTab = $tab

  if (($now - $lastClipCheck).TotalMilliseconds -gt 150) {
    $lastClipCheck = $now
    try {
      $current = (Get-Clipboard -Raw -ErrorAction SilentlyContinue)
      $ours = ([W.Api]::GetForegroundWindow() -eq $hwnd)
      if ($current -and $current -ne $lastClip -and $ours) {
        $lastClip = $current
        Add-Step ([pscustomobject]@{ type = 'paste'; text = $current })
      }
    } catch { }
  }

  if ($Mode -ne 'single' -and (([W.Api]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0)) { break }

  Start-Sleep -Milliseconds 8
}

if ($Mode -eq 'single') {
  $click = $steps | Where-Object { $_.type -eq 'click' } | Select-Object -First 1
  if ($click) { [pscustomobject]@{ ok = $true; rel = $click.rel; abs = $click.abs } | ConvertTo-Json -Compress }
  else { [pscustomobject]@{ ok = $false; error = '没有捕获到点击' } | ConvertTo-Json -Compress }
  exit 0
}

if ($hud) { $hud.Close(); $hud.Dispose() }

$payload = [pscustomobject]@{
  ok = $true
  mode = 'session'
  recordedAt = (Get-Date).ToString('s')
  window = @{ class = 'Qt51514QWindowIcon'; left = $left; top = $top; width = $width; height = $height }
  steps = @($steps)
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8
[pscustomobject]@{ ok = $true; stage = 'saved'; path = $Out; steps = $steps.Count } | ConvertTo-Json -Compress
