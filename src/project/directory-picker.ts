import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DirectoryPickerCommandOptions {
  maxBuffer: number;
  timeout: number;
}

type DirectoryPickerCommandRunner = (
  executable: string,
  arguments_: string[],
  options: DirectoryPickerCommandOptions,
) => Promise<string>;

interface SystemDirectoryPickerOptions {
  platform?: NodeJS.Platform;
  runCommand?: DirectoryPickerCommandRunner;
}

interface DirectoryPickerCommand {
  executable: string;
  arguments_: string[];
  options: DirectoryPickerCommandOptions;
  failureMessage: string;
}

const runDirectoryPickerCommand: DirectoryPickerCommandRunner = async (
  executable,
  arguments_,
  options,
) => {
  const result = await execFileAsync(executable, arguments_, {
    ...options,
    encoding: "utf8",
  });
  return result.stdout;
};

export type DirectoryPickerPurpose = "create-parent" | "add-project" | "relink-project";

export interface DirectoryPicker {
  selectDirectory(purpose: DirectoryPickerPurpose): Promise<string | undefined>;
}

const PROMPTS: Record<DirectoryPickerPurpose, string> = {
  "create-parent": "选择新 Wayfinder 项目的保存位置",
  "add-project": "选择已有 Wayfinder 项目文件夹",
  "relink-project": "选择项目移动后的新文件夹",
};

/** Opens the operating system's native folder chooser without exposing filesystem access to the browser. */
export class SystemDirectoryPicker implements DirectoryPicker {
  readonly #platform: NodeJS.Platform;
  readonly #runCommand: DirectoryPickerCommandRunner;

  constructor(options: SystemDirectoryPickerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runCommand = options.runCommand ?? runDirectoryPickerCommand;
  }

  async selectDirectory(purpose: DirectoryPickerPurpose): Promise<string | undefined> {
    const prompt = PROMPTS[purpose];
    const command = directoryPickerCommand(this.#platform, prompt);
    let stdout: string;
    try {
      stdout = await this.#runCommand(
        command.executable,
        command.arguments_,
        command.options,
      );
    } catch (cause) {
      throw new DirectoryPickerError(503, command.failureMessage, cause);
    }
    const selected = stdout.trim();
    if (!selected) {
      return undefined;
    }
    const root = path.resolve(selected);
    const metadata = await stat(root).catch((cause) => {
      throw new DirectoryPickerError(404, "选择的文件夹已经不存在。", cause);
    });
    if (!metadata.isDirectory()) {
      throw new DirectoryPickerError(400, "选择的路径不是文件夹。");
    }
    return root;
  }
}

function directoryPickerCommand(
  platform: NodeJS.Platform,
  prompt: string,
): DirectoryPickerCommand {
  if (platform === "darwin") {
    const script = [
      "try",
      `set selectedFolder to choose folder with prompt \"${prompt}\"`,
      "return POSIX path of selectedFolder",
      "on error number -128",
      'return ""',
      "end try",
    ].join("\n");
    return {
      executable: "/usr/bin/osascript",
      arguments_: ["-e", script],
      options: {
        maxBuffer: 16_384,
        timeout: 10 * 60_000,
      },
      failureMessage: "没有成功打开 macOS 文件夹选择器，请手动输入路径。",
    };
  }
  if (platform === "win32") {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const executable = windowsRoot
      ? path.win32.join(
        windowsRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
      : "powershell.exe";
    const script = windowsDirectoryPickerScript(prompt);
    return {
      executable,
      arguments_: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      options: {
        maxBuffer: 16_384,
        timeout: 10 * 60_000,
      },
      failureMessage: "没有成功打开 Windows 文件夹选择器，请手动输入路径。",
    };
  }
  throw new DirectoryPickerError(
    501,
    "当前平台尚未接入文件夹选择器，请手动输入绝对路径。",
  );
}

function windowsDirectoryPickerScript(prompt: string): string {
  const escapedPrompt = prompt.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Windows.Forms;",
    "",
    "public sealed class WayfinderOwnerWindow : IWin32Window {",
    "  private readonly IntPtr handle;",
    "",
    "  public WayfinderOwnerWindow(IntPtr handle) {",
    "    this.handle = handle;",
    "  }",
    "",
    "  public IntPtr Handle {",
    "    get { return this.handle; }",
    "  }",
    "}",
    "",
    "public static class WayfinderDirectoryPicker {",
    "  private static readonly IntPtr HwndTopmost = new IntPtr(-1);",
    "  private const uint SwpNoSize = 0x0001;",
    "  private const uint SwpNoMove = 0x0002;",
    "  private const uint SwpShowWindow = 0x0040;",
    "",
    "  [DllImport(\"user32.dll\")] private static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] private static extern IntPtr GetLastActivePopup(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(IntPtr hWnd);",
    "  [DllImport(\"user32.dll\")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);",
    "",
    "  public static string Select(string description) {",
    "    Application.EnableVisualStyles();",
    "    using (var dialog = new FolderBrowserDialog()) {",
    "      dialog.Description = description;",
    "      dialog.ShowNewFolderButton = true;",
    "      IntPtr ownerHandle = GetForegroundWindow();",
    "      if (ownerHandle == IntPtr.Zero) {",
    "        return ShowDialog(dialog, null, IntPtr.Zero);",
    "      }",
    "      return ShowDialog(dialog, new WayfinderOwnerWindow(ownerHandle), ownerHandle);",
    "    }",
    "  }",
    "",
    "  private static string ShowDialog(FolderBrowserDialog dialog, IWin32Window owner, IntPtr ownerHandle) {",
    "    using (var foregroundTimer = new Timer()) {",
    "      int attempts = 0;",
    "      foregroundTimer.Interval = 100;",
    "      foregroundTimer.Tick += delegate {",
    "        attempts += 1;",
    "        IntPtr popup = ownerHandle == IntPtr.Zero",
    "          ? GetForegroundWindow()",
    "          : GetLastActivePopup(ownerHandle);",
    "        if (popup != IntPtr.Zero && popup != ownerHandle) {",
    "          SetWindowPos(popup, HwndTopmost, 0, 0, 0, 0, SwpNoSize | SwpNoMove | SwpShowWindow);",
    "          SetForegroundWindow(popup);",
    "        }",
    "        if (attempts >= 10) {",
    "          foregroundTimer.Stop();",
    "        }",
    "      };",
    "      foregroundTimer.Start();",
    "      DialogResult result = owner == null ? dialog.ShowDialog() : dialog.ShowDialog(owner);",
    "      foregroundTimer.Stop();",
    "      return result == DialogResult.OK ? dialog.SelectedPath : string.Empty;",
    "    }",
    "  }",
    "}",
    "'@",
    `[Console]::Out.Write([WayfinderDirectoryPicker]::Select('${escapedPrompt}'))`,
  ].join("\r\n");
}

export class DirectoryPickerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DirectoryPickerError";
    this.statusCode = statusCode;
  }
}
