import { randomUUID } from "node:crypto";
import path from "node:path";

import type { RequestId } from "../../schemas/codex-app-server/RequestId.ts";

export type AgentApprovalDecision = "approve" | "decline";

export interface AgentApprovalRequestView {
  id: string;
  threadId: string;
  kind: "command" | "file_change" | "permissions";
  summary: string;
  details: string[];
  reason?: string;
  blockedReason?: string;
  createdAt: string;
}

export interface ApprovalTransport {
  respond(id: RequestId, result: unknown): void;
  respondError(id: RequestId, code: number, message: string, data?: unknown): void;
}

interface ApprovalRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

interface PendingApproval {
  request: ApprovalRequest;
  view: AgentApprovalRequestView;
}

export class ApprovalBroker {
  #transport: ApprovalTransport;
  #now: () => Date;
  #pending = new Map<string, PendingApproval>();
  #campaignRoot?: string;

  constructor(
    transport: ApprovalTransport,
    now: () => Date,
    options: { campaignRoot?: string } = {},
  ) {
    this.#transport = transport;
    this.#now = now;
    this.#campaignRoot = options.campaignRoot ? path.resolve(options.campaignRoot) : undefined;
  }

  supports(method: string): boolean {
    return method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval";
  }

  capture(request: ApprovalRequest, fileChangePaths: string[] = []): AgentApprovalRequestView {
    const threadId = requestThreadId(request.params);
    if (!threadId) {
      throw new Error("Agent approval request is missing its thread id.");
    }
    const params = isRecord(request.params) ? request.params : {};
    const kind = approvalKind(request.method);
    const details = approvalDetails(request.method, params, fileChangePaths);
    const blockedReason = this.#campaignRoot
      ? protectedMapWriteReason(request.method, params, fileChangePaths, this.#campaignRoot)
      : undefined;
    const view: AgentApprovalRequestView = {
      id: `approval-${randomUUID()}`,
      threadId,
      kind,
      summary: approvalSummary(kind, details),
      details,
      reason: typeof params.reason === "string" && params.reason.trim()
        ? params.reason.trim()
        : undefined,
      blockedReason,
      createdAt: this.#now().toISOString(),
    };
    this.#pending.set(view.id, { request, view });
    return structuredClone(view);
  }

  get(id: string): AgentApprovalRequestView | undefined {
    const pending = this.#pending.get(id);
    return pending ? structuredClone(pending.view) : undefined;
  }

  getForThread(threadId: string): AgentApprovalRequestView | undefined {
    const pending = [...this.#pending.values()].find(({ view }) => view.threadId === threadId);
    return pending ? structuredClone(pending.view) : undefined;
  }

  resolve(id: string, decision: AgentApprovalDecision): AgentApprovalRequestView {
    const pending = this.#pending.get(id);
    if (!pending) {
      throw new Error("这个工具审批请求已经失效。");
    }
    const { request, view } = pending;
    const effectiveDecision = decision === "approve" && view.blockedReason ? "decline" : decision;
    if (request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval") {
      this.#transport.respond(request.id, {
        decision: effectiveDecision === "approve" ? "accept" : "decline",
      });
    } else if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      this.#transport.respond(request.id, {
        decision: effectiveDecision === "approve"
          ? "approved"
          : { denied: { rejection: view.blockedReason ?? "用户拒绝了这次 Agent 工具请求。" } },
      });
    } else if (effectiveDecision === "approve") {
      const params = isRecord(request.params) && isRecord(request.params.permissions)
        ? request.params.permissions
        : {};
      this.#transport.respond(request.id, {
        permissions: {
          ...(params.network ? { network: params.network } : {}),
          ...(params.fileSystem ? { fileSystem: params.fileSystem } : {}),
        },
        scope: "turn",
      });
    } else {
      this.#transport.respondError(
        request.id,
        -32_000,
        view.blockedReason ?? "用户拒绝了这次权限请求。",
      );
    }
    this.#pending.delete(id);
    return structuredClone(view);
  }

  declineAll(): void {
    for (const id of [...this.#pending.keys()]) {
      try {
        this.resolve(id, "decline");
      } catch {
        this.#pending.delete(id);
      }
    }
  }
}

function protectedMapWriteReason(
  method: string,
  params: Record<string, unknown>,
  fileChangePaths: string[],
  campaignRoot: string,
): string | undefined {
  const cwd = typeof params.cwd === "string" ? params.cwd : campaignRoot;
  if (method === "applyPatchApproval") {
    const paths = isRecord(params.fileChanges) ? Object.keys(params.fileChanges) : [];
    if (paths.some((candidate) => isCanonicalPath(candidate, cwd, campaignRoot))) {
      return "规范 map.md、issues/ 与 Explorer 历史只能通过地图预览和领域确认修改。";
    }
  }
  if (method === "item/fileChange/requestApproval") {
    if (!fileChangePaths.length) {
      return "运行时没有提供文件变化目标，Explorer 无法证明它不会绕过规范地图确认。";
    }
    if (fileChangePaths.some((candidate) => isCanonicalPath(candidate, cwd, campaignRoot))) {
      return "规范 map.md、issues/ 与 Explorer 历史只能通过地图预览和领域确认修改。";
    }
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : undefined;
    if (grantRoot && pathContains(grantRoot, campaignRoot)) {
      return "不能向普通 Agent 工具授予覆盖整个地图项目的持续写权限。";
    }
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = isRecord(params.permissions) ? params.permissions : {};
    if (fileSystemPermissionCoversCanonical(permissions.fileSystem, campaignRoot)) {
      return "不能向普通 Agent 工具授予覆盖规范地图文件的写权限。";
    }
  }
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const command = method === "execCommandApproval" && Array.isArray(params.command)
      ? params.command.map(String).join(" ")
      : typeof params.command === "string" ? params.command : "";
    if (commandCanWriteCanonical(command)) {
      return "普通命令不能直接修改规范地图文件；请通过 Explorer 的预览与确认入口。";
    }
  }
  return undefined;
}

function fileSystemPermissionCoversCanonical(value: unknown, campaignRoot: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const writes = Array.isArray(value.write) ? value.write.filter((item): item is string => typeof item === "string") : [];
  if (writes.some((candidate) => pathContains(candidate, campaignRoot))) {
    return true;
  }
  if (!Array.isArray(value.entries)) {
    return false;
  }
  return value.entries.some((entry) => {
    if (!isRecord(entry) || entry.access !== "write" || !isRecord(entry.path)) {
      return false;
    }
    if (entry.path.type === "path" && typeof entry.path.path === "string") {
      return pathContains(entry.path.path, campaignRoot);
    }
    if (entry.path.type === "special") {
      return true;
    }
    if (entry.path.type === "glob_pattern" && typeof entry.path.pattern === "string") {
      const pattern = entry.path.pattern;
      return /(?:^|\/)(?:map\.md|issues|history)(?:\/|$)/.test(pattern) ||
        pattern === "*" || pattern === "**" || pattern.includes("**/*");
    }
    return false;
  });
}

function commandCanWriteCanonical(command: string): boolean {
  if (!/(?:^|[\s'"/])(?:map\.md|issues\/|history\/)/.test(command)) {
    return false;
  }
  return /(?:>|>>|\b(?:rm|mv|cp|install|tee|touch|mkdir|sed\s+-i|perl\s+-i|python\w*|node|ruby|apply_patch)\b)/.test(command);
}

function isCanonicalPath(candidate: string, cwd: string, campaignRoot: string): boolean {
  const absolute = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate));
  const mapPath = path.join(campaignRoot, "map.md");
  return absolute === mapPath ||
    isInside(path.join(campaignRoot, "issues"), absolute) ||
    isInside(path.join(campaignRoot, "history"), absolute);
}

function pathContains(candidateRoot: string, campaignRoot: string): boolean {
  const resolved = path.resolve(candidateRoot);
  return resolved === campaignRoot || isInside(resolved, campaignRoot);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function requestThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.conversationId === "string"
      ? params.conversationId
      : undefined;
}

function approvalKind(method: string): AgentApprovalRequestView["kind"] {
  if (method === "item/permissions/requestApproval") {
    return "permissions";
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "file_change";
  }
  return "command";
}

function approvalDetails(
  method: string,
  params: Record<string, unknown>,
  fileChangePaths: string[],
): string[] {
  if (method === "item/commandExecution/requestApproval") {
    return typeof params.command === "string" ? [params.command] : [];
  }
  if (method === "execCommandApproval") {
    return Array.isArray(params.command) ? [params.command.map(String).join(" ")] : [];
  }
  if (method === "applyPatchApproval" && isRecord(params.fileChanges)) {
    return Object.keys(params.fileChanges).sort();
  }
  if (method === "item/fileChange/requestApproval") {
    return fileChangePaths.length ? [...fileChangePaths].sort() : ["Agent 请求写入文件（等待运行时提供具体变更）"];
  }
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  return Object.entries(permissions)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => `额外 ${key} 权限`);
}

function approvalSummary(kind: AgentApprovalRequestView["kind"], details: string[]): string {
  if (kind === "command") {
    return details[0] ? `运行命令：${details[0]}` : "运行 Agent 请求的命令";
  }
  if (kind === "file_change") {
    return `写入 ${details.length} 个文件目标`;
  }
  return "授予本轮额外权限";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
