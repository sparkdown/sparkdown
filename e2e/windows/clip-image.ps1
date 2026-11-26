# clip-image.ps1 <png>: put the PNG on the Windows clipboard the way an image
# editor or browser does: the registered "PNG" format with the file's exact
# bytes, plus a bitmap (CF_DIB) for apps that only read bitmaps. Run with -STA.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bytes = [System.IO.File]::ReadAllBytes($Path)
$obj = New-Object System.Windows.Forms.DataObject
$obj.SetData('PNG', $false, (New-Object System.IO.MemoryStream(, $bytes)))
$obj.SetImage([System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, $bytes))))
# copy=$true: the data stays on the clipboard after this process exits.
[System.Windows.Forms.Clipboard]::SetDataObject($obj, $true, 10, 100)
'formats=' + ([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join ',')
