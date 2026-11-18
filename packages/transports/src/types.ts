import type { Permission, Principal } from "@themelios/application";
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

export interface RemoteTransportOptions {
  readonly policy: () => Readonly<TransportPolicy>;
  readonly secrets: Secrets;
  readonly authenticate?: Authenticate;
  readonly translate?: Translate;
  readonly operations?: readonly string[];
}

export interface HttpEndpoint {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface GrpcServerOptions extends RemoteTransportOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: { readonly key: CredentialRef; readonly cert: CredentialRef };
}
