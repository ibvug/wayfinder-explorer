import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  async selectDirectory(purpose: DirectoryPickerPurpose): Promise<string | undefined> {
    if (process.platform !== "darwin") {
      throw new DirectoryPickerError(501, "当前只接入了 macOS 文件夹选择器，请暂时手动输入绝对路径。");
    }
    const prompt = PROMPTS[purpose];
    const script = [
      "try",
      `set selectedFolder to choose folder with prompt \"${prompt}\"`,
      "return POSIX path of selectedFolder",
      "on error number -128",
      'return ""',
      "end try",
    ].join("\n");
    let stdout: string;
    try {
      const result = await execFileAsync("/usr/bin/osascript", ["-e", script], {
        encoding: "utf8",
        maxBuffer: 16_384,
        timeout: 10 * 60_000,
      });
      stdout = result.stdout;
    } catch (cause) {
      throw new DirectoryPickerError(503, "没有成功打开 macOS 文件夹选择器，请手动输入路径。", cause);
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

export class DirectoryPickerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DirectoryPickerError";
    this.statusCode = statusCode;
  }
}
