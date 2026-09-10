import type { Env } from "./types";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamUrl(serviceId: string): string {
  return `https://mcp.microcms.io/mcp/${encodeURIComponent(serviceId)}`;
}

function upstreamHeaders(requestHeaders: Headers, apiKey: string): Headers {
  const headers = new Headers();

  requestHeaders.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "authorization" ||
      lowerName === "cookie" ||
      lowerName === "host" ||
      lowerName === "origin" ||
      lowerName === "referer" ||
      lowerName === "forwarded" ||
      lowerName === "via" ||
      lowerName.startsWith("cf-") ||
      lowerName.startsWith("x-forwarded-") ||
      lowerName === "x-real-ip"
    ) {
      return;
    }
    headers.set(name, value);
  });

  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function responseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  upstreamHeaders.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "set-cookie") return;
    headers.append(name, value);
  });
  return headers;
}

/**
 * Proxies a Streamable HTTP MCP request without reading either request or
 * response body. The caller has already validated its OAuth access token.
 */
export async function proxyMcpRequest(request: Request, env: Env): Promise<Response> {
  if (!env.MICROCMS_SERVICE_ID || !env.MICROCMS_API_KEY) {
    return new Response("Proxy configuration is incomplete.", { status: 500 });
  }

  if (!new Set(["GET", "POST", "DELETE"]).has(request.method)) {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, POST, DELETE" },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(env.MICROCMS_SERVICE_ID), {
      method: request.method,
      headers: upstreamHeaders(request.headers, env.MICROCMS_API_KEY),
      body: request.method === "GET" || request.method === "DELETE" ? undefined : request.body,
      redirect: "manual",
    });
  } catch (error) {
    console.error("mcp_upstream_unavailable", {
      method: request.method,
      error: error instanceof Error ? error.name : "unknown",
    });
    return new Response("Upstream MCP service is unavailable.", { status: 502 });
  }

  console.log("mcp_upstream_response", {
    method: request.method,
    status: upstream.status,
    contentType: upstream.headers.get("Content-Type") ?? "",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream.headers),
  });
}
