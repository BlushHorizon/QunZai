# 群崽 QunZai · 安装器专用停止脚本
# 按「安装目录」精准结束本程序的所有进程：桌面宿主 + Node 服务 + 内置监视器(NapCat/SnowLuma)。
# 只杀命令行 / 可执行路径落在 $Root 里的进程，绝不误杀其他 Node 程序。
param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = 'SilentlyContinue'

# 先写停止标记：如果服务是由 launcher 守护模式拉起的，看到标记就不会再拉起。
try {
    $dataDir = Join-Path $Root 'data'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $dataDir '.svc_stop'), (Get-Date -Format 'o'))
} catch { }

# 归一化安装目录，便于和进程路径比对（统一分隔符、去尾斜杠）。
$rootNorm = $Root.TrimEnd('\', '/')

$killed = 0

function Test-IsUnderRoot {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    $p = $Path -replace '/', '\'
    return $p.StartsWith($rootNorm, [System.StringComparison]::OrdinalIgnoreCase)
}

# 1) 结束桌面宿主 QunZaiHost.exe（exe 被占用会导致复制失败）。
try {
    Get-CimInstance Win32_Process -Filter "Name='QunZaiHost.exe'" |
        Where-Object { Test-IsUnderRoot $_.ExecutablePath } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
} catch { }

# 2) 结束安装目录内的所有 node 进程：
#    - server\server.js（主服务）
#    - engine\napcat\node.exe index.js / napcat.mjs（内置 NapCat 监视器）
#    - engine\snowluma\node.exe ...（内置 SnowLuma 监视器）
try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object {
            (Test-IsUnderRoot $_.ExecutablePath) -or
            (Test-IsUnderRoot $_.CommandLine) -or
            ($_.CommandLine -and ($_.CommandLine -replace '/', '\') -match ([regex]::Escape($rootNorm) + '[\x5C]'))
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
} catch { }

# 给端口一点释放时间，避免安装器马上启动新服务时撞端口。
Start-Sleep -Milliseconds 600
Write-Host "QunZai stopped: $killed process(es)"
exit 0
