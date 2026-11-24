import type {
  AgentRefBridge,
  AnyOperation,
  Permission,
  Principal,
} from "@themelios/runtime/operations";
import type { MessageParams } from "@themelios/core";
import type { CredentialRef, Secrets } from "@themelios/runtime";

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

export type Authenticate = (
  headers: Headers,
  signal: AbortSignal,
) => Promise<Principal>;

export type Translate = (
  locale: string,
  key: string,
  params?: MessageParams,
) => string;

export interface McpResourceSpec {
  readonly name: string;
  readonly template: `${string}{ref}`;
  readonly operation: string;
  readonly linksFrom?: readonly string[];
}

export interface RemoteOperationOptions<App = unknown> {
  readonly policy: () => Readonly<TransportPolicy>;
  readonly secrets: Secrets;
  readonly authenticate?: Authenticate;
  readonly translate?: Translate;
  readonly operations: readonly AnyOperation<App>[];
  readonly allowOperations?: readonly string[];
  readonly locale?: () => string | undefined;
  readonly languages?: readonly string[];
}

export interface RemoteTransportOptions<
  App = unknown,
> extends RemoteOperationOptions<App> {
  readonly agentRefs?: (app: App) => AgentRefBridge;
  readonly name?: string;
  readonly resource?: McpResourceSpec;
  readonly enableMcp?: boolean;
}

export interface GrpcListener {
  readonly address: { readonly host: string; readonly port: number };
  readonly tls?: { readonly key: CredentialRef; readonly cert: CredentialRef };
}

export interface McpStdioOptions<App = any> {
  readonly principal: Principal;
  readonly limits?: () => Readonly<TransportLimits>;
  readonly operations: readonly AnyOperation<App>[];
  readonly allowOperations?: readonly string[];
  readonly agentRefs?: (app: App) => AgentRefBridge;
  readonly name?: string;
  readonly resource?: McpResourceSpec;
  readonly translate?: Translate;
  readonly locale?: () => string | undefined;
}

export interface HttpEndpoint {
  fetch(
    request: Request,
    setIdleTimeout?: (seconds: number) => void,
  ): Promise<Response>;
  close(): Promise<void>;
}
