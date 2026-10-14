param([string]$ProcName = "electron")
# Print the real window rect of the pet process and grab exactly that region.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI when
# there is no BOM, so any Chinese literal (even a default param value) turns into
# mojibake and silently breaks string matching.
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name W32 -Namespace Q

$found = 0
foreach ($p in Get-Process -Name $ProcName -ErrorAction SilentlyContinue) {
  $h = $p.MainWindowHandle
  if ($h -eq 0) { continue }
  $r = New-Object Q.W32+RECT
  [void][Q.W32]::GetWindowRect($h, [ref]$r)
  $vis = [Q.W32]::IsWindowVisible($h)
  $ex = [Q.W32]::GetWindowLong($h, -20)
  $clickThrough = ($ex -band 0x20) -ne 0
  $topmost = ($ex -band 0x8) -ne 0
  $found++
  Write-Output ("pid={0} title=[{1}] rect=({2},{3})-({4},{5}) size={6}x{7} visible={8} topmost={9} clickThrough={10}" -f `
    $p.Id, $p.MainWindowTitle, $r.Left, $r.Top, $r.Right, $r.Bottom, `
    ($r.Right - $r.Left), ($r.Bottom - $r.Top), $vis, $topmost, $clickThrough)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -le 0 -or $hh -le 0) { continue }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save((Join-Path $PWD "win-rect.png"))
  $bmp.Dispose()
  Write-Output "saved win-rect.png"
}
if ($found -eq 0) { Write-Output "no $ProcName process with a main window" }
