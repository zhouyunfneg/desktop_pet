param(
  [string]$ProcName = "electron",
  [int[]]$Points = @(400, 400, 960, 300, 1830, 1000)
)
# Safety check for a full-screen transparent overlay + SetWindowRgn.
# Asks WindowFromPoint who owns each sample point. The overlay hwnd must only
# show up on the dog/bowl hot rects; if it shows up on ordinary desktop space,
# the overlay is swallowing the whole screen.
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# without a BOM, and some Chinese characters' second byte lands on a quote and
# silently breaks string parsing.
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct POINT { public int X; public int Y; }
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name Hit -Namespace HT

function Describe([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return "null" }
  $root = [HT.Hit]::GetAncestor($h, 2)
  $wpid = 0
  [void][HT.Hit]::GetWindowThreadProcessId($root, [ref]$wpid)
  $sb = New-Object System.Text.StringBuilder 256
  [void][HT.Hit]::GetClassName($root, $sb, 256)
  $r = New-Object HT.Hit+RECT
  [void][HT.Hit]::GetWindowRect($root, [ref]$r)
  return "root=$root class=$($sb.ToString()) pid=$wpid rect=($($r.Left),$($r.Top),$($r.Right),$($r.Bottom))"
}

$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
$overlay = [IntPtr]::Zero
foreach ($p in $procs) {
  $t = $p.MainWindowTitle
  Write-Output ("candidate pid=" + $p.Id + " title_len=" + $t.Length + " " + (Describe $p.MainWindowHandle))
  if ($overlay -eq [IntPtr]::Zero) { $overlay = $p.MainWindowHandle }
}
Write-Output ("overlay hwnd = " + $overlay)

for ($i = 0; $i -lt $Points.Count; $i += 2) {
  $pt = New-Object HT.Hit+POINT
  $pt.X = $Points[$i]
  $pt.Y = $Points[$i + 1]
  $h = [HT.Hit]::WindowFromPoint($pt)
  $root = [HT.Hit]::GetAncestor($h, 2)
  $tag = "(passes through)"
  if ($overlay -ne [IntPtr]::Zero -and $root -eq $overlay) { $tag = "<= OVERLAY" }
  Write-Output ("point(" + $pt.X + "," + $pt.Y + ") -> " + (Describe $h) + " " + $tag)
}
