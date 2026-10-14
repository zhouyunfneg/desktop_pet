param(
  [int]$GrabX = 1496,
  [int]$GrabY = 736,
  [int]$GrabW = 420,
  [int]$GrabH = 340,
  [string]$Out = ".shots\qa-click.png",
  [ValidateSet("click", "right", "none")]
  [string]$Action = "click",
  # 从改鼠标位置到点击之间的等待。给长了狗会走出光标（它一直在踱步），
  # 250ms 足够 IPC 一个来回（<5ms）。
  [int]$SettleMs = 250,
  # 自动瞄准：先抓一帧，按柴犬主色的像素质心算出狗在屏幕上的位置，再点它。
  # 狗会在画布里走动，写死坐标会打偏。
  [switch]$AutoAim
)

# 手工 QA 探针：用真实系统鼠标事件走一遍「穿透 → 热区 → 恢复交互 → 抚摸反馈」链路，
# 点击后立刻抓帧，否则 happy 动画(1.15s)和爱心(约1.6s)就过去了。
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
public struct POINT { public int X; public int Y; }
'@ -Name Win32Mouse -Namespace N

$dir = Split-Path $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$full = Join-Path $PWD $Out

function Grab([string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $GrabW, $GrabH
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($GrabX, $GrabY, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($path)
  return $bmp
}

function Find-DogCenter([System.Drawing.Bitmap]$bmp) {
  # 柴犬主色 #E9A25C = (233,162,92)；只扫这一族颜色，步长 3 像素足够快
  $sx = 0; $sy = 0; $n = 0
  for ($y = 0; $y -lt $bmp.Height; $y += 3) {
    for ($x = 0; $x -lt $bmp.Width; $x += 3) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -gt 200 -and $c.R -lt 250 -and $c.G -gt 130 -and $c.G -lt 185 -and $c.B -lt 125) {
        $sx += $x; $sy += $y; $n++
      }
    }
  }
  if ($n -lt 30) { return $null }
  return @{ x = $GrabX + [int]($sx / $n); y = $GrabY + [int]($sy / $n); count = $n }
}

$target = $null
if ($AutoAim) {
  $probe = Grab (Join-Path $PWD ".shots\qa-probe.png")
  $target = Find-DogCenter $probe
  $probe.Dispose()
  if (-not $target) { Write-Output "没在抓帧里找到狗的颜色像素，放弃自动瞄准"; exit 2 }
  Write-Output ("dog center: x={0} y={1} (px={2})" -f $target.x, $target.y, $target.count)
  $X = $target.x
  # 质心在躯干中部，往上偏一点更靠近身体而不是两腿之间的空隙
  $Y = $target.y - 6
} else {
  $X = $GrabX + 190
  $Y = $GrabY + 250
}

[void][N.Win32Mouse]::SetCursorPos($X, $Y)
# 先 ESC 一下：上一个测试遗留的原生菜单会 grab 住所有鼠标输入，
# 不先退掉的话本应送达宠物窗口的点击会被菜单吞掉，看起来像「交互失效」。
[N.Win32Mouse]::keybd_event(0x1B, 0, 0, 0)
[N.Win32Mouse]::keybd_event(0x1B, 0, 2, 0)
Start-Sleep -Milliseconds $SettleMs
$pt = New-Object N.WIN32Mouse+POINT
[void][N.Win32Mouse]::GetCursorPos([ref]$pt)
Write-Output "cursor at: $($pt.X),$($pt.Y)"

switch ($Action) {
  "click" {
    [N.Win32Mouse]::mouse_event(2, 0, 0, 0, 0)   # LEFTDOWN
    [N.Win32Mouse]::mouse_event(4, 0, 0, 0, 0)   # LEFTUP
  }
  "right" {
    [N.Win32Mouse]::mouse_event(8, 0, 0, 0, 0)   # RIGHTDOWN
    [N.Win32Mouse]::mouse_event(16, 0, 0, 0, 0)  # RIGHTUP
  }
}
Start-Sleep -Milliseconds 320

$shot = Grab $full
$shot.Dispose()
Write-Output "saved $full"
