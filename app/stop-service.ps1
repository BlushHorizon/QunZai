# 群崽 QunZai · 安装器专用停止脚本
# 按「安装目录」精准结束本程序的所有进程：桌面宿主 + Node 服务 + 内置QQ 桥接(NapCat/SnowLuma)。
# 绝不误杀其他 Node 程序：认领规则只认安装目录、runtime.json 的 pid、以及本程序的端口。
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

# ---------------- 第 0 关：按 registry / runtime.json 的 pid 精确结束 ----------------
# 为什么需要这一关：老版本宿主用相对路径启动 node（Arguments = "server\\server.js"），
# 那种进程的 ExecutablePath 是 C:\Program Files\nodejs\node.exe、CommandLine 里没有安装目录，
# 下面第 2 关的三条规则一条都匹配不上 —— 旧服务活下来，新宿主一连就「连上了」，
# 版本号永远停在旧值。用户看到的就是「更新完还提示更新」，
# 而安装器日志里还写着 stopped 0 process(es)，看着像成功了。
$rt = $null
$runtimeFile = Join-Path $Root 'data\runtime.json'
if (Test-Path $runtimeFile) {
    try { $rt = Get-Content -Raw -Path $runtimeFile | ConvertFrom-Json } catch { }
}
if ($rt -and $rt.pid) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($rt.pid)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq 'node.exe') {
        Stop-Process -Id $rt.pid -Force -ErrorAction SilentlyContinue
        Write-Host "stopped service by runtime.json pid=$($rt.pid)"
        $killed++
    }
}

# ---------------- 第 0.5 关：命令行是 server\server.js 的 node（不分安装目录） ----------------
# 只有当它确实在服务本程序的端口时才算：靠下面的端口认领，避免把用户别的 node 服务杀掉。
# 这里只做「记录候选」，真正的结束放在端口那一关。
$probePorts = @()
if ($rt -and $rt.serverPort) { $probePorts += [int]$rt.serverPort }
$cfgFile = Join-Path $Root 'config.json'
if (Test-Path $cfgFile) {
    try {
        $cfg = Get-Content -Raw -Path $cfgFile | ConvertFrom-Json
        if ($cfg.port) { $probePorts += [int]$cfg.port }
    } catch { }
}
foreach ($port in ($probePorts | Select-Object -Unique)) {
    try {
        foreach ($c in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -eq 'node.exe') {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                Write-Host "stopped port $port owner pid=$($c.OwningProcess)"
                $killed++
            }
        }
    } catch { }
}

# ---------------- 第 1 关：桌面宿主 QunZaiHost.exe（exe 被占用会导致复制失败） ----------------
try {
    Get-CimInstance Win32_Process -Filter "Name='QunZaiHost.exe'" |
        Where-Object { Test-IsUnderRoot $_.ExecutablePath } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
} catch { }

# ---------------- 第 2 关：安装目录内的所有 node 进程 ----------------
#    - server\server.js（主服务）
#    - engine\napcat\node.exe index.js / napcat.mjs（内置 NapCat QQ 桥接）
#    - engine\snowluma\node.exe ...（内置 SnowLuma QQ 桥接）
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
