import type { ApplicationApi, Principal, Permission } from './application.js';
import type { CredentialRef, Installation, Secrets } from './runtime.js';

export interface AuthTokenDefinition {
  readonly secret: CredentialRef;
  readonly permissions: readonly Permission[];
}

export interface TransportLimits {
  readonly maxJsonBytes: number;
}

export interface TransportPolicy extends TransportLimits {
  readonly authTokens: Readonly<Record<string, AuthTokenDefinition>>;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}

/** 宿主注入时取代内置静态 bearer 验证；返回已验证的身份。 */
export type Authenticate = (headers: Headers, signal: AbortSignal) => Promise<Principal>;

export interface RemoteTransportOptions {
  /** 每请求调用一次，返回该请求固定的策略快照。 */
  readonly policy: () => Readonly<TransportPolicy>;
  readonly secrets: Secrets;
  readonly authenticate?: Authenticate;
  readonly operations?: readonly string[];
}

export interface HttpEndpoint {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export declare function createHttpHandler<S>(
  api: ApplicationApi<S>, options: RemoteTransportOptions,
): HttpEndpoint;

export declare function createMcpEndpoint<S>(
  api: ApplicationApi<S>, options: RemoteTransportOptions,
): HttpEndpoint;

export declare function serveMcpStdio<S>(
  api: ApplicationApi<S>, options: {
    principal: Principal;
    limits?: () => Readonly<TransportLimits>;
    operations?: readonly string[];
  },
): Promise<{ close(): Promise<void> }>;

export interface GrpcServerOptions extends RemoteTransportOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: { readonly key: CredentialRef; readonly cert: CredentialRef };
}

export declare function startGrpcServer<S>(
  api: ApplicationApi<S>, options: GrpcServerOptions,
): Promise<{ address: string; close(): Promise<void> }>;

/** CLI 负责 init/open 及本次会话关闭；实例占用时报告错误，宿主持有进程 signal handler。 */
export declare function runCli<S>(
  installation: Installation<ApplicationApi<S>, S>,
  argv: readonly string[],
  options: {
    principal: Principal;
    signal?: AbortSignal;
    cwd?: string;
    limits?: () => Readonly<TransportLimits>;
  },
): Promise<number>;
