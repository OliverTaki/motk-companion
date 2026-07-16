// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class MotkCompanionApp
{
    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            Application.Run(new ControlCenter(Array.Exists(args, x => x == "--first-run")));
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "MOTK Companion", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

internal sealed class ControlCenter : Form
{
    private static readonly Color Back = Color.FromArgb(19, 22, 28);
    private static readonly Color Surface = Color.FromArgb(30, 35, 44);
    private static readonly Color SurfaceHover = Color.FromArgb(42, 49, 61);
    private static readonly Color TextColor = Color.FromArgb(242, 245, 248);
    private static readonly Color Muted = Color.FromArgb(151, 161, 174);
    private static readonly Color Accent = Color.FromArgb(255, 190, 54);
    private static readonly Color Ready = Color.FromArgb(73, 209, 139);
    private static readonly Color Offline = Color.FromArgb(239, 99, 99);
    private const string Origin = "https://motk-public-site.pages.dev";
    private const string ShootUrl = Origin + "/apps/shoot/index.html";
    private const string MediaToolsUrl = Origin + "/apps/media-tools/";

    private readonly string installDir;
    private readonly string internalDir;
    private readonly string dataDir;
    private readonly string configPath;
    private readonly string tokenPath;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Panel main = new Panel();
    private readonly Panel settings = new Panel();
    private readonly Label statusDot = new Label();
    private readonly Label statusText = new Label();
    private readonly TextBox folderBox = new TextBox();
    private readonly ComboBox cameraBox = new ComboBox();
    private readonly TextBox sdkBox = new TextBox();
    private readonly Button sdkBrowse = new Button();
    private readonly Button backButton = new Button();
    private Button pairButton = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private bool firstRun;

    internal ControlCenter(bool isFirstRun)
    {
        firstRun = isFirstRun;
        installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        internalDir = Path.Combine(installDir, "_internal");
        dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MOTK", "Companion");
        configPath = Path.Combine(dataDir, "companion.json");
        tokenPath = Path.Combine(dataDir, "config", "pairing-token.json");
        if (!File.Exists(configPath)) throw new FileNotFoundException("MOTK Companion is incomplete. Install it again.", configPath);

        Text = "MOTK Companion";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(720, 500);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        BackColor = Back;
        ForeColor = TextColor;
        Font = new Font("Segoe UI", 10f);
        BuildMain();
        BuildSettings();
        Controls.Add(main);
        Controls.Add(settings);

        timer.Interval = 1200;
        timer.Tick += delegate { RefreshStatus(); };
        Shown += delegate
        {
            ShowSettings(firstRun);
            if (!firstRun) StartCompanion();
            RefreshStatus();
            timer.Start();
        };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); };
    }

    private void BuildMain()
    {
        main.Dock = DockStyle.Fill;
        main.BackColor = Back;
        main.Controls.Add(MakeLabel("MOTK  COMPANION", new Rectangle(35, 28, 400, 42), 18f, true, TextColor));

        statusDot.Text = "●";
        statusDot.Font = new Font("Segoe UI", 16f);
        statusDot.TextAlign = ContentAlignment.MiddleRight;
        statusDot.SetBounds(530, 28, 30, 36);
        main.Controls.Add(statusDot);
        statusText.Font = new Font("Segoe UI Semibold", 10f);
        statusText.TextAlign = ContentAlignment.MiddleLeft;
        statusText.SetBounds(565, 29, 120, 34);
        main.Controls.Add(statusText);

        main.Controls.Add(MakeTile("\uE722", "SHOOT", 35, delegate { OpenShoot(); }));
        main.Controls.Add(MakeTile("\uE8B7", "FILES", 385, delegate { OpenFiles(); }));

        Button settingsButton = MakeButton("\u2699  SETTINGS", 35, 420, 145, 42);
        settingsButton.Click += delegate { ShowSettings(true); };
        main.Controls.Add(settingsButton);
        Button mediaTools = MakeButton("\u2692  MEDIA TOOLS", 195, 420, 165, 42);
        mediaTools.Click += delegate { OpenUrl(MediaToolsUrl); };
        main.Controls.Add(mediaTools);
    }

    private void BuildSettings()
    {
        settings.Dock = DockStyle.Fill;
        settings.BackColor = Back;
        settings.Visible = false;
        backButton.Text = "\uE72B";
        backButton.Font = new Font("Segoe MDL2 Assets", 14f);
        StyleButton(backButton, 25, 22, 48, 42);
        backButton.Click += delegate { if (!firstRun) ShowSettings(false); };
        settings.Controls.Add(backButton);
        settings.Controls.Add(MakeLabel("SETTINGS", new Rectangle(90, 26, 300, 40), 18f, true, TextColor));

        settings.Controls.Add(MakeIcon("\uE8B7", 35, 103));
        StyleTextBox(folderBox, 94, 106, 495);
        folderBox.ReadOnly = true;
        settings.Controls.Add(folderBox);
        Button folderBrowse = MakeButton("\uE8B7", 605, 103, 65, 38, true);
        folderBrowse.Click += delegate
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.SelectedPath = folderBox.Text;
                dialog.ShowNewFolderButton = true;
                if (dialog.ShowDialog(this) == DialogResult.OK) folderBox.Text = dialog.SelectedPath;
            }
        };
        settings.Controls.Add(folderBrowse);

        settings.Controls.Add(MakeIcon("\uE722", 35, 181));
        cameraBox.DropDownStyle = ComboBoxStyle.DropDownList;
        cameraBox.SetBounds(94, 184, 576, 30);
        cameraBox.BackColor = Surface;
        cameraBox.ForeColor = TextColor;
        cameraBox.Items.AddRange(new object[] { "PHONE / WEBCAM", "SIGMA", "CANON / NIKON / SONY", "GPHOTO2" });
        cameraBox.SelectedIndexChanged += delegate { SetSigmaVisibility(); };
        settings.Controls.Add(cameraBox);

        StyleTextBox(sdkBox, 94, 243, 495);
        sdkBox.ReadOnly = true;
        settings.Controls.Add(sdkBox);
        StyleButton(sdkBrowse, 605, 240, 65, 38);
        sdkBrowse.Text = "SDK";
        sdkBrowse.Click += delegate
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Filter = "ZIP files (*.zip)|*.zip";
                if (dialog.ShowDialog(this) == DialogResult.OK) sdkBox.Text = dialog.FileName;
            }
        };
        settings.Controls.Add(sdkBrowse);

        pairButton = MakeButton("\u26D3  PAIR", 94, 315, 140, 44);
        pairButton.Click += delegate
        {
            try
            {
                StartCompanion();
                WaitCompanion(5000);
                string token = ReadToken();
                if (token.Length == 0) throw new InvalidOperationException("Pairing is not ready.");
                Clipboard.SetText(token);
                pairButton.Text = "\u2713  COPIED";
                pairButton.BackColor = Ready;
            }
            catch (Exception error) { ShowError(error); }
        };
        settings.Controls.Add(pairButton);

        Button save = MakeButton("SAVE", 520, 408, 150, 48);
        save.BackColor = Accent;
        save.ForeColor = Color.FromArgb(25, 25, 25);
        save.Click += delegate
        {
            try
            {
                SaveSettings();
                StartCompanion();
                if (!WaitCompanion(6000)) throw new InvalidOperationException("Companion did not start.");
                firstRun = false;
                ShowSettings(false);
            }
            catch (Exception error) { ShowError(error); }
        };
        settings.Controls.Add(save);
    }

    private Panel MakeTile(string iconText, string captionText, int x, Action action)
    {
        var panel = new Panel { BackColor = Surface, Cursor = Cursors.Hand };
        panel.SetBounds(x, 150, 300, 230);
        Label icon = MakeLabel(iconText, new Rectangle(0, 38, 300, 90), 52f, false, Accent, "Segoe MDL2 Assets");
        Label caption = MakeLabel(captionText, new Rectangle(0, 142, 300, 44), 16f, true, TextColor);
        icon.Cursor = caption.Cursor = Cursors.Hand;
        EventHandler click = delegate { try { action(); } catch (Exception error) { ShowError(error); } };
        EventHandler enter = delegate { panel.BackColor = SurfaceHover; };
        EventHandler leave = delegate { panel.BackColor = Surface; };
        foreach (Control control in new Control[] { panel, icon, caption })
        {
            control.Click += click;
            control.MouseEnter += enter;
            control.MouseLeave += leave;
        }
        panel.Controls.Add(icon);
        panel.Controls.Add(caption);
        return panel;
    }

    private static Label MakeLabel(string text, Rectangle bounds, float size, bool semibold, Color color, string family = "Segoe UI")
    {
        var label = new Label { Text = text, ForeColor = color, TextAlign = ContentAlignment.MiddleCenter };
        label.Bounds = bounds;
        label.Font = new Font(semibold ? "Segoe UI Semibold" : family, size);
        return label;
    }

    private static Label MakeIcon(string text, int x, int y)
    {
        Label label = MakeLabel(text, new Rectangle(x, y, 50, 45), 24f, false, Accent, "Segoe MDL2 Assets");
        return label;
    }

    private static Button MakeButton(string text, int x, int y, int width, int height, bool iconFont = false)
    {
        var button = new Button { Text = text };
        StyleButton(button, x, y, width, height);
        button.Font = new Font(iconFont ? "Segoe MDL2 Assets" : "Segoe UI Semibold", iconFont ? 14f : 10f);
        return button;
    }

    private static void StyleButton(Button button, int x, int y, int width, int height)
    {
        button.SetBounds(x, y, width, height);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = Surface;
        button.ForeColor = TextColor;
        button.Cursor = Cursors.Hand;
    }

    private static void StyleTextBox(TextBox box, int x, int y, int width)
    {
        box.SetBounds(x, y, width, 30);
        box.BackColor = Surface;
        box.ForeColor = TextColor;
        box.BorderStyle = BorderStyle.FixedSingle;
    }

    private Dictionary<string, object> ReadJson(string path)
    {
        return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }

    private Dictionary<string, object> ReadConfig() { return ReadJson(configPath); }

    private void LoadSettings()
    {
        Dictionary<string, object> config = ReadConfig();
        string hidden = Path.GetFullPath(Path.Combine(dataDir, "production")).TrimEnd('\\');
        string root = GetString(config, "productionRoot", hidden);
        if (Path.GetFullPath(root).TrimEnd('\\').Equals(hidden, StringComparison.OrdinalIgnoreCase))
            root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "MOTK Companion Files");
        folderBox.Text = root;
        sdkBox.Text = GetString(config, "sigmaSdkZip", "");
        string backend = GetString(config, "cameraBackend", "dummy");
        cameraBox.SelectedIndex = backend == "sigma" ? 1 : backend == "digicam" ? 2 : backend == "gphoto2" ? 3 : 0;
        pairButton.Text = "\u26D3  PAIR";
        pairButton.BackColor = Surface;
        SetSigmaVisibility();
    }

    private void SaveSettings()
    {
        string root = Path.GetFullPath(folderBox.Text).TrimEnd('\\');
        string drive = Path.GetPathRoot(root).TrimEnd('\\');
        if (root.Length < drive.Length + 4 || root.Equals(drive, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Choose a normal folder, not an entire drive.");
        string backend = cameraBox.SelectedIndex == 1 ? "sigma" : cameraBox.SelectedIndex == 2 ? "digicam" : cameraBox.SelectedIndex == 3 ? "gphoto2" : "dummy";
        if (backend == "sigma" && (!File.Exists(sdkBox.Text) || !sdkBox.Text.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Choose the SIGMA SDK ZIP.");
        Directory.CreateDirectory(root);
        Dictionary<string, object> config = ReadConfig();
        File.Copy(configPath, configPath + ".before-setup.bak", true);
        config["allowOrigin"] = Origin;
        config["productionRoot"] = root;
        config["captureInbox"] = Path.Combine(root, ".companion-capture");
        config["cameraBackend"] = backend;
        config["sigmaSdkZip"] = backend == "sigma" ? Path.GetFullPath(sdkBox.Text) : "";
        config["recipesDir"] = Path.Combine(internalDir, "app", "recipes");
        File.WriteAllText(configPath, json.Serialize(config), new UTF8Encoding(false));
    }

    private void ShowSettings(bool visible)
    {
        if (visible) LoadSettings();
        backButton.Visible = !firstRun;
        settings.Visible = visible;
        main.Visible = !visible;
        settings.BringToFront();
    }

    private void SetSigmaVisibility()
    {
        bool visible = cameraBox.SelectedIndex == 1;
        sdkBox.Visible = visible;
        sdkBrowse.Visible = visible;
    }

    private void RefreshStatus()
    {
        bool running = IsRunning();
        statusDot.ForeColor = running ? Ready : Offline;
        statusText.Text = running ? "READY" : "OFFLINE";
        statusText.ForeColor = running ? Ready : Offline;
    }

    private bool IsRunning()
    {
        try
        {
            int port = Convert.ToInt32(ReadConfig()["statusPort"]);
            using (var web = new WebClient())
            {
                web.Headers.Add("Cache-Control", "no-cache");
                string response = web.DownloadString("http://127.0.0.1:" + port + "/status");
                return response.Contains("\"ok\":true") || response.Contains("\"ok\": true");
            }
        }
        catch { return false; }
    }

    private void StartCompanion()
    {
        if (IsRunning()) return;
        string script = Path.Combine(internalDir, "scripts", "motk-companion.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("Companion launcher is missing.", script);
        var start = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -DataDir \"" + dataDir + "\"",
            WorkingDirectory = installDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        Process.Start(start);
    }

    private bool WaitCompanion(int milliseconds)
    {
        Stopwatch wait = Stopwatch.StartNew();
        while (wait.ElapsedMilliseconds < milliseconds)
        {
            if (IsRunning()) return true;
            Application.DoEvents();
            Thread.Sleep(100);
        }
        return false;
    }

    private string ReadToken()
    {
        if (!File.Exists(tokenPath)) return "";
        return GetString(ReadJson(tokenPath), "token", "");
    }

    private void OpenShoot()
    {
        StartCompanion();
        WaitCompanion(5000);
        string token = ReadToken();
        if (token.Length == 0) throw new InvalidOperationException("Pairing is not ready.");
        string fragment = "pair=" + Uri.EscapeDataString(token) + "&agent=" + Uri.EscapeDataString("ws://127.0.0.1:8793");
        OpenUrl(ShootUrl + "#" + fragment);
    }

    private void OpenFiles()
    {
        string root = GetString(ReadConfig(), "productionRoot", "");
        if (root.Length == 0) throw new InvalidOperationException("Choose a folder in Settings.");
        Directory.CreateDirectory(root);
        Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + root + "\"", UseShellExecute = true });
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }

    private static string GetString(Dictionary<string, object> values, string key, string fallback)
    {
        object value;
        return values.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
    }

    private void ShowError(Exception error)
    {
        MessageBox.Show(this, error.Message, "MOTK Companion", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
