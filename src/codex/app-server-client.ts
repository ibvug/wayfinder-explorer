import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type { InitializeParams } from "../../schemas/codex-app-server/InitializeParams.ts";
import type { InitializeResponse } from "../../schemas/codex-app-server/InitializeResponse.ts";
import type { RequestId } from "../../schemas/codex-app-server/RequestId.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_DIAGNOSTICS = 8_000;

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: RequestId;
}

export type AppServerInbound =
  | { kind: "notification"; message: AppServerNotification }
  | { kind: "request"; message: AppServerRequest };

export type AppServerLifecycleEvent =
  | { type: "ready"; initialize: InitializeResponse }
  | { type: "protocol_error"; error: Error }
  | { type: "closed"; expected: boolean; error: Error };

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
  clientVersion?: string;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

/** A restartable deep client for the stable `codex app-server` stdio transport. */
export class CodexAppServerClient {
  #options: AppServerClientOptions;
  #child?: ChildProcessWithoutNullStreams;
  #reader?: ReadlineInterface;
  #nextRequestId = 1;
  #pending = new Map<RequestId, PendingRequest>();
  #inboundListeners = new Set<(event: AppServerInbound) => void>();
  #lifecycleListeners = new Set<(event: AppServerLifecycleEvent) => void>();
  #startPromise?: Promise<InitializeResponse>;
  #initialize?: InitializeResponse;
  #expectedClose = false;
  #stderrDiagnostics = "";

  constructor(options: AppServerClientOptions = {}) {
    this.#options = options;
  }

  get ready(): boolean {
    return Boolean(this.#child && this.#initialize);
  }

  get diagnostics(): string {
    return this.#stderrDiagnostics;
  }

  subscribe(listener: (event: AppServerInbound) => void): () => void {
    this.#inboundListeners.add(listener);
    return () => this.#inboundListeners.delete(listener);
  }

  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.#lifecycleListeners.add(listener);
    return () => this.#lifecycleListeners.delete(listener);
  }

  async start(): Promise<InitializeResponse> {
    if (this.#initialize && this.#child) {
      return this.#initialize;
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#startPromise = this.#startProcess();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    const child = this.#child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new AppServerUnavailableError("Codex app-server is not running.");
    }

    const id = this.#nextRequestId++;
    const timeoutMs = this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerUnavailableError(`Codex request ${method} timed out.`));
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timeout,
      });

      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (!error) {
            return;
          }
          const pending = this.#pending.get(id);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timeout);
          this.#pending.delete(id);
          pending.reject(new AppServerUnavailableError(`Could not send Codex request ${method}.`, { cause: error }));
        });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(new AppServerUnavailableError(`Could not send Codex request ${method}.`, { cause: error }));
      }
    });
  }

  respond(id: RequestId, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string, data?: unknown): void {
    this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  async close(): Promise<void> {
    this.#expectedClose = true;
    const child = this.#child;
    if (!child) {
      return;
    }
    child.stdin.end();
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        timeout.unref();
      }),
    ]);
    if (this.#child === child) {
      this.#settleClosed(child, new AppServerUnavailableError("Codex app-server was closed."));
    }
  }

  async #startProcess(): Promise<InitializeResponse> {
    this.#expectedClose = false;
    this.#stderrDiagnostics = "";
    const child = this.#options.spawnProcess
      ? this.#options.spawnProcess()
      : spawn(this.#options.command ?? "codex", this.#options.args ?? ["app-server"], {
          cwd: this.#options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.#child = child;
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on("line", (line) => this.#receiveLine(child, line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrDiagnostics = `${this.#stderrDiagnostics}${chunk}`.slice(-MAX_STDERR_DIAGNOSTICS);
    });
    child.once("error", (error) => this.#settleClosed(child, error));
    child.once("close", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#settleClosed(child, new AppServerUnavailableError(`Codex app-server exited with ${detail}.`));
    });

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "wayfinder_explorer",
        title: "Wayfinder Explorer",
        version: this.#options.clientVersion ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    };

    try {
      const initialized = await this.request<InitializeResponse>("initialize", initializeParams);
      if (this.#child !== child) {
        throw new AppServerUnavailableError("Codex app-server closed during initialization.");
      }
      this.#initialize = initialized;
      this.#write({ method: "initialized" });
      this.#emitLifecycle({ type: "ready", initialize: initialized });
      return initialized;
    } catch (error) {
      if (this.#child === child && !child.killed) {
        child.kill("SIGTERM");
      }
      throw error;
    }
  }

  #receiveLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.#child !== child || !line.trim()) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (cause) {
      this.#protocolFailure(child, new AppServerProtocolError("Codex app-server emitted malformed JSON.", { cause }));
      return;
    }
    if (!isRecord(decoded)) {
      this.#protocolFailure(child, new AppServerProtocolError("Codex app-server emitted a non-object message."));
      return;
    }

    if (isRequestId(decoded.id) && ("result" in decoded || "error" in decoded) && typeof decoded.method !== "string") {
      this.#resolveResponse(decoded as unknown as RpcResponse);
      return;
    }
    if (typeof decoded.method === "string" && isRequestId(decoded.id)) {
      this.#emitInbound({
        kind: "request",
        message: { method: decoded.method, id: decoded.id, params: decoded.params },
      });
      return;
    }
    if (typeof decoded.method === "string") {
      this.#emitInbound({
        kind: "notification",
        message: { method: decoded.method, params: decoded.params },
      });
      return;
    }
    this.#protocolFailure(child, new AppServerProtocolError("Codex app-server emitted an unknown message shape."));
  }

  #resolveResponse(response: RpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(new AppServerRpcError(
        pending.method,
        response.error.code ?? -32_603,
        response.error.message ?? "Unknown Codex app-server error.",
        response.error.data,
      ));
      return;
    }
    pending.resolve(response.result);
  }

  #protocolFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.#emitLifecycle({ type: "protocol_error", error });
    this.#settleClosed(child, error);
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  #settleClosed(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) {
      return;
    }
    this.#reader?.close();
    this.#reader = undefined;
    this.#child = undefined;
    this.#initialize = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#emitLifecycle({ type: "closed", expected: this.#expectedClose, error });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new AppServerUnavailableError("Codex app-server is not running.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #emitInbound(event: AppServerInbound): void {
    for (const listener of this.#inboundListeners) {
      try {
        listener(event);
      } catch {
        // One integration listener must not break protocol dispatch for others.
      }
    }
  }

  #emitLifecycle(event: AppServerLifecycleEvent): void {
    for (const listener of this.#lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Lifecycle observers are isolated from the transport.
      }
    }
  }
}

export class AppServerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerUnavailableError";
  }
}

export class AppServerProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed (${code}): ${message}`);
    this.name = "AppServerRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}
