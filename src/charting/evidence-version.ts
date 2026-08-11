import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const MAX_EVIDENCE_ENTRIES = 50_000;
const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;

export interface EvidenceVersionSnapshot {
  paths: string[];
  version: string;
}

export interface CaptureEvidenceVersionOptions {
  ignoreAbsolutePaths?: string[];
}

/**
 * Produces an Explorer-owned version for the local evidence named by a draft.
 * Paths are stored relative to the campaign root and symlinks are not followed.
 */
export async function captureEvidenceVersion(
  campaignRoot: string,
  evidencePaths: string[],
  evidenceRefs: string[],
  options: CaptureEvidenceVersionOptions = {},
): Promise<EvidenceVersionSnapshot> {
  const root = path.resolve(campaignRoot);
  const normalizedPaths = [...new Set(evidencePaths.map((candidate) =>
    normalizeEvidencePath(root, candidate)))].sort((left, right) => left.localeCompare(right, "en"));
  const ignored = (options.ignoreAbsolutePaths ?? [])
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isWithin(root, candidate));
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;

  for (const reference of [...new Set(evidenceRefs)].sort((left, right) => left.localeCompare(right, "en"))) {
    hash.update("reference\0");
    hash.update(reference);
    hash.update("\0");
  }

  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    if (ignored.some((candidate) => absolutePath === candidate || absolutePath.startsWith(`${candidate}${path.sep}`))) {
      return;
    }
    entries += 1;
    if (entries > MAX_EVIDENCE_ENTRIES) {
      throw new EvidenceVersionError("取证范围包含过多文件，无法形成可复核的证据版本。");
    }
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        hash.update("missing\0");
        hash.update(relativePath);
        hash.update("\0");
        return;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(await readlink(absolutePath));
      hash.update("\0");
      return;
    }
    if (metadata.isDirectory()) {
      hash.update("directory\0");
      hash.update(relativePath);
      hash.update("\0");
      const names = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right, "en"));
      for (const name of names) {
        if (name === ".git") {
          continue;
        }
        const childRelative = relativePath === "." ? name : `${relativePath}/${name}`;
        await visit(path.join(absolutePath, name), childRelative);
      }
      return;
    }
    if (!metadata.isFile()) {
      hash.update("other\0");
      hash.update(relativePath);
      hash.update("\0");
      return;
    }
    bytes += metadata.size;
    if (bytes > MAX_EVIDENCE_BYTES) {
      throw new EvidenceVersionError("取证范围包含过多内容，无法形成可复核的证据版本。");
    }
    hash.update("file\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(absolutePath));
    hash.update("\0");
  };

  for (const relativePath of normalizedPaths) {
    await visit(path.resolve(root, relativePath), relativePath);
  }
  return { paths: normalizedPaths, version: `sha256:${hash.digest("hex")}` };
}

export class EvidenceVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceVersionError";
  }
}

function normalizeEvidencePath(root: string, candidate: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new EvidenceVersionError("证据路径不能为空。");
  }
  const absolute = path.resolve(root, trimmed);
  if (!isWithin(root, absolute)) {
    throw new EvidenceVersionError("当前版本只能校验目标项目范围内的证据路径。");
  }
  const relative = path.relative(root, absolute);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
