# Spike: UI Automation over SparkDown's top-level windows; open a second window with Ctrl+Shift+N.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Wins {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $root.FindAll([System.Windows.Automation.TreeScope]::Children, $c) | Where-Object { $_.Current.Name -like '*SparkDown*' } | ForEach-Object { "$($_.Current.Name) pid=$($_.Current.ProcessId) hwnd=$($_.Current.NativeWindowHandle)" }
}
"before: $(Wins | Out-String)"
$w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ((Wins | Select-Object -First 1) -replace ' pid=.*',''))))
if ($w) { $w.SetFocus(); Start-Sleep 1; [System.Windows.Forms.SendKeys]::SendWait('^+n'); Start-Sleep 5 }
"after ctrl+shift+n: $(Wins | Out-String)"
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save("$env:OUT\win-desktop.png")
