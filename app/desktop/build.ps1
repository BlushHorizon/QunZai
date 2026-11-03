param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$out = Join-Path $root 'bin'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$vendor = Join-Path $root 'vendor'

if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
foreach ($f in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
    if (-not (Test-Path (Join-Path $vendor $f))) { throw "missing WebView2 dependency: $f" }
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll') $out -Force
Copy-Item (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll') $out -Force
Copy-Item (Join-Path $vendor 'WebView2Loader.dll') $out -Force

$exe = Join-Path $out 'QunZaiHost.exe'
# EXE 文件本身的图标要靠 /win32icon 编进去；不传这个参数，资源管理器里就是一个白纸图标。
$appRoot = Split-Path -Parent $root
$icon = Join-Path $appRoot 'assets\icon.ico'
$hasIcon = Test-Path $icon
if (-not $hasIcon) { Write-Warning "icon not found, building without /win32icon: $icon" }

if ((Test-Path $exe) -and -not $Force) {
    $srcTime = (Get-Item (Join-Path $root 'QunZaiHost.cs')).LastWriteTime
    if ($hasIcon) {
        $iconTime = (Get-Item $icon).LastWriteTime
        if ($iconTime -gt $srcTime) { $srcTime = $iconTime }
    }
    if ((Get-Item $exe).LastWriteTime -ge $srcTime) {
        Write-Host "desktop host is up to date: $exe"
        exit 0
    }
}

$coreDll = Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'
$winFormsDll = Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'
$source = Join-Path $root 'QunZaiHost.cs'
$iconArg = @()
if ($hasIcon) { $iconArg = @("/win32icon:$icon") }
& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:$exe $iconArg `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    /r:$coreDll /r:$winFormsDll $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) { throw "desktop host build failed (exit $LASTEXITCODE)" }
Write-Host "desktop host built: $exe"
