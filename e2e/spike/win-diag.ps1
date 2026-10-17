# Why does WebView2 in sparkdown.exe ignore WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?
param([string]$Exe)
$ErrorActionPreference = 'Continue'
"== Edge/WebView2 policies"
foreach ($k in 'HKLM:\SOFTWARE\Policies\Microsoft\Edge','HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2','HKCU:\SOFTWARE\Policies\Microsoft\Edge','HKLM:\SOFTWARE\Policies\Microsoft\EdgeUpdate') {
  "-- $k"; Get-ItemProperty $k -ErrorAction SilentlyContinue | Format-List | Out-String -Width 300
  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { "   subkey: $($_.Name)" }
}
Get-Process sparkdown, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
$udf = Join-Path $env:RUNNER_TEMP 'wv2-udf'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
$env:WEBVIEW2_USER_DATA_FOLDER = $udf
$d = Join-Path $env:RUNNER_TEMP 'gamma'; New-Item -ItemType Directory -Force $d | Out-Null
$p = Start-Process $Exe -ArgumentList $d -PassThru
Start-Sleep 12
"== app pid $($p.Id) alive=$(-not $p.HasExited)"
"== msedgewebview2 command lines"
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.CommandLine }
"== DevToolsActivePort files"
Get-ChildItem -Recurse -Filter DevToolsActivePort -Path $udf, "$env:LOCALAPPDATA\com.sparkdown.editor" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName): $(Get-Content $_.FullName -Raw)" }
"== user data folders"
Get-ChildItem $udf, "$env:LOCALAPPDATA\com.sparkdown.editor" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
"== port 9333"
try { (Invoke-WebRequest http://127.0.0.1:9333/json -UseBasicParsing -TimeoutSec 5).Content } catch { "no: $_" }
Get-Process sparkdown, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
