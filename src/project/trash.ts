import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ProjectTrashCommandOptions {
  maxBuffer: number;
  timeout: number;
}

type ProjectTrashCommandRunner = (
  executable: string,
  arguments_: string[],
  options: ProjectTrashCommandOptions,
) => Promise<string>;

interface SystemProjectTrashOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  runCommand?: ProjectTrashCommandRunner;
}

interface ProjectTrashCommand {
  executable: string;
  arguments_: string[];
  options: ProjectTrashCommandOptions;
}

const runProjectTrashCommand: ProjectTrashCommandRunner = async (
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

export interface ProjectTrash {
  moveToTrash(root: string): Promise<void>;
}

/** Moves Explorer-owned project directories to the operating system's recoverable trash. */
export class SystemProjectTrash implements ProjectTrash {
  readonly #platform: NodeJS.Platform;
  readonly #homeDirectory: string;
  readonly #runCommand: ProjectTrashCommandRunner;

  constructor(options: SystemProjectTrashOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#homeDirectory = path.resolve(options.homeDirectory ?? homedir());
    this.#runCommand = options.runCommand ?? runProjectTrashCommand;
  }

  async moveToTrash(input: string): Promise<void> {
    const root = path.resolve(input);
    const metadata = await stat(root).catch((cause) => {
      throw new ProjectTrashError(404, "项目目录已经不存在，无法移入废纸篓。", cause);
    });
    if (!metadata.isDirectory()) {
      throw new ProjectTrashError(400, "项目路径不是文件夹，无法移入废纸篓。");
    }

    if (this.#platform === "darwin") {
      const trashRoot = path.join(this.#homeDirectory, ".Trash");
      await mkdir(trashRoot, { recursive: true, mode: 0o700 }).catch((cause) => {
        throw new ProjectTrashError(503, "无法访问 macOS 废纸篓。", cause);
      });
      const suffix = randomUUID().slice(0, 8);
      const destination = path.join(trashRoot, `${path.basename(root)} — Wayfinder ${suffix}`);
      await rename(root, destination).catch((cause) => {
        throw new ProjectTrashError(503, "没有成功把项目目录移入 macOS 废纸篓。", cause);
      });
      return;
    }

    const command = projectTrashCommand(this.#platform, root);
    try {
      await this.#runCommand(command.executable, command.arguments_, command.options);
    } catch (cause) {
      throw new ProjectTrashError(503, "没有成功把项目目录移入系统废纸篓。", cause);
    }
  }
}

function projectTrashCommand(platform: NodeJS.Platform, root: string): ProjectTrashCommand {
  const options = { maxBuffer: 16_384, timeout: 2 * 60_000 };
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
    const encodedRoot = Buffer.from(root, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      `$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))`,
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(",
      "  $target,",
      "  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,",
      "  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin",
      ")",
    ].join("\r\n");
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
      options,
    };
  }
  if (platform === "linux") {
    return {
      executable: "gio",
      arguments_: ["trash", "--", root],
      options,
    };
  }
  throw new ProjectTrashError(501, "当前平台尚未接入系统废纸篓。");
}

export class ProjectTrashError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectTrashError";
    this.statusCode = statusCode;
  }
}
