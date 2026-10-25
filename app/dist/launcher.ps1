# 群崽 QunZai · 一键启动器（由桌面快捷方式调用）
# 参数：-NoBrowser 只启动服务不开网页；-Stop 停止服务；-LiveConsole 实时控制台模式
# 守护模式：启动后常驻，服务进程意外退出 3 秒后自动重启（防抽风）。
# -LiveConsole：日志直接打在本窗口；关闭本窗口 = 服务随窗口一起关停。

param(
    [switch]$NoBrowser,
    [switch]$Stop,
    [switch]$LiveConsole,
    [int]$ServerPortOverride = 0,
    [int]$CdpPortOverride = 0,
    [switch]$Embedded
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$port = 8787
$cdpPort = 9222
# 允许高级用户改 config.json 的 server.port / ai.cdpPort；启动器/停止脚本跟着走
try {
    $cfgPath = Join-Path $root 'config.json'
    if (Test-Path $cfgPath) {
        $cfg = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.server -and $cfg.server.port) { $port = [int]$cfg.server.port }
        if ($cfg.ai -and $cfg.ai.cdpPort) { $cdpPort = [int]$cfg.ai.cdpPort }
    }
} catch { }
# 桌面窗口 / 上层脚本可以覆盖首选端口；0 表示沿用配置
if ($Port -gt 0) { $port = $Port }
elseif ($env:QUNZAI_SERVER_PORT -and [int]$env:QUNZAI_SERVER_PORT -gt 0) { $port = [int]$env:QUNZAI_SERVER_PORT }
if ($CdpPort -gt 0) { $cdpPort = $CdpPort }
elseif ($env:QUNZAI_CDP_PORT -and [int]$env:QUNZAI_CDP_PORT -gt 0) { $cdpPort = [int]$env:QUNZAI_CDP_PORT }
if ($Embedded -or $env:QUNZAI_EMBEDDED -eq '1') { $env:QUNZAI_EMBEDDED = '1' }
$env:QUNZAI_SERVER_PORT = [string]$port
$env:QUNZAI_CDP_PORT = [string]$cdpPort
$url = "http://127.0.0.1:$port"
$logDir = Join-Path $root 'data'
$logFile = Join-Path $logDir 'server.log'
$stopFlag = Join-Path $logDir '.svc_stop'
$runtimeFile = Join-Path $logDir 'runtime.json'

function Show-Msg([string]$text, [string]$title = '群崽 QunZai') {
    # 总是落日志 + 打到控制台
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path (Join-Path $logDir 'launcher.log') -Value "[$stamp] $title`n$text`n" -Encoding UTF8
    } catch { }
    try { Write-Host $text -ForegroundColor Red } catch { }
    # 只有在真实控制台（双击运行）时才弹窗；
    # 被脚本/管道重定向调用时不弹窗，避免自动化被对话框挂死
    if (-not [Console]::IsOutputRedirected) {
        try {
            Add-Type -AssemblyName System.Windows.Forms | Out-Null
            [System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', 'Information') | Out-Null
        } catch { }
    }
}

function Test-BrowserHasUrl([string]$u) {
    # 面板是否已经在某个浏览器窗口里开着。
    # 不查的话，每双击一次「开启」就多一个浏览器窗口，跑一天能堆到几十个。
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine.Contains($u)) { return $true }
        }
    } catch { }
    return $false
}

function Open-PanelOnce([string]$u) {
    if (Test-BrowserHasUrl $u) {
        try { Write-Host '  面板已在浏览器中打开，跳过重复开窗。' -ForegroundColor DarkGray } catch { }
        return
    }
    Start-Process $u
}

function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-QunZaiAt([int]$p) {
    # 端口通不代表就是群崽：必须能拿到 /api/status 才认，避免把别的程序当成本服务
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/status" -UseBasicParsing -TimeoutSec 2
        return ($resp.StatusCode -eq 200 -and $resp.Content -match '"qq"')
    } catch {
        return $false
    }
}

function Read-Runtime {
    try {
        if (Test-Path $runtimeFile) {
            return Get-Content -Path $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        }
    } catch { }
    return $null
}

function Find-FreePort([int]$start, [int]$max = 60) {
    for ($p = $start; $p -lt [Math]::Min(65536, $start + $max); $p++) {
        if (-not (Test-Port $p)) { return $p }
    }
    return 0
}

function Wait-ForServer([int]$preferred, [int]$timeoutSec = 25) {
    # 服务可能因为端口占用自动换端口：以 data\runtime.json 为准，再实际请求确认
    $until = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $until) {
        $rt = Read-Runtime
        $candidates = @()
        if ($rt -and $rt.serverPort) { $candidates += [int]$rt.serverPort }
        $candidates += $preferred
        foreach ($p in ($candidates | Select-Object -Unique)) {
            if ($p -gt 0 -and (Test-QunZaiAt $p)) { return $p }
        }
        Start-Sleep -Milliseconds 500
    }
    return 0
}

# ---------- 停止服务 ----------
if ($Stop) {
    # 1) 先写停止标记：守护循环看到标记就彻底退出、不再拉起
    try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch { }
    try { [System.IO.File]::WriteAllText($stopFlag, (Get-Date -Format 'o')) } catch { }
    $killed = 0
    $candidatePorts = @()
    $rt = Read-Runtime
    if ($rt -and $rt.serverPort) { $candidatePorts += [int]$rt.serverPort }
    $candidatePorts += $port
    $candidatePorts = @($candidatePorts | Where-Object { $_ -gt 0 -and $_ -le 65535 } | Select-Object -Unique)

    # 2) 一次拿到所有监听端口，避免对 60 个端口逐个 netstat（旧版会卡几十秒）
    $listeners = @{}
    try {
        netstat -ano | Select-String 'LISTENING' | ForEach-Object {
            $parts = @($_.Line -split '\s+' | Where-Object { $_ })
            if ($parts.Count -ge 5 -and $parts[1] -match ':(\d+)$' -and $parts[-1] -match '^\d+$') {
                $listeners[[int]$Matches[1]] = [int]$parts[-1]
            }
        }
    } catch { }

    # 3) 按 runtime/配置端口找进程；只结束确认是群崽的 node 进程
    foreach ($p in $candidatePorts) {
        if (-not $listeners.ContainsKey($p)) { continue }
        $portPid = [int]$listeners[$p]
        try {
            $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$portPid" -ErrorAction SilentlyContinue
            $cmd = if ($procInfo) { [string]$procInfo.CommandLine } else { '' }
            if ($cmd -match 'server[\\/]server\.js') {
                Stop-Process -Id $portPid -Force -ErrorAction SilentlyContinue
                $killed++
            } else {
                Write-Host "端口 $p 被其他程序占用（PID $portPid），没有结束它。" -ForegroundColor Yellow
            }
        } catch { }
    }

    # 4) 兜底：只找本机命令行里 server\server.js 的 node 进程
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'server[\\/]server\.js' } |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                $killed++
            }
    } catch { }

    # 5) 等候选端口释放（最多约 3 秒）
    for ($i = 0; $i -lt 10; $i++) {
        $still = @($candidatePorts | Where-Object { Test-Port $_ })
        if ($still.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }
    if ($killed -gt 0) { Write-Host "服务已停止（共 $killed 个进程）。" }
    else { Write-Host "没有找到正在运行的服务。" }
    exit 0
}

# ---------- Node 环境检查 ----------
# 先找安装包内置的 Node（随内置 QQ 监视器一起来的那份），用户就不必自己装
$node = $null
foreach ($cand in @(
    (Join-Path $PSScriptRoot 'engine\napcat\node.exe'),
    (Join-Path $PSScriptRoot 'engine\snowluma\node.exe')
)) {
    if (Test-Path -LiteralPath $cand) { $node = Get-Item -LiteralPath $cand; break }
}
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) {
    Show-Msg "未检测到 Node.js，安装包里也没找到内置的那份。`n`n请先安装 Node.js 22 或更高版本：`nhttps://nodejs.org/`n`n安装完成后重新启动群崽。" '缺少 Node.js'
    exit 1
}
# Get-Command 返回 CommandInfo（路径在 .Source），Get-Item 返回 FileInfo（路径在 .FullName）
$nodeExe = if ($node.PSObject.Properties['Source'] -and $node.Source) { $node.Source } else { $node.FullName }
$nodeVersion = ''
try { $nodeVersion = (& $nodeExe -v 2>$null | Select-Object -First 1) } catch { }
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 22) {
    Show-Msg "当前 Node.js 版本为 $nodeVersion，版本过低。`n`n群崽需要 Node.js 22 或更高版本（用到内置 WebSocket），请升级后重试：`nhttps://nodejs.org/" 'Node.js 版本过低'
    exit 1
}

# ---------- 服务已在运行则直接开网页 ----------
$existingPort = 0
$rt = Read-Runtime
if ($rt -and $rt.serverPort -and [int]$rt.serverPort -gt 0 -and (Test-QunZaiAt ([int]$rt.serverPort))) {
    $existingPort = [int]$rt.serverPort
} elseif (Test-QunZaiAt $port) {
    $existingPort = $port
}
if ($existingPort -gt 0) {
    $port = $existingPort
    $url = "http://127.0.0.1:$port"
    if (-not $NoBrowser) { Open-PanelOnce $url }
    if ($LiveConsole) {
        try { $Host.UI.RawUI.WindowTitle = 'QunZai' } catch { }
        Write-Host ''
        Write-Host "  服务已在运行：$url" -ForegroundColor Yellow
        Write-Host '  如需重启服务：在桌面窗口右上角停止服务，再点击启动服务。'
        Write-Host ''
        Start-Sleep -Seconds 5
    }
    exit 0
}

# 首选端口被别的程序占用：不弹窗、不退出，自动向后找一个空闲端口
if (Test-Port $port) {
    $nextPort = Find-FreePort ($port + 1)
    if ($nextPort -le 0) {
        Show-Msg "端口 $port 已被其他程序占用，且后面连续 60 个端口也不可用。`n`n请关闭占用端口的程序后重试。" '端口被占用'
        exit 1
    }
    Write-Host "端口 $port 被占用，自动改用 $nextPort。" -ForegroundColor Yellow
    $port = $nextPort
}
$env:QUNZAI_SERVER_PORT = [string]$port
$url = "http://127.0.0.1:$port"

# ---------- 清理旧的停止标记，准备守护启动 ----------
try { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue } catch { }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# 日志统一由 node 侧写入 data\app.log（追加式，控制台窗口是它的实时视图），无需重定向

if ($LiveConsole) {
    # 实时控制台模式：本窗口就是程序 —— 日志直接滚动，关掉窗口 = 停止服务
    try { $Host.UI.RawUI.WindowTitle = '群崽 QunZai 日志' } catch { }
    Write-Host ''
    Write-Host ('  群崽 QunZai 已启动 · ' + (Get-Date -Format 'HH:mm:ss')) -ForegroundColor Green
    Write-Host '  关闭本窗口 = 停止服务。'
    Write-Host '  ------------------------------------------------------------'
}

# ---------- 守护循环：拉起服务，挂了就自动重启 ----------
# 控制台句柄兜底检测：日志窗口一旦关闭，守护同步退出
if ($LiveConsole) {
    try { Add-Type -Namespace Wdeep -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();' -ErrorAction SilentlyContinue } catch { }
}
$panelOpened = $false
while ($true) {
    if ($LiveConsole) {
        try { if ([Wdeep.Native]::GetConsoleWindow() -eq [IntPtr]::Zero) { exit 0 } } catch { /* 类型未加载则跳过，13A 检测仍兜底 */ }
    }
    $proc = $null
    try {
        # -NoNewWindow：node 挂在本控制台 —— 窗口即日志实时视图（日志本体由 node 写入 data\app.log）
        $proc = Start-Process -FilePath $nodeExe `
            -ArgumentList 'server\server.js' `
            -WorkingDirectory $root `
            -NoNewWindow `
            -PassThru
    } catch {
        Show-Msg "启动服务失败：`n$($_.Exception.Message)" '启动失败'
        exit 1
    }
    # 等真实端口就绪后再开网页：服务可能因端口占用自动换端口
    if (-not $NoBrowser -and -not $panelOpened) {
        $actualPort = Wait-ForServer $port 25
        if ($actualPort -gt 0) {
            $port = $actualPort
            $url = "http://127.0.0.1:$port"
            Open-PanelOnce $url
            $panelOpened = $true
        }
    }
    # 监控：进程退出 或 收到停止标记
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 3
        if (Test-Path $stopFlag) {
            try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
            break
        }
    }
    if (Test-Path $stopFlag) {
        try { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue } catch { }
        exit 0
    }
    # 进程意外退出 → 提示并 3 秒后自动重启（防抽风）
    $exitCode = $proc.ExitCode
    if ($exitCode -eq 2) {
        Show-Msg "服务启动失败：端口 $port 已被其他程序占用。`n`n请关闭占用该端口的程序，或修改 config.json 里的 server.port 后重新启动。" '端口被占用'
        exit 2
    }
    if ($exitCode -eq -1073741510) {
        # 0xC000013A = 控制台关闭 / Ctrl+C 信号 —— 用户主动关停，守护同步退出，不复活
        try {
            $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
            Add-Content -Path (Join-Path $logDir 'launcher.log') -Value "[$stamp] 收到窗口关闭信号（0xC000013A），守护退出，服务已停止。" -Encoding UTF8
        } catch { }
        if ($LiveConsole) { Write-Host '  服务已停止（窗口信号）。' -ForegroundColor Yellow }
        exit 0
    }
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path (Join-Path $logDir 'launcher.log') -Value "[$stamp] 服务进程退出(code=$exitCode)，3 秒后自动重启…" -Encoding UTF8
    } catch { }
    if ($LiveConsole) {
        Write-Host ('  [!] 服务进程意外退出，3 秒后自动重启… (' + (Get-Date -Format 'HH:mm:ss') + ')') -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 3
}
