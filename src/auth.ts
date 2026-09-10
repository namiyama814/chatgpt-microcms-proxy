import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";

const STATE_TTL_SECONDS = 600;
const APPROVED_CLIENTS_TTL_SECONDS = 60 * 60 * 24 * 30;

type GitHubState = { oauthUrl: string };
type ConsentState = { oauthUrl: string; username: string };

function html(body: string, status = 200, headers: HeadersInit = {}, cookies: string[] = []): Response {
  const responseHeaders = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>microCMS MCP</title></head><body>${body}</body></html>`, {
    status,
    headers: responseHeaders,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function readCookie(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function digest(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `__Host-${name}=${value}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function expireCookie(name: string): string {
  return secureCookie(name, "", 0);
}

async function stateCookie(name: string, state: string): Promise<string> {
  return secureCookie(name, await digest(state), STATE_TTL_SECONDS);
}

async function stateMatchesCookie(request: Request, cookieName: string, state: string): Promise<boolean> {
  const received = readCookie(request, `__Host-${cookieName}`);
  return received === await digest(state);
}

function githubCallbackUrl(env: Env): string {
  return `${env.PUBLIC_ORIGIN.replace(/\/$/, "")}/auth/github/callback`;
}

function errorRedirect(error: AuthorizationError): Response {
  if (!error.redirectUri) return html("<h1>Invalid authorization request</h1>", 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return redirectResponse(redirect.toString());
}

function redirectResponse(location: string, headers: HeadersInit = {}, cookies: string[] = []): Response {
  const responseHeaders = new Headers({ Location: location, ...headers });
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers: responseHeaders });
}

async function parseOAuthRequest(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return errorRedirect(error);
    return html("<h1>Authorization request could not be processed</h1>", 400);
  }
}

async function fetchGitHubUsername(code: string, env: Env): Promise<string | null> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  if (!tokenResponse.ok) return null;
  const token = (await tokenResponse.json() as { access_token?: string }).access_token;
  if (!token) return null;

  const userResponse = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "chatgpt-microcms-proxy" },
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json() as { login?: string };
  return typeof user.login === "string" ? user.login : null;
}

async function approvedClients(request: Request, env: Env): Promise<Set<string>> {
  const value = readCookie(request, "__Host-APPROVED_CLIENTS");
  if (!value) return new Set();
  const separator = value.lastIndexOf(".");
  if (separator < 1) return new Set();
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (signature !== await hmac(payload, env.COOKIE_ENCRYPTION_KEY)) return new Set();
  try {
    return new Set(JSON.parse(atob(payload)) as string[]);
  } catch {
    return new Set();
  }
}

async function approvedClientsCookie(clients: Set<string>, env: Env): Promise<string> {
  const payload = btoa(JSON.stringify([...clients]));
  return secureCookie("APPROVED_CLIENTS", `${payload}.${await hmac(payload, env.COOKIE_ENCRYPTION_KEY)}`, APPROVED_CLIENTS_TTL_SECONDS);
}

async function beginGitHubLogin(request: Request, env: Env): Promise<Response> {
  const oauthRequest = await parseOAuthRequest(request, env);
  if (oauthRequest instanceof Response) return oauthRequest;
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`github-state:${state}`, JSON.stringify({ oauthUrl: request.url } satisfies GitHubState), { expirationTtl: STATE_TTL_SECONDS });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: githubCallbackUrl(env), state, scope: "read:user", allow_signup: "false" }).toString();
  return redirectResponse(github.toString(), {}, [await stateCookie("GITHUB_STATE", state)]);
}

async function handleGitHubCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || !await stateMatchesCookie(request, "GITHUB_STATE", state)) return html("<h1>Login session expired</h1>", 400, {}, [expireCookie("GITHUB_STATE")]);
  const rawState = await env.OAUTH_KV.get(`github-state:${state}`);
  await env.OAUTH_KV.delete(`github-state:${state}`);
  if (!rawState) return html("<h1>Login session expired</h1>", 400, {}, [expireCookie("GITHUB_STATE")]);

  let saved: GitHubState;
  try { saved = JSON.parse(rawState) as GitHubState; } catch { return html("<h1>Login session expired</h1>", 400); }
  const username = await fetchGitHubUsername(code, env);
  if (!username) return html("<h1>GitHub login failed</h1>", 502);
  if (username !== env.ALLOWED_GITHUB_USERNAME) return html("<h1>Access denied</h1><p>This GitHub account is not permitted to use this MCP server.</p>", 403, {}, [expireCookie("GITHUB_STATE")]);

  const oauthRequest = await parseOAuthRequest(new Request(saved.oauthUrl), env);
  if (oauthRequest instanceof Response) return oauthRequest;
  const clients = await approvedClients(request, env);
  if (clients.has(oauthRequest.clientId)) return completeAuthorization(oauthRequest, username, env, expireCookie("GITHUB_STATE"));

  const consentState = crypto.randomUUID();
  await env.OAUTH_KV.put(`consent-state:${consentState}`, JSON.stringify({ oauthUrl: saved.oauthUrl, username } satisfies ConsentState), { expirationTtl: STATE_TTL_SECONDS });
  const clientName = escapeHtml(oauthRequest.clientId);
  return html(`<h1>Connect microCMS</h1><p>Allow <strong>${clientName}</strong> to use this microCMS MCP connection?</p><form method="post" action="/authorize/consent"><input type="hidden" name="state" value="${consentState}"><button type="submit">Allow</button></form>`, 200, {}, [expireCookie("GITHUB_STATE"), await stateCookie("CONSENT_STATE", consentState)]);
}

async function completeAuthorization(oauthRequest: AuthRequest, username: string, env: Env, cookie?: string): Promise<Response> {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: `github:${username}`,
    metadata: { githubUsername: username },
    scope: oauthRequest.scope.filter((scope) => scope === "mcp:access"),
    props: { githubUsername: username },
  });
  return redirectResponse(redirectTo, {}, cookie ? [cookie] : []);
}

async function handleConsent(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const state = form.get("state");
  if (typeof state !== "string" || !await stateMatchesCookie(request, "CONSENT_STATE", state)) return html("<h1>Consent session expired</h1>", 400, {}, [expireCookie("CONSENT_STATE")]);
  const rawState = await env.OAUTH_KV.get(`consent-state:${state}`);
  await env.OAUTH_KV.delete(`consent-state:${state}`);
  if (!rawState) return html("<h1>Consent session expired</h1>", 400, {}, [expireCookie("CONSENT_STATE")]);
  const saved = JSON.parse(rawState) as ConsentState;
  const oauthRequest = await parseOAuthRequest(new Request(saved.oauthUrl), env);
  if (oauthRequest instanceof Response) return oauthRequest;
  const clients = await approvedClients(request, env);
  clients.add(oauthRequest.clientId);
  const completed = await completeAuthorization(oauthRequest, saved.username, env);
  const headers = new Headers(completed.headers);
  headers.append("Set-Cookie", expireCookie("CONSENT_STATE"));
  headers.append("Set-Cookie", await approvedClientsCookie(clients, env));
  return new Response(completed.body, { status: completed.status, headers });
}

export async function authHandler(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/authorize" && request.method === "GET") return beginGitHubLogin(request, env);
  if (pathname === "/auth/github/callback" && request.method === "GET") return handleGitHubCallback(request, env);
  if (pathname === "/authorize/consent" && request.method === "POST") return handleConsent(request, env);
  return new Response("Not found.", { status: 404 });
}
