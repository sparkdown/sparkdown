# Can UIA see inside the WebView2 content (sidebar, editor, status bar) and native dialogs?
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
foreach ($w in ($root.FindAll([System.Windows.Automation.TreeScope]::Children, $c) | Where-Object { $_.Current.Name -like '*SparkDown*' })) {
  "== window '$($w.Current.Name)'"
  $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  "descendants: $($all.Count)"
  $all | Where-Object { $_.Current.Name } | Select-Object -First 60 | ForEach-Object { "  [$($_.Current.ControlType.ProgrammaticName -replace 'ControlType.','')] $($_.Current.Name)" }
}
