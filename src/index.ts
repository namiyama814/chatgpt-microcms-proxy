import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { authHandler } from "./auth";
import { proxyMcpRequest } from "./proxy";
import type { Env } from "./types";

function canonicalOrigin(env: Env): string {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a path.");
  return origin.origin;
}

function providerOptions(env: Env): OAuthProviderOptions<Env> {
  const origin = canonicalOrigin(env);
  return {
    apiRoute: "/mcp",
    apiHandler: { fetch: proxyMcpRequest },
    // Authorization UI must be invoked by OAuthProvider so it receives the
    // request-scoped OAUTH_PROVIDER helper used to parse and complete grants.
    defaultHandler: { fetch: authHandler },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    // ChatGPT's CIMD advertises private_key_jwt. workers-oauth-provider's
    // CIMD flow currently accepts public ("none") clients only, so advertise
    // DCR instead and let ChatGPT register a compatible client.
    clientIdMetadataDocumentEnabled: false,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    scopesSupported: ["mcp:access"],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ["mcp:access"],
      bearer_methods_supported: ["header"],
      resource_name: "microCMS MCP Proxy",
    },
  };
}

const app = new Hono<{ Bindings: Env }>();

const oauthProvider = (env: Env) => new OAuthProvider<Env>(providerOptions(env));

// Hono remains the Worker entrypoint; OAuthProvider is the single dispatcher
// for protected MCP routes, OAuth metadata/endpoints, and auth UI callbacks.
app.all("*", (c) => oauthProvider(c.env).fetch(c.req.raw, c.env, c.executionCtx as unknown as Parameters<OAuthProvider<Env>["fetch"]>[2]));

app.onError(() => new Response("Service configuration error.", { status: 500 }));

export default app;
