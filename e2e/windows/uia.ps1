# UI Automation helper for the Windows E2E runner. Prints JSON.
#   uia.ps1 windows            top-level SparkDown windows (name, hwnd, class)
#   uia.ps1 foreground         title of the foreground window
#   uia.ps1 dialogs            non-main top-level windows of sparkdown.exe with their texts and buttons
#   uia.ps1 click <hwnd> <btn> invoke a button in a top-level window
#   uia.ps1 menu [<item>]      open popup menus' items; with <item>, expand it first and list again
#   uia.ps1 escape-menus       close open popup menus
#   uia.ps1 shot <path>        full-screen screenshot
param([string]$Cmd, [string]$A1, [string]$A2)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -Namespace E2E -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
$pids = @(Get-Process sparkdown -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })

function TopLevel {
  $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) |
    Where-Object { $pids -contains $_.Current.ProcessId }
}
function Desc($el, $type) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)
  $el.FindAll($TS::Descendants, $c)
}
switch ($Cmd) {
  'windows' {
    @(TopLevel | Where-Object { $_.Current.ClassName -notin '#32770', '#32768' } | ForEach-Object {
      [pscustomobject]@{ name = $_.Current.Name; hwnd = $_.Current.NativeWindowHandle; class = $_.Current.ClassName }
    }) | ConvertTo-Json -Compress -AsArray
  }
  'foreground' {
    $sb = New-Object System.Text.StringBuilder 512
    [E2E.Win]::GetWindowText([E2E.Win]::GetForegroundWindow(), $sb, 512) | Out-Null
    $sb.ToString() | ConvertTo-Json -Compress
  }
  'dialogs' {
    @(TopLevel | Where-Object { $_.Current.ClassName -eq '#32770' -or ($_.Current.Name -and $_.Current.Name -notlike '*SparkDown' -and $_.Current.ClassName -ne '#32768') } | ForEach-Object {
      $texts = @(Desc $_ $CT::Text | ForEach-Object { $_.Current.Name }) + @(Desc $_ $CT::Document | ForEach-Object { $_.Current.Name })
      $btns = @(Desc $_ $CT::Button | ForEach-Object { $_.Current.Name })
      [pscustomobject]@{ name = $_.Current.Name; hwnd = $_.Current.NativeWindowHandle; class = $_.Current.ClassName; text = ($texts -join "`n"); buttons = $btns }
    }) | ConvertTo-Json -Compress -AsArray -Depth 4
  }
  'click' {
    $w = TopLevel | Where-Object { $_.Current.NativeWindowHandle -eq [int]$A1 } | Select-Object -First 1
    $b = Desc $w $CT::Button | Where-Object { $_.Current.Name -eq $A2 } | Select-Object -First 1
    $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    'true'
  }
  'menu' {
    $menus = { $root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768'))) }
    if ($A1) {
      foreach ($m in (& $menus)) {
        $it = Desc $m $CT::MenuItem | Where-Object { $_.Current.Name -eq $A1 } | Select-Object -First 1
        if ($it) { $it.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 800; break }
      }
    }
    @(& $menus | ForEach-Object {
      [pscustomobject]@{ hwnd = $_.Current.NativeWindowHandle; items = @(Desc $_ $CT::MenuItem | ForEach-Object { $_.Current.Name }) }
    }) | ConvertTo-Json -Compress -AsArray -Depth 4
  }
  'escape-menus' {
    for ($i = 0; $i -lt 3; $i++) {
      foreach ($m in $root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768')))) {
        [E2E.Win]::PostMessage([System.IntPtr]$m.Current.NativeWindowHandle, 0x0100, [System.IntPtr]0x1B, [System.IntPtr]0) | Out-Null
      }
      Start-Sleep -Milliseconds 400
    }
    $left = @($root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768')))).Count
    if ($left) { foreach ($w in (TopLevel)) { [E2E.Win]::PostMessage([System.IntPtr]$w.Current.NativeWindowHandle, 0x001F, [System.IntPtr]0, [System.IntPtr]0) | Out-Null } ; Start-Sleep -Milliseconds 500 }
    @($root.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32768')))).Count | ConvertTo-Json
  }
  'shot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($A1)
    'true'
  }
}
