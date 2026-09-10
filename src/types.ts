import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  ALLOWED_GITHUB_USERNAME: string;
  COOKIE_ENCRYPTION_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MICROCMS_API_KEY: string;
  MICROCMS_SERVICE_ID: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Canonical public Worker origin, for example https://example.workers.dev. */
  PUBLIC_ORIGIN: string;
}
