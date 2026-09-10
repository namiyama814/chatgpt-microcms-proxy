import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyMcpRequest } from "../src/proxy";
import type { Env } from "../src/types";

const env = {
  MICROCMS_SERVICE_ID: "sample-service",
  MICROCMS_API_KEY: "microcms-secret",
} as Env;

describe("proxyMcpRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replaces client credentials and preserves MCP transport headers", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer microcms-secret");
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-123");
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
      return new Response("event: message\ndata: ok\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "MCP-Session-Id": "session-123" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await proxyMcpRequest(new Request("https://proxy.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer chatgpt-token",
        Cookie: "browser-session=value",
        "MCP-Session-Id": "session-123",
        "MCP-Protocol-Version": "2025-06-18",
        Accept: "text/event-stream",
      },
      body: "{}",
    }), env);

    expect(upstream).toHaveBeenCalledWith("https://mcp.microcms.io/mcp/sample-service", expect.any(Object));
    expect(response.headers.get("mcp-session-id")).toBe("session-123");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe("event: message\ndata: ok\n\n");
  });

  it("passes upstream errors through without exposing response cookies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "60", "Set-Cookie": "upstream=value" },
    })));

    const response = await proxyMcpRequest(new Request("https://proxy.example/mcp", { method: "GET" }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("rate limited");
  });

  it("rejects methods outside Streamable HTTP MCP", async () => {
    const response = await proxyMcpRequest(new Request("https://proxy.example/mcp", { method: "PUT" }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
  });
});
