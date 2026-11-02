using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QunZai
{
    internal static class HostLog
    {
        public static void Write(string message)
        {
            try
            {
                string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "desktop-host.log");
                File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + "\r\n");
            }
            catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            HostLog.Write("host start");
            AppDomain.CurrentDomain.UnhandledException += delegate (object sender, UnhandledExceptionEventArgs e)
            {
                HostLog.Write("unhandled: " + (e.ExceptionObject == null ? "null" : e.ExceptionObject.ToString()));
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch { }
            Application.Run(new MainForm());
            HostLog.Write("host exit");
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly string _root;
        private int _serverPort;
        private int _cdpPort;
        private bool _startedServer;
        private bool _serverDirect;
        private Process _serverProcess;
        private WebView2 _dashboard;
        private WebView2 _deepseek;
        private Panel _contentHost;
        private Label _dashboardTab;
        private Label _deepseekTab;
        private Label _status;
        private FlowLayoutPanel _tabBar;
        private TableLayoutPanel _topBar;
        private Button _startButton;
        private Panel _statusPanel;
        private TableLayoutPanel _layout;
        private Label _loading;
        private bool _showDeepSeek;
        private bool _webReady;
        private bool _lightTheme;
        private bool _serviceRunning;
        private bool _serviceBusy;
        private bool _serviceStoppedByUser;
        private Rectangle _dsSlotRect;
        private bool _dsSlotRectReady;
        private bool _dsSlotVisible = true;
        private readonly string _launcher;
        private readonly string _profileDir;
        private NotifyIcon _tray;
        private ContextMenuStrip _trayMenu;
        private bool _trayTipShown;
        private bool _reallyExit;

        private static readonly Color DarkBg = Color.FromArgb(10, 14, 20);
        private static readonly Color DarkPanel = Color.FromArgb(15, 21, 32);
        private static readonly Color DarkLine = Color.FromArgb(28, 40, 56);
        private static readonly Color DarkText = Color.FromArgb(217, 226, 238);
        private static readonly Color DarkDim = Color.FromArgb(125, 142, 163);
        private static readonly Color LightBg = Color.FromArgb(238, 244, 250);
        private static readonly Color LightPanel = Color.FromArgb(248, 251, 255);
        private static readonly Color LightLine = Color.FromArgb(215, 227, 239);
        private static readonly Color LightText = Color.FromArgb(21, 36, 53);
        private static readonly Color LightDim = Color.FromArgb(88, 108, 130);
        private Color _bg = DarkBg;
        private Color _panel = DarkPanel;
        private Color _line = DarkLine;
        private Color _text = DarkText;
        private Color _dim = DarkDim;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public MainForm()
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            _root = Path.GetFullPath(Path.Combine(exeDir, ".."));
            if (!File.Exists(Path.Combine(_root, "server", "server.js")))
            {
                // 开发时也可能从 app\desktop\bin 运行，继续向上找一层
                string up = Path.GetFullPath(Path.Combine(exeDir, "..", ".."));
                if (File.Exists(Path.Combine(up, "server", "server.js"))) _root = up;
            }
            _launcher = Path.Combine(_root, "launcher.ps1");
            _profileDir = Path.Combine(_root, "data", "webview_profile");
            HostLog.Write("root=" + _root + " launcher=" + _launcher);

            Text = "群崽 QunZai";
            Width = 1280;
            Height = 860;
            MinimumSize = new Size(900, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = _bg;
            ForeColor = _text;
            try
            {
                string ico = Path.Combine(_root, "assets", "icon.ico");
                if (File.Exists(ico)) Icon = new Icon(ico);
            }
            catch { }

            SetupTray();

            _tabBar = new FlowLayoutPanel();
            _tabBar.Dock = DockStyle.Fill;
            _tabBar.BackColor = _bg;
            _tabBar.FlowDirection = FlowDirection.LeftToRight;
            _tabBar.WrapContents = false;
            _tabBar.Padding = new Padding(12, 6, 0, 0);

            _dashboardTab = CreateTab("监控台");
            _deepseekTab = CreateTab("DeepSeek · 全屏");
            _dashboardTab.Click += delegate { SelectTab(false); };
            _deepseekTab.Click += delegate { SelectTab(true); };
            _tabBar.Controls.Add(_dashboardTab);
            // 全屏标签默认不出现；进入全屏时只显示「← 返回监控台」。
            _deepseekTab.Visible = false;

            _topBar = new TableLayoutPanel();
            _topBar.Dock = DockStyle.Fill;
            _topBar.ColumnCount = 1;
            _topBar.RowCount = 1;
            _topBar.BackColor = _bg;
            _topBar.Margin = new Padding(0);
            _topBar.Padding = new Padding(0);
            _topBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            _topBar.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            _topBar.Controls.Add(_tabBar, 0, 0);

            _contentHost = new Panel();
            _contentHost.Dock = DockStyle.Fill;
            _contentHost.BackColor = _bg;

            _dashboard = new WebView2();
            _dashboard.Dock = DockStyle.Fill;
            _dashboard.DefaultBackgroundColor = _bg;
            _dashboard.Visible = false;
            _dashboard.SizeChanged += delegate
            {
                if (_webReady && !_showDeepSeek) RequestDeepSeekSync();
            };
            _contentHost.Controls.Add(_dashboard);

            _deepseek = new WebView2();
            // 先铺满内容区保证 WebView2 有非零视口；页面把「实时动态」右半边
            // 占位区坐标发上来后，再改成绝对定位盖到占位区上。
            _deepseek.Dock = DockStyle.Fill;
            _deepseek.DefaultBackgroundColor = _bg;
            // WebView2 初始化完成前先收起，避免白色空窗口盖住启动提示。
            _deepseek.Visible = false;
            _contentHost.Controls.Add(_deepseek);

            _loading = new Label();
            _loading.Dock = DockStyle.Fill;
            _loading.Text = "正在启动群崽…";
            _loading.TextAlign = ContentAlignment.MiddleCenter;
            _loading.BackColor = _bg;
            _loading.ForeColor = _dim;
            _loading.Font = new Font("Microsoft YaHei", 11F, FontStyle.Regular);
            _contentHost.Controls.Add(_loading);

            // 服务停止后页面已经不可用，用一个原生按钮让用户能重新启动。
            _startButton = new Button();
            _startButton.Text = "启动服务";
            _startButton.Width = 132;
            _startButton.Height = 36;
            _startButton.FlatStyle = FlatStyle.Flat;
            _startButton.FlatAppearance.BorderSize = 1;
            _startButton.FlatAppearance.BorderColor = _line;
            _startButton.FlatAppearance.MouseOverBackColor = _bg;
            _startButton.BackColor = _panel;
            _startButton.ForeColor = _text;
            _startButton.Font = new Font("Microsoft YaHei", 10F, FontStyle.Regular);
            _startButton.Cursor = Cursors.Hand;
            _startButton.Visible = false;
            _startButton.Click += async delegate { await StartServiceAsync(); };
            _contentHost.Controls.Add(_startButton);
            _contentHost.Resize += delegate { PositionStartButton(); };

            _statusPanel = new Panel();
            _statusPanel.Dock = DockStyle.Fill;
            _statusPanel.BackColor = _panel;
            _statusPanel.Paint += delegate (object sender, PaintEventArgs e)
            {
                using (Pen line = new Pen(_line))
                    e.Graphics.DrawLine(line, 0, 0, _statusPanel.Width, 0);
            };
            _status = new Label();
            _status.Dock = DockStyle.Fill;
            _status.Text = "正在准备…";
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(10, 0, 10, 0);
            _status.BackColor = Color.Transparent;
            _status.ForeColor = _dim;
            _statusPanel.Controls.Add(_status);

            _layout = new TableLayoutPanel();
            _layout.Dock = DockStyle.Fill;
            _layout.ColumnCount = 1;
            _layout.RowCount = 3;
            _layout.BackColor = _bg;
            _layout.Margin = new Padding(0);
            _layout.Padding = new Padding(0);
            _layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));
            _layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            _layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26F));
            _layout.Controls.Add(_topBar, 0, 0);
            _layout.Controls.Add(_contentHost, 0, 1);
            _layout.Controls.Add(_statusPanel, 0, 2);
            Controls.Add(_layout);

            // 默认内嵌模式：整个原生标签栏收起，把纵向空间让给页面。
            _topBar.Visible = false;
            _layout.RowStyles[0].Height = 0F;

            SelectTab(false);
            if (_loading != null) _loading.BringToFront();
            Shown += async delegate { await InitializeAsync(); };
            FormClosing += OnClosing;
            Resize += delegate
            {
                if (WindowState != FormWindowState.Minimized) return;
                HideToTray();
            };
        }

        private void HideToTray()
        {
            if (_tray == null) return;
            HostLog.Write("hide to tray");
            Hide();
            if (!_trayTipShown)
            {
                _trayTipShown = true;
                try { _tray.ShowBalloonTip(1800, "群崽 QunZai", "已最小化到托盘，双击图标恢复窗口。", ToolTipIcon.Info); } catch { }
            }
        }

        private void SetupTray()
        {
            try
            {
                _trayMenu = new ContextMenuStrip();
                _trayMenu.Items.Add("显示主窗口", null, delegate { ShowFromTray(); });
                _trayMenu.Items.Add(new ToolStripSeparator());
                _trayMenu.Items.Add("退出群崽", null, delegate { _reallyExit = true; Close(); });

                _tray = new NotifyIcon();
                _tray.Icon = Icon ?? SystemIcons.Application;
                _tray.Text = "群崽 QunZai · 双击恢复窗口";
                _tray.ContextMenuStrip = _trayMenu;
                _tray.Visible = true;
                _tray.DoubleClick += delegate { ShowFromTray(); };
                _tray.BalloonTipTitle = "群崽 QunZai";
                _tray.BalloonTipText = "窗口已最小化到托盘，双击图标恢复。";
                HostLog.Write("tray icon ready");
            }
            catch (Exception ex)
            {
                HostLog.Write("tray icon failed: " + ex.Message);
            }
        }

        private void ShowFromTray()
        {
            try
            {
                if (IsDisposed) return;
                HostLog.Write("show from tray");
                Show();
                ShowInTaskbar = true;
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Activate();
                BringToFront();
                // 从托盘/后台弹提示时，Windows 可能不给前台焦点；
                // 短暂置顶再取消，保证窗口真的出现在用户眼前。
                TopMost = true;
                TopMost = false;
                if (_dashboard != null && _dashboard.Visible) _dashboard.Focus();
                RequestDeepSeekSync();
            }
            catch { }
        }

        private Label CreateTab(string text)
        {
            Label tab = new Label();
            tab.Text = text;
            tab.Width = 150;
            tab.Height = 30;
            tab.Margin = new Padding(0, 0, 2, 0);
            tab.TextAlign = ContentAlignment.MiddleCenter;
            tab.Cursor = Cursors.Hand;
            tab.BackColor = _bg;
            tab.ForeColor = _dim;
            return tab;
        }

        private void SelectTab(bool showDeepSeek)
        {
            _showDeepSeek = showDeepSeek;
            bool full = showDeepSeek && _webReady && _serviceRunning;
            if (_topBar != null)
            {
                _topBar.Visible = full;
                if (_layout != null && _layout.RowStyles.Count > 0)
                    _layout.RowStyles[0].Height = full ? 42F : 0F;
                _dashboardTab.Text = full ? "← 返回监控台" : "监控台";
            }
            if (_webReady && _serviceRunning)
            {
                // DeepSeek 始终保持非零尺寸；隐藏成可见性=false 会让网页视口变成 0，
                // 新建对话后输入/发送会卡住。工作台模式下把它盖到页面右半边。
                _dashboard.Visible = !showDeepSeek;
                _deepseek.Visible = true;
                if (showDeepSeek)
                {
                    _deepseek.Dock = DockStyle.Fill;
                    _deepseek.Bounds = _contentHost.ClientRectangle;
                    _deepseek.BringToFront();
                }
                else
                {
                    _dashboard.BringToFront();
                    ApplyDeepSeekSlot();
                    RequestDeepSeekSync();
                }
            }
            else
            {
                // WebView2 是独立 HWND，WinForms 的“已停止”提示盖不住它；
                // 服务停止时直接收起，避免页面的浮层透出来。
                _dashboard.Visible = false;
                _deepseek.Visible = false;
            }
            _dashboardTab.BackColor = showDeepSeek ? _bg : _panel;
            _deepseekTab.BackColor = showDeepSeek ? _panel : _bg;
            _dashboardTab.ForeColor = showDeepSeek ? _dim : _text;
            _deepseekTab.ForeColor = showDeepSeek ? _text : _dim;
            if (_loading != null && _loading.Visible) _loading.BringToFront();
        }

        /// <summary>页面把「实时动态」右半边占位区的坐标发上来后，把内嵌 WebView2 盖上去。</summary>
        private void ApplyDeepSeekSlot()
        {
            if (_showDeepSeek || !_webReady || !_serviceRunning || !_dsSlotRectReady) return;
            _deepseek.Dock = DockStyle.None;
            if (_dsSlotVisible)
            {
                _deepseek.Bounds = _dsSlotRect;
                _deepseek.Visible = true;
                _deepseek.BringToFront();
            }
            else
            {
                // 被设置弹窗遮挡或在屏幕外时，不能把尺寸设为 0；平移出父容器即可。
                _deepseek.Bounds = new Rectangle(
                    -_dsSlotRect.Width - 80,
                    _dsSlotRect.Top,
                    _dsSlotRect.Width,
                    _dsSlotRect.Height);
                _deepseek.Visible = true;
            }
        }

        /// <summary>让页面重新上报 DeepSeek 占位区位置（窗口缩放、切回工作台时用）。</summary>
        private async void RequestDeepSeekSync()
        {
            try
            {
                if (_dashboard != null && _dashboard.CoreWebView2 != null)
                    await _dashboard.CoreWebView2.ExecuteScriptAsync("window.qzSyncDeepSeek && window.qzSyncDeepSeek()");
            }
            catch { }
        }

        private void ApplyTheme(bool light)
        {
            _lightTheme = light;
            _bg = light ? LightBg : DarkBg;
            _panel = light ? LightPanel : DarkPanel;
            _line = light ? LightLine : DarkLine;
            _text = light ? LightText : DarkText;
            _dim = light ? LightDim : DarkDim;

            BackColor = _bg;
            ForeColor = _text;
            if (_layout != null) _layout.BackColor = _bg;
            if (_topBar != null) _topBar.BackColor = _bg;
            if (_tabBar != null) _tabBar.BackColor = _bg;
            if (_startButton != null)
            {
                _startButton.BackColor = _panel;
                _startButton.ForeColor = _text;
                _startButton.FlatAppearance.BorderColor = _line;
                _startButton.FlatAppearance.MouseOverBackColor = _bg;
            }
            if (_contentHost != null) _contentHost.BackColor = _bg;
            if (_loading != null)
            {
                _loading.BackColor = _bg;
                _loading.ForeColor = _dim;
            }
            if (_statusPanel != null)
            {
                _statusPanel.BackColor = _panel;
                _statusPanel.Invalidate();
            }
            if (_status != null) _status.ForeColor = _dim;
            if (_dashboardTab != null && _deepseekTab != null)
                SelectTab(_showDeepSeek);
            try { _dashboard.DefaultBackgroundColor = _bg; } catch { }
            try { _deepseek.DefaultBackgroundColor = _bg; } catch { }
            ApplyDwmTheme();
            Invalidate(true);
        }

        private void PositionStartButton()
        {
            if (_startButton == null || _contentHost == null) return;
            int w = _contentHost.ClientSize.Width;
            int h = _contentHost.ClientSize.Height;
            _startButton.Left = Math.Max(0, (w - _startButton.Width) / 2);
            _startButton.Top = Math.Max(0, (h / 2) + 36);
        }

        private void ShowStoppedOverlay(string text)
        {
            if (_loading != null)
            {
                _loading.Text = text;
                _loading.BackColor = _bg;
                _loading.ForeColor = _dim;
                _loading.Visible = true;
                _loading.BringToFront();
            }
            if (_startButton != null)
            {
                PositionStartButton();
                _startButton.Text = "启动服务";
                _startButton.Enabled = true;
                _startButton.BackColor = _panel;
                _startButton.ForeColor = _text;
                _startButton.FlatAppearance.BorderColor = _line;
                _startButton.FlatAppearance.MouseOverBackColor = _bg;
                _startButton.Visible = true;
                _startButton.BringToFront();
            }
        }

        private void HideStartButton()
        {
            if (_startButton != null) _startButton.Visible = false;
        }

        private void SetServiceUi(bool running, bool busy, string text)
        {
            _serviceRunning = running;
            _serviceBusy = busy;
            if (_startButton != null)
            {
                _startButton.Enabled = !busy;
                _startButton.Text = busy ? "启动中…" : "启动服务";
            }
        }

        /// <summary>页面顶栏的「停止服务」按钮发来消息后调用。</summary>
        private async void StopServiceFromPage()
        {
            if (_serviceBusy || !_serviceRunning) return;
            await StopServiceAsync();
        }

        private async Task StopServiceAsync()
        {
            HideStartButton();
            SetServiceUi(true, true, "停止中…");
            _status.Text = "正在停止服务…";
            try
            {
                await Task.Run(delegate { StopServerProcess(); });
                _startedServer = false;
                _serverProcess = null;
                _serviceStoppedByUser = true;
                SetServiceUi(false, false, "启动服务");
                SelectTab(_showDeepSeek);
                _status.Text = "服务已停止 · 点击「启动服务」重新上线";
                ShowStoppedOverlay("服务已停止\n\nQQ 机器人已下线，点击下方按钮重新上线");
            }
            catch (Exception ex)
            {
                HostLog.Write("stop service failed: " + ex);
                SetServiceUi(true, false, "停止服务");
                _status.Text = "停止服务失败";
                MessageBox.Show(this, "停止服务失败：\n" + ex.Message,
                    "群崽 QunZai", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task StartServiceAsync()
        {
            _serviceStoppedByUser = false;
            HideStartButton();
            SetServiceUi(false, true, "启动中…");
            _status.Text = "正在启动服务…";
            if (_loading != null)
            {
                _loading.Text = "正在启动服务…";
                _loading.BackColor = _bg;
                _loading.ForeColor = _dim;
                _loading.Visible = true;
                _loading.BringToFront();
            }

            try
            {
                bool running = _serverPort > 0 && IsQunZai(_serverPort);
                if (!running)
                {
                    int runtimePort = ReadRuntimeInt(_root, "serverPort");
                    if (runtimePort > 0 && IsQunZai(runtimePort))
                    {
                        _serverPort = runtimePort;
                        running = true;
                    }
                }

                if (!running)
                {
                    if (_serverPort <= 0 || !IsPortFree(_serverPort))
                    {
                        int nextPort = FindFreePort(Math.Max(8787, _serverPort + 1));
                        if (nextPort <= 0) throw new Exception("端口连续 60 个都被占用");
                        _serverPort = nextPort;
                    }
                    if (_cdpPort <= 0) throw new Exception("缺少 WebView2 CDP 端口");
                    StartServer();
                    if (!await WaitForQunZaiAsync())
                        throw new Exception("服务启动超时，请查看 data\\app.log 与 data\\launcher.log");
                }

                if (_cdpPort <= 0)
                {
                    int c = ReadRuntimeInt(_root, "cdpPort");
                    if (c > 0) _cdpPort = c;
                    if (_cdpPort <= 0) throw new Exception("找不到 WebView2 CDP 端口");
                }

                SetServiceUi(true, false, "停止服务");
                HideStartButton();
                if (_webReady)
                {
                    if (_loading != null)
                    {
                        _loading.Text = "正在准备界面…";
                        _loading.Visible = true;
                        _loading.BringToFront();
                    }
                    _dashboard.CoreWebView2.Navigate("http://127.0.0.1:" + _serverPort + "/");
                }
                else
                {
                    if (_loading != null) _loading.Text = "正在准备界面…";
                    await CreateWebViewsAsync();
                }
                _status.Text = "运行中 · 服务 " + _serverPort + " · DeepSeek CDP " + _cdpPort;
            }
            catch (Exception ex)
            {
                HostLog.Write("start service failed: " + ex);
                bool running = _serverPort > 0 && IsQunZai(_serverPort);
                SetServiceUi(running, false, running ? "停止服务" : "启动服务");
                _status.Text = "启动失败";
                if (running)
                {
                    HideStartButton();
                    if (_loading != null) _loading.Visible = false;
                }
                else
                {
                    ShowStoppedOverlay("启动失败\n" + ex.Message + "\n\n点击下方按钮重试");
                }
                MessageBox.Show(this, ex.Message, "群崽 QunZai 启动失败",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task<bool> WaitForQunZaiAsync()
        {
            DateTime until = DateTime.Now.AddSeconds(35);
            while (DateTime.Now < until)
            {
                if (IsQunZai(_serverPort)) return true;
                int runtimePort = ReadRuntimeInt(_root, "serverPort");
                if (runtimePort > 0 && runtimePort != _serverPort && IsQunZai(runtimePort))
                {
                    _serverPort = runtimePort;
                    return true;
                }
                await Task.Delay(300);
            }
            return false;
        }

        private void RunLauncherStop()
        {
            if (!File.Exists(_launcher)) throw new Exception("找不到 launcher.ps1，无法停止服务");
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + _launcher + "\" -Stop";
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process p = Process.Start(psi))
            {
                if (p != null) p.WaitForExit(15000);
            }
        }

        private void StopServerProcess()
        {
            bool killedDirect = false;
            if (_serverDirect && _serverProcess != null)
            {
                try
                {
                    if (!_serverProcess.HasExited)
                    {
                        _serverProcess.Kill();
                        _serverProcess.WaitForExit(8000);
                    }
                    killedDirect = true;
                }
                catch (Exception ex)
                {
                    HostLog.Write("direct server stop failed: " + ex.Message);
                }
            }

            bool stillRunning = _serverPort > 0 && IsQunZai(_serverPort);
            if (!killedDirect || stillRunning)
            {
                if (File.Exists(_launcher)) RunLauncherStop();
                else if (!killedDirect && _serverProcess != null)
                {
                    try { if (!_serverProcess.HasExited) { _serverProcess.Kill(); _serverProcess.WaitForExit(8000); } }
                    catch { }
                }
            }

            for (int i = 0; i < 20; i++)
            {
                if (_serverPort <= 0 || !IsQunZai(_serverPort)) return;
                System.Threading.Thread.Sleep(150);
            }
            if (_serverPort > 0 && IsQunZai(_serverPort))
                throw new Exception("服务仍在运行，请稍后重试");
        }

        private void ApplyDwmTheme()
        {
            try
            {
                int dark = _lightTheme ? 0 : 1;
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
                DwmSetWindowAttribute(Handle, 19, ref dark, sizeof(int));
                int border = ColorTranslator.ToWin32(_line);
                int caption = ColorTranslator.ToWin32(_panel);
                int captionText = ColorTranslator.ToWin32(_text);
                DwmSetWindowAttribute(Handle, 34, ref border, sizeof(int));
                DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
                DwmSetWindowAttribute(Handle, 36, ref captionText, sizeof(int));
            }
            catch { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyDwmTheme();
        }

        private static int ReadInt(string text, string key, int fallback)
        {
            Match m = Regex.Match(text, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(\\d+)");
            int value;
            if (m.Success && int.TryParse(m.Groups[1].Value, out value)) return value;
            return fallback;
        }

        private static string ReadConfig(string root)
        {
            try { return File.ReadAllText(Path.Combine(root, "config.json")); }
            catch { return "{}"; }
        }

        private static bool IsPortFree(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return true;
            }
            catch { return false; }
            finally { if (listener != null) { try { listener.Stop(); } catch { } } }
        }

        private static int FindFreePort(int start)
        {
            for (int p = start; p < Math.Min(65536, start + 60); p++)
                if (IsPortFree(p)) return p;
            return 0;
        }

        private static string HttpGet(string url, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(resp.GetResponseStream()))
                return reader.ReadToEnd();
        }

        private static bool IsQunZai(int port)
        {
            try { return HttpGet("http://127.0.0.1:" + port + "/api/status", 900).Contains("\"qq\""); }
            catch { return false; }
        }

        private static bool IsCdp(int port)
        {
            try { return HttpGet("http://127.0.0.1:" + port + "/json/version", 700).Contains("\"Browser\""); }
            catch { return false; }
        }

        private static int ReadRuntimeInt(string root, string key)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(root, "data", "runtime.json"));
                return ReadInt(text, key, 0);
            }
            catch { return 0; }
        }

        private async Task InitializeAsync()
        {
            try
            {
                HostLog.Write("initialize start");
                // 先让窗口把启动提示画出来，再开始端口探测/启动服务；
                // 否则 Shown 里的同步探测会把 UI 线程占住，用户只看到一片白。
                await Task.Delay(120);
                string cfg = ReadConfig(_root);
                int preferredServer = ReadInt(cfg, "port", 8787);
                int preferredCdp = ReadInt(cfg, "cdpPort", 9222);
                string envServer = Environment.GetEnvironmentVariable("QUNZAI_SERVER_PORT");
                string envCdp = Environment.GetEnvironmentVariable("QUNZAI_CDP_PORT");
                int n;
                if (int.TryParse(envServer, out n) && n > 0) preferredServer = n;
                if (int.TryParse(envCdp, out n) && n > 0) preferredCdp = n;

                int runtimePort = ReadRuntimeInt(_root, "serverPort");
                if (runtimePort > 0 && IsQunZai(runtimePort))
                {
                    _serverPort = runtimePort;
                    _status.Text = "已连接到正在运行的群崽服务";
                }
                else if (runtimePort != preferredServer && IsQunZai(preferredServer))
                {
                    _serverPort = preferredServer;
                    _status.Text = "已连接到正在运行的群崽服务";
                }
                else
                {
                    _serverPort = IsPortFree(preferredServer) ? preferredServer : FindFreePort(preferredServer + 1);
                    if (_serverPort <= 0) throw new Exception("服务端口连续 60 个都被占用");
                    if (!(IsCdp(preferredCdp) || IsPortFree(preferredCdp)))
                        preferredCdp = FindFreePort(preferredCdp + 1);
                    if (preferredCdp <= 0) throw new Exception("CDP 端口连续 60 个都被占用");
                    _cdpPort = preferredCdp;
                    StartServer();
                    if (!await WaitForServerAsync())
                        throw new Exception("服务启动超时，请查看 data\\app.log 与 data\\launcher.log");
                }

                if (_cdpPort <= 0)
                {
                    string runtime = "";
                    try { runtime = File.ReadAllText(Path.Combine(_root, "data", "runtime.json")); } catch { }
                    _cdpPort = ReadInt(runtime, "cdpPort", preferredCdp);
                }

                if (_loading != null) _loading.Text = "正在准备界面…";
                await CreateWebViewsAsync();
                SetServiceUi(true, false, "停止服务");
                SelectTab(_showDeepSeek);
                _status.Text = "运行中 · 服务 " + _serverPort + " · DeepSeek CDP " + _cdpPort;
            }
            catch (WebView2RuntimeNotFoundException ex)
            {
                HostLog.Write("webview2 runtime missing: " + ex.Message);
                bool running = _serverPort > 0 && IsQunZai(_serverPort);
                SetServiceUi(running, false, running ? "停止服务" : "启动服务");
                _status.Text = "缺少 WebView2 运行时";
                MessageBox.Show(this,
                    "未检测到 Microsoft Edge WebView2 运行时。\n\nWindows 11 通常自带；Windows 10 请安装后重试：\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
                    "群崽 QunZai", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception ex)
            {
                HostLog.Write("initialize failed: " + ex);
                bool running = _serverPort > 0 && IsQunZai(_serverPort);
                SetServiceUi(running, false, running ? "停止服务" : "启动服务");
                _status.Text = "启动失败";
                if (running)
                {
                    HideStartButton();
                    if (_loading != null) _loading.Visible = false;
                }
                else
                {
                    ShowStoppedOverlay("启动失败\n" + ex.Message + "\n\n点击下方按钮重试");
                }
                MessageBox.Show(this, ex.Message, "群崽 QunZai 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string FindNode()
        {
            // 优先用安装包内置的 Node（随内置 QQ QQ 桥接一起来的那份），
            // 这样用户不用自己装 Node.js，双击就能跑。
            try
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                string[] bundled =
                {
                    Path.Combine(root, "engine", "napcat", "node.exe"),
                    Path.Combine(root, "engine", "snowluma", "node.exe")
                };
                foreach (string exe in bundled)
                {
                    if (File.Exists(exe)) return exe;
                }
            }
            catch { }

            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string part in pathValue.Split(Path.PathSeparator))
            {
                try
                {
                    string dir = part.Trim().Trim('"');
                    if (string.IsNullOrWhiteSpace(dir)) continue;
                    string exe = Path.Combine(dir, "node.exe");
                    if (File.Exists(exe)) return exe;
                }
                catch { }
            }
            try
            {
                string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string exe = Path.Combine(programFiles, "nodejs", "node.exe");
                if (File.Exists(exe)) return exe;
            }
            catch { }
            return null;
        }

        private bool TryStartNode()
        {
            string node = FindNode();
            if (node == null) return false;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = node;
                psi.Arguments = "server\\server.js";
                psi.WorkingDirectory = _root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.EnvironmentVariables["QUNZAI_SERVER_PORT"] = _serverPort.ToString();
                psi.EnvironmentVariables["QUNZAI_CDP_PORT"] = _cdpPort.ToString();
                psi.EnvironmentVariables["QUNZAI_EMBEDDED"] = "1";
                _serverProcess = Process.Start(psi);
                if (_serverProcess == null) return false;
                _startedServer = true;
                _serverDirect = true;
                _status.Text = "正在启动服务…";
                HostLog.Write("server launched with node pid=" + _serverProcess.Id);
                return true;
            }
            catch (Exception ex)
            {
                HostLog.Write("direct node start failed: " + ex.Message);
                return false;
            }
        }

        private void StartServer()
        {
            // 桌面内嵌模式直接拉起 node，省掉 powershell 启动器约几秒的冷启动；
            // 找不到 node 时再回退到 launcher.ps1（保留原有的守护/停止能力）。
            if (TryStartNode()) return;
            if (!File.Exists(_launcher)) throw new Exception("找不到 launcher.ps1");
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + _launcher + "\" -NoBrowser -Embedded -ServerPortOverride " + _serverPort + " -CdpPortOverride " + _cdpPort;
            psi.WorkingDirectory = _root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.EnvironmentVariables["QUNZAI_SERVER_PORT"] = _serverPort.ToString();
            psi.EnvironmentVariables["QUNZAI_CDP_PORT"] = _cdpPort.ToString();
            psi.EnvironmentVariables["QUNZAI_EMBEDDED"] = "1";
            _serverProcess = Process.Start(psi);
            _startedServer = true;
            _serverDirect = false;
            HostLog.Write("server launched with launcher pid=" + (_serverProcess == null ? 0 : _serverProcess.Id));
            _status.Text = "正在启动服务…";
        }

        private async Task<bool> WaitForServerAsync()
        {
            DateTime until = DateTime.Now.AddSeconds(35);
            while (DateTime.Now < until)
            {
                int c = ReadRuntimeInt(_root, "cdpPort");
                if (c > 0) _cdpPort = c;
                int p = ReadRuntimeInt(_root, "serverPort");
                if (p > 0 && c > 0 && IsQunZai(p)) { _serverPort = p; return true; }
                if (p <= 0 && IsQunZai(_serverPort) && c > 0) return true;
                await Task.Delay(500);
            }
            return false;
        }

        private async Task CreateWebViewsAsync()
        {
            Directory.CreateDirectory(_profileDir);
            CoreWebView2EnvironmentOptions options =
                new CoreWebView2EnvironmentOptions("--remote-debugging-port=" + _cdpPort + " --remote-allow-origins=*");
            HostLog.Write("creating webview2 environment, cdp=" + _cdpPort);
            CoreWebView2Environment env =
                await CoreWebView2Environment.CreateAsync(null, _profileDir, options);
            HostLog.Write("webview2 environment ready");
            await _dashboard.EnsureCoreWebView2Async(env);
            HostLog.Write("dashboard webview ready");
            await _deepseek.EnsureCoreWebView2Async(env);
            HostLog.Write("deepseek webview ready");

            _dashboard.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _deepseek.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _dashboard.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;

            _deepseek.CoreWebView2.NewWindowRequested += delegate (object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try { _deepseek.CoreWebView2.Navigate(e.Uri); } catch { }
            };
            // 监控台里的官网 / GitHub / 爱发电等外链：用系统默认浏览器打开，
            // 不要把监控台本身导航走，也不要在 WebView 里弹新窗口。
            _dashboard.CoreWebView2.NewWindowRequested += delegate (object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                try
                {
                    if (e.Uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                        e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                        e.Uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
                    {
                        Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
                    }
                }
                catch (Exception ex) { HostLog.Write("open external failed: " + ex.Message); }
            };
            _dashboard.CoreWebView2.WebMessageReceived += delegate (object sender, CoreWebView2WebMessageReceivedEventArgs e)
            {
                try
                {
                    string msg = e.WebMessageAsJson;
                    Match theme = Regex.Match(msg, "\"theme\"\\s*:\\s*\"(light|dark)\"");
                    if (theme.Success)
                    {
                        bool light = theme.Groups[1].Value == "light";
                        if (light != _lightTheme) ApplyTheme(light);
                    }

                    // 页面把「实时动态」右半边 DeepSeek 占位区的坐标发上来。
                    // 坐标是 CSS 像素，乘以当前 DPI 比例换成 WinForms 的物理像素。
                    if (Regex.IsMatch(msg, "\"type\"\\s*:\\s*\"deepseek-bounds\""))
                    {
                        Match mx = Regex.Match(msg, "\"x\"\\s*:\\s*(-?\\d+)");
                        Match my = Regex.Match(msg, "\"y\"\\s*:\\s*(-?\\d+)");
                        Match mw = Regex.Match(msg, "\"width\"\\s*:\\s*(-?\\d+)");
                        Match mh = Regex.Match(msg, "\"height\"\\s*:\\s*(-?\\d+)");
                        Match mv = Regex.Match(msg, "\"visible\"\\s*:\\s*(true|false)");
                        if (mx.Success && my.Success && mw.Success && mh.Success)
                        {
                            double scale = _dashboard.DeviceDpi / 96.0;
                            if (scale <= 0 || scale > 4) scale = 1.0;
                            int cssX = int.Parse(mx.Groups[1].Value);
                            int cssY = int.Parse(my.Groups[1].Value);
                            int cssW = Math.Max(1, int.Parse(mw.Groups[1].Value));
                            int cssH = Math.Max(1, int.Parse(mh.Groups[1].Value));
                            int left = (int)Math.Round(cssX * scale);
                            int top = (int)Math.Round(cssY * scale);
                            int right = (int)Math.Round((cssX + cssW) * scale);
                            int bottom = (int)Math.Round((cssY + cssH) * scale);
                            _dsSlotRect = new Rectangle(left, top, Math.Max(1, right - left), Math.Max(1, bottom - top));
                            _dsSlotRectReady = true;
                            _dsSlotVisible = !mv.Success || mv.Groups[1].Value == "true";
                            ApplyDeepSeekSlot();
                        }
                    }

                    if (!string.IsNullOrEmpty(msg) && msg.IndexOf("\"modal\"", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        // 页面弹窗出现时，如果窗口在托盘/后台，先把它拉到前台，
                        // 否则用户只会看到任务栏闪烁或干脆什么都看不到。
                        try { BeginInvoke(new Action(ShowFromTray)); } catch { ShowFromTray(); }
                    }
                    if (!string.IsNullOrEmpty(msg) && Regex.IsMatch(msg, "\"type\"\\s*:\\s*\"deepseek\""))
                    {
                        SelectTab(true);
                        _deepseek.Focus();
                    }
                    if (!string.IsNullOrEmpty(msg) && Regex.IsMatch(msg, "\"type\"\\s*:\\s*\"service-stop\""))
                    {
                        try { BeginInvoke(new Action(StopServiceFromPage)); }
                        catch { StopServiceFromPage(); }
                    }
                }
                catch { }
            };
            _deepseek.CoreWebView2.PermissionRequested += delegate (object sender, CoreWebView2PermissionRequestedEventArgs e)
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead ||
                    e.PermissionKind == CoreWebView2PermissionKind.Notifications)
                    e.State = CoreWebView2PermissionState.Allow;
            };
            _dashboard.CoreWebView2.NavigationCompleted += async delegate (object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                // 页面加载完再显示 WebView，启动时先让 WinForms 的加载提示可见；
                // 同时主动读取页面主题，避免“网页浅色、标题栏深色”的启动瞬间不同步。
                try
                {
                    string theme = await _dashboard.CoreWebView2.ExecuteScriptAsync("document.documentElement.dataset.theme || ''");
                    theme = (theme ?? "").Trim().Trim('"');
                    if (theme == "light" || theme == "dark") ApplyTheme(theme == "light");
                }
                catch { }
                if (_serviceStoppedByUser)
                {
                    ShowStoppedOverlay("服务已停止\n\nQQ 机器人已下线，点击下方按钮重新上线");
                    return;
                }
                _webReady = true;
                if (_loading != null) _loading.Visible = false;
                HideStartButton();
                SelectTab(_showDeepSeek);
                RequestDeepSeekSync();
            };

            _dashboard.CoreWebView2.Navigate("http://127.0.0.1:" + _serverPort + "/");
            HostLog.Write("dashboard navigate " + _serverPort);
            _deepseek.CoreWebView2.Navigate("https://chat.deepseek.com");
            HostLog.Write("deepseek navigate");
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            HostLog.Write("form closing reason=" + e.CloseReason + " reallyExit=" + _reallyExit
                + " serviceRunning=" + _serviceRunning + " stoppedByUser=" + _serviceStoppedByUser);
            // 服务还在跑：点右上角 X 收进托盘，QQ 机器人继续在后台运行；
            // 服务已经停止：没有后台任务了，点 X 直接退出，不再驻留托盘。
            if (!_reallyExit && e.CloseReason == CloseReason.UserClosing)
            {
                if (_serviceRunning && !_serviceStoppedByUser)
                {
                    e.Cancel = true;
                    HideToTray();
                    return;
                }
                _reallyExit = true;
            }
            try { if (_tray != null) { _tray.Visible = false; _tray.Dispose(); _tray = null; } } catch { }
            try { if (_trayMenu != null) { _trayMenu.Dispose(); _trayMenu = null; } } catch { }
            try { _dashboard.Dispose(); } catch { }
            try { _deepseek.Dispose(); } catch { }
            if (!_startedServer) return;
            if (_serverDirect)
            {
                // 直启模式：宿主就是服务进程的父进程，直接结束，避免再跑一遍
                // launcher -Stop 时把下一次启动的服务误杀。
                try { if (_serverProcess != null && !_serverProcess.HasExited) _serverProcess.Kill(); } catch { }
                return;
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + _launcher + "\" -Stop";
                psi.WorkingDirectory = _root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(10000);
                }
            }
            catch { }
            try { if (_serverProcess != null && !_serverProcess.HasExited) _serverProcess.Kill(); } catch { }
        }
    }
}
