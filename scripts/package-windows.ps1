#Requires -Version 5.1
<#
.SYNOPSIS
    Build the SparkDown Windows installer (NSIS .exe, optionally .msi).

.DESCRIPTION
    Checks the build prerequisites, runs `npm ci` in frontend/, then runs the
    Tauri build for Windows bundles. Prints the path, size and SHA-256 of each
    installer it made.

    Runs as a normal user. It never needs administrator rights: the installer
    it makes also installs per user (no UAC prompt).

    Prerequisites (the script checks each one and stops with a link if one is
    missing):
      - Node.js matching frontend/package.json "engines"
      - Rust stable with the x86_64-pc-windows-msvc toolchain (rustup)
      - Visual Studio Build Tools, workload "Desktop development with C++"
        (MSVC compiler + Windows 10/11 SDK)
      - WebView2 runtime (only to RUN the app; Windows 10 21H2+ and 11 have it)

    The first build downloads NSIS (and WiX for -Msi) from GitHub into
    %LOCALAPPDATA%\tauri. That needs network access once.

    If PowerShell says "running scripts is disabled on this system", start it
    for this one process only (no admin, no permanent change):
        powershell -ExecutionPolicy Bypass -File scripts\package-windows.ps1

.PARAMETER Msi
    Also build an .msi (WiX). Default: NSIS .exe only. The MSI needs the
    Windows "VBSCRIPT" optional feature (WiX runs VBScript checks), which some
    Windows 11 24H2+ machines turn off.

.PARAMETER Sign
    Sign sparkdown.exe and the installers with Authenticode (signtool from the
    Windows SDK). Needs -CertificateThumbprint. Without signing, Windows
    SmartScreen warns on first run ("Windows protected your PC").

.PARAMETER CertificateThumbprint
    SHA-1 thumbprint of a code-signing certificate in Cert:\CurrentUser\My
    (or Cert:\LocalMachine\My). Used only with -Sign.

.PARAMETER TimestampUrl
    RFC 3161 timestamp server for -Sign. Default: http://timestamp.digicert.com

.PARAMETER SkipNpmCi
    Do not run `npm ci` (use the frontend/node_modules you already have).

.EXAMPLE
    .\scripts\package-windows.ps1

.EXAMPLE
    .\scripts\package-windows.ps1 -Msi

.EXAMPLE
    .\scripts\package-windows.ps1 -Sign -CertificateThumbprint 0123456789ABCDEF0123456789ABCDEF01234567
#>
[CmdletBinding()]
param(
    [switch]$Msi,
    [switch]$Sign,
    [string]$CertificateThumbprint = '',
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$SkipNpmCi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
# PowerShell 7.3+: do not turn native stderr / exit codes into exceptions; we
# check $LASTEXITCODE ourselves after each native command.
$PSNativeCommandUseErrorActionPreference = $false

$RustTarget = 'x86_64-pc-windows-msvc'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "    WARN $Message" -ForegroundColor Yellow
}

# Stop with an actionable message. Thrown so the finally block below restores
# the caller's directory and environment.
function Stop-Build([string]$Message, [string]$Fix = '') {
    $text = "ERROR: $Message"
    if ($Fix) { $text += [Environment]::NewLine + "  Fix: $Fix" }
    throw $text
}

function Find-Command([string]$Name) {
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

# --- Version range check (subset of npm semver used in package.json) --------
# Supports "a || b" alternatives of "^X.Y.Z", ">=X.Y.Z" and "X.Y.Z".
function Test-NodeVersion([version]$Have, [string]$Range) {
    foreach ($alt in ($Range -split '\|\|')) {
        $alt = $alt.Trim()
        if ($alt -match '^\^(\d+)\.(\d+)\.(\d+)$') {
            $min = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
            if ($Have.Major -eq $min.Major -and $Have -ge $min) { return $true }
        } elseif ($alt -match '^>=\s*(\d+)\.(\d+)\.(\d+)$') {
            $min = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
            if ($Have -ge $min) { return $true }
        } elseif ($alt -match '^(\d+)\.(\d+)\.(\d+)$') {
            if ($Have -eq [version]$alt) { return $true }
        } else {
            Write-Warn "Cannot read the engines range part '$alt'; skipping it."
        }
    }
    return $false
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path $RepoRoot 'frontend'
$SrcTauri = Join-Path $RepoRoot 'src-tauri'

# Saved so the finally block can put the caller's session back the way it was
# (this script usually runs in the caller's PowerShell session).
$SavedKey = $env:TAURI_SIGNING_PRIVATE_KEY
$SavedKeyPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$TempConfig = $null
$Pushed = $false
$ExitCode = 0

try {
    # --- Platform ------------------------------------------------------------
    Write-Step 'Checking prerequisites'
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        Stop-Build 'This script builds the Windows installer and must run on Windows.' `
            'On macOS use scripts/package-macos.sh; for Linux use the "Linux package" GitHub Actions workflow.'
    }
    if (-not (Test-Path (Join-Path $Frontend 'package.json')) -or
        -not (Test-Path (Join-Path $SrcTauri 'tauri.conf.json'))) {
        Stop-Build "Cannot find frontend\package.json and src-tauri\tauri.conf.json under $RepoRoot." `
            'Run the script from a full clone of the SparkDown repository.'
    }
    $osVersion = [Environment]::OSVersion.Version
    if ($osVersion.Major -lt 10) {
        Stop-Build "Windows $osVersion is not supported." 'Use Windows 10 or Windows 11.'
    }
    Write-Ok "Windows $osVersion ($env:PROCESSOR_ARCHITECTURE)"
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        Write-Warn 'ARM64 Windows: the script builds the x64 installer; it runs under x64 emulation.'
    }

    # --- Node.js -------------------------------------------------------------
    $pkg = Get-Content -Raw -Path (Join-Path $Frontend 'package.json') | ConvertFrom-Json
    $engines = $pkg.engines.node
    $node = Find-Command 'node.exe'
    if (-not $node) {
        Stop-Build 'Node.js is not installed (node.exe is not on PATH).' `
            "Install Node.js LTS ($engines) from https://nodejs.org/en/download, then open a new terminal."
    }
    $nodeRaw = (& $node --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeRaw -notmatch '^v(\d+\.\d+\.\d+)') {
        Stop-Build "Cannot read the Node.js version (node --version gave '$nodeRaw')." `
            'Reinstall Node.js from https://nodejs.org/en/download'
    }
    $nodeVersion = [version]$Matches[1]
    if (-not (Test-NodeVersion $nodeVersion $engines)) {
        Stop-Build "Node.js $nodeRaw does not match frontend/package.json engines '$engines'." `
            'Install a matching Node.js from https://nodejs.org/en/download (or switch with nvm-windows / fnm).'
    }
    Write-Ok "Node.js $nodeRaw (needs $engines)"
    # npm.cmd, not npm: the npm.ps1 shim can be blocked by the execution policy.
    $npm = Find-Command 'npm.cmd'
    if (-not $npm) {
        Stop-Build 'npm.cmd is not on PATH.' 'Reinstall Node.js from https://nodejs.org/en/download (npm comes with it).'
    }

    # --- Rust ----------------------------------------------------------------
    $rustc = Find-Command 'rustc.exe'
    $cargo = Find-Command 'cargo.exe'
    if (-not $rustc -or -not $cargo) {
        Stop-Build 'Rust is not installed (rustc.exe / cargo.exe are not on PATH).' `
            'Install it with rustup from https://rustup.rs (choose the default MSVC host), then open a new terminal.'
    }
    $rustInfo = & $rustc -vV
    if ($LASTEXITCODE -ne 0) {
        Stop-Build 'rustc -vV failed.' 'Repair the toolchain: rustup update stable'
    }
    $rustRelease = ($rustInfo | Where-Object { $_ -like 'release:*' }) -replace '^release:\s*', ''
    $rustHost = ($rustInfo | Where-Object { $_ -like 'host:*' }) -replace '^host:\s*', ''
    if ($rustRelease -match '-(nightly|beta)') {
        Write-Warn "rustc $rustRelease is not stable; CI uses stable (rustup default stable)."
    }
    $rustup = Find-Command 'rustup.exe'
    $ExtraTauriArgs = @()
    if ($rustHost -ne $RustTarget) {
        # A GNU or ARM64 host: build for the MSVC x64 target explicitly.
        if (-not $rustup) {
            Stop-Build "Rust host is '$rustHost', not $RustTarget, and rustup is not available to add the target." `
                'Install Rust with rustup from https://rustup.rs and pick the MSVC host.'
        }
        $installed = @(& $rustup target list --installed | ForEach-Object { $_.Trim() })
        if ($installed -notcontains $RustTarget) {
            Stop-Build "Rust target $RustTarget is not installed (host is $rustHost)." `
                "rustup target add $RustTarget"
        }
        $ExtraTauriArgs += @('--target', $RustTarget)
    }
    Write-Ok "Rust $rustRelease (host $rustHost, building $RustTarget)"

    # --- Visual Studio Build Tools (MSVC + Windows SDK) ----------------------
    $vsLink = 'https://visualstudio.microsoft.com/visual-cpp-build-tools/ - in the installer pick the workload "Desktop development with C++" (it includes MSVC and the Windows 11 SDK).'
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        Stop-Build 'Visual Studio Build Tools are not installed (vswhere.exe not found).' $vsLink
    }
    $vsPath = & $vswhere -latest -products '*' `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $vsPath) {
        Stop-Build 'No Visual Studio installation has the MSVC x64 C++ build tools.' $vsLink
    }
    Write-Ok "MSVC build tools: $vsPath"

    $sdkRoot = $null
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots',
                       'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots')) {
        $item = Get-ItemProperty -Path $key -Name KitsRoot10 -ErrorAction SilentlyContinue
        if ($item -and $item.KitsRoot10) { $sdkRoot = $item.KitsRoot10; break }
    }
    $sdkLib = $null
    if ($sdkRoot) {
        $sdkLib = Get-ChildItem -Path (Join-Path $sdkRoot 'Lib') -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'um\x64\kernel32.lib') } |
            Sort-Object { [version]($_.Name -replace '[^\d\.]', '') } -Descending -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $sdkLib) {
        Stop-Build 'The Windows 10/11 SDK is not installed (no x64 kernel32.lib under Windows Kits\10\Lib).' $vsLink
    }
    Write-Ok "Windows SDK $($sdkLib.Name)"

    # --- WebView2 (runtime only) ---------------------------------------------
    $wv2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $wv2Version = $null
    foreach ($key in @("HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2Guid",
                       "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2Guid",
                       "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2Guid")) {
        $item = Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue
        if ($item -and $item.pv -and $item.pv -ne '0.0.0.0') { $wv2Version = $item.pv; break }
    }
    if ($wv2Version) {
        Write-Ok "WebView2 runtime $wv2Version"
    } else {
        # Not needed to build. The installer fetches it if it is missing.
        Write-Warn 'WebView2 runtime not found. The build still works, and the installer downloads it when needed. To run SparkDown here, install it from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen).'
    }

    # --- Signing inputs ------------------------------------------------------
    if ($Sign) {
        $CertificateThumbprint = ($CertificateThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        if (-not $CertificateThumbprint) {
            Stop-Build '-Sign needs -CertificateThumbprint <SHA-1 thumbprint>.' `
                'List your code-signing certificates: Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert'
        }
        $cert = Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $CertificateThumbprint } | Select-Object -First 1
        if (-not $cert) {
            Stop-Build "No code-signing certificate with thumbprint $CertificateThumbprint in Cert:\CurrentUser\My or Cert:\LocalMachine\My." `
                'Import the certificate (.pfx) into your user store, or check the thumbprint with: Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert'
        }
        Write-Ok "Signing with $($cert.Subject) (expires $($cert.NotAfter.ToString('yyyy-MM-dd')))"
        # Tauri runs signtool on sparkdown.exe and on each installer.
        $TempConfig = Join-Path ([IO.Path]::GetTempPath()) ("sparkdown-sign-{0}.json" -f [guid]::NewGuid())
        $signConfig = @{
            bundle = @{
                windows = @{
                    certificateThumbprint = $CertificateThumbprint
                    digestAlgorithm       = 'sha256'
                    timestampUrl          = $TimestampUrl
                }
            }
        }
        # ASCII JSON without BOM (PowerShell 5.1 Out-File would add one).
        [IO.File]::WriteAllText($TempConfig, ($signConfig | ConvertTo-Json -Depth 5), [Text.Encoding]::ASCII)
        $ExtraTauriArgs += @('--config', $TempConfig)
    } elseif ($CertificateThumbprint) {
        Write-Warn '-CertificateThumbprint is ignored without -Sign.'
    }

    # --- npm ci --------------------------------------------------------------
    Push-Location $RepoRoot
    $Pushed = $true

    if ($SkipNpmCi) {
        Write-Step 'Skipping npm ci (-SkipNpmCi)'
    } else {
        Write-Step 'Installing frontend dependencies (npm ci)'
        Push-Location $Frontend
        try {
            & $npm ci --no-audit --no-fund
            $npmExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($npmExit -ne 0) {
            Stop-Build "npm ci failed (exit $npmExit)." `
                'Read the npm output above. A locked file under frontend\node_modules (an editor or a running dev server) is a common cause: close it and run again.'
        }
    }
    # The CLI's JS entry point, run with node directly: the tauri.cmd shim goes
    # through cmd.exe, which mangles some paths and arguments.
    $tauri = Join-Path $Frontend 'node_modules\@tauri-apps\cli\tauri.js'
    if (-not (Test-Path $tauri)) {
        Stop-Build "Tauri CLI not found at $tauri." 'Run the script without -SkipNpmCi so npm ci installs it.'
    }

    # --- Tauri build ---------------------------------------------------------
    $bundles = @('nsis')
    if ($Msi) { $bundles += 'msi' }
    Write-Step "Building SparkDown ($($bundles -join ', ')); the first build takes several minutes"
    # The updater signing key never reaches the build (npm, vite and cargo
    # build scripts run here). Windows updates are notify-only, so there is no
    # updater artifact to sign anyway.
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

    # From the repo root, like scripts/package-macos.sh: the Tauri CLI finds
    # src-tauri\ from the current directory.
    $tauriArgs = @($tauri, 'build', '--bundles') + $bundles + $ExtraTauriArgs
    & $node @tauriArgs
    $tauriExit = $LASTEXITCODE
    if ($tauriExit -ne 0) {
        $hint = 'Read the build output above. Common causes: a missing C++ workload or SDK (rerun the Visual Studio Installer), no network for the first NSIS/WiX download, or a running SparkDown.exe that locks the output file.'
        if ($Msi) { $hint += ' For MSI errors from light.exe, turn on the Windows optional feature "VBSCRIPT", or build without -Msi.' }
        Stop-Build "tauri build failed (exit $tauriExit)." $hint
    }

    # --- Results -------------------------------------------------------------
    $releaseDir = Join-Path $SrcTauri 'target\release'
    if ($ExtraTauriArgs -contains '--target') {
        $releaseDir = Join-Path $SrcTauri "target\$RustTarget\release"
    }
    $bundleDir = Join-Path $releaseDir 'bundle'
    $outputs = @(Get-ChildItem -Path (Join-Path $bundleDir 'nsis') -Filter '*.exe' -File -ErrorAction SilentlyContinue)
    if ($Msi) {
        $outputs += @(Get-ChildItem -Path (Join-Path $bundleDir 'msi') -Filter '*.msi' -File -ErrorAction SilentlyContinue)
    }
    $outputs = @($outputs | Where-Object { $_ })
    if ($outputs.Count -eq 0) {
        Stop-Build "The build finished but no installer was found under $bundleDir." 'Read the tauri build output above.'
    }

    Write-Step 'Built'
    foreach ($f in $outputs) {
        $hash = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash.ToLowerInvariant()
        $mb = '{0:N1} MB' -f ($f.Length / 1MB)
        Write-Host "    $($f.FullName)"
        Write-Host "      size:   $mb ($($f.Length) bytes)"
        Write-Host "      sha256: $hash"
        if ($Sign) {
            $sig = Get-AuthenticodeSignature -FilePath $f.FullName
            Write-Host "      signature: $($sig.Status)"
        }
    }
    $appExe = Join-Path $releaseDir 'sparkdown.exe'
    if (Test-Path $appExe) {
        Write-Host "    App binary (no installer): $appExe"
    }
    Write-Host ''
    Write-Host 'Install: run the installer (per user, no admin). Uninstall: Settings > Apps > Installed apps > SparkDown.'
    if (-not $Sign) {
        Write-Host 'The installer is unsigned: SmartScreen shows "Windows protected your PC". Click "More info", then "Run anyway".'
    }
} catch {
    $msg = $_.Exception.Message
    Write-Host ''
    Write-Host $msg -ForegroundColor Red
    if ($msg -notlike 'ERROR:*') {
        # Not one of our checks: show where it failed, for a bug report.
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
    }
    $ExitCode = 1
} finally {
    if ($Pushed) { Pop-Location }
    if ($TempConfig -and (Test-Path $TempConfig)) { Remove-Item $TempConfig -Force }
    if ($null -ne $SavedKey) { $env:TAURI_SIGNING_PRIVATE_KEY = $SavedKey }
    if ($null -ne $SavedKeyPassword) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $SavedKeyPassword }
}
exit $ExitCode
