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
    defaultHandler: { fetch: () => new Response("Not found.", { status: 404 }) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
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

app.get("/authorize", (c) => authHandler(c.req.raw, c.env));
app.get("/auth/github/callback", (c) => authHandler(c.req.raw, c.env));
app.post("/authorize/consent", (c) => authHandler(c.req.raw, c.env));

app.all("/mcp", (c) => oauthProvider(c.env).fetch(c.req.raw, c.env, c.executionCtx as unknown as Parameters<OAuthProvider<Env>["fetch"]>[2]));
app.get("/.well-known/*", (c) => oauthProvider(c.env).fetch(c.req.raw, c.env, c.executionCtx as unknown as Parameters<OAuthProvider<Env>["fetch"]>[2]));
app.all("/oauth/*", (c) => oauthProvider(c.env).fetch(c.req.raw, c.env, c.executionCtx as unknown as Parameters<OAuthProvider<Env>["fetch"]>[2]));

app.notFound((c) => c.text("Not found.", 404));
app.onError(() => new Response("Service configuration error.", { status: 500 }));

export default app;
