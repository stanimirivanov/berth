import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { historyApi } from "../src/application/history/api.js";
import { historyReader } from "../src/application/history/runtime.js";

const api = historyApi(
  process.env.BERTH_HISTORY_TOKEN ?? "",
  historyReader(process.env),
);
const directory = resolve("ui/dist/history/browser");
const htmlType = "text/html; charset=utf-8";
const types: Record<string, string> = {
  html: htmlType,
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  ico: "image/x-icon",
};

/** Serve the shell only for canonical UI routes, leaving identifier validation to Angular. */
function documentRoute(path: string) {
  return path === "/" || /^\/operations(?:\/[^/]+)?$/.test(path);
}

/** Read a flat build asset, distinguishing an asset miss from broken preview output. */
async function readAsset(path: string, shell: boolean) {
  try {
    return await readFile(resolve(directory, path));
  } catch (error) {
    if (
      !shell &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Explicit loopback preview server; no credentials are read until an authenticated history request. */
createServer(async (incoming, outgoing) => {
  outgoing.setHeader("Cache-Control", "no-store");
  outgoing.setHeader("X-Content-Type-Options", "nosniff");
  outgoing.setHeader("Referrer-Policy", "no-referrer");
  outgoing.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  if (incoming.headers.host !== "127.0.0.1:4201" || incoming.method !== "GET") {
    outgoing.writeHead(400).end();
    return;
  }
  try {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1:4201");
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers();
      if (incoming.headers.authorization)
        headers.set("authorization", incoming.headers.authorization);
      const response = await api.fetch(new Request(url, { headers }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
      return;
    }
    const shell = documentRoute(url.pathname);
    const name = shell ? "index.html" : url.pathname.slice(1);
    const extension = name.split(".").at(-1) ?? "";
    const type =
      /^[A-Za-z0-9._-]+$/.test(name) && Object.hasOwn(types, extension)
        ? types[extension]
        : undefined;
    const asset = type ? await readAsset(name, shell) : undefined;
    const content = asset ?? (await readFile(resolve(directory, "404.html")));
    const contentType = asset && type ? type : htmlType;
    if (contentType === htmlType) {
      const headers = await readFile(resolve(directory, "_headers"), "utf8");
      const policy = /^ {2}Content-Security-Policy: ([^\r\n]+)$/m.exec(
        headers,
      )?.[1];
      if (!policy?.includes("style-src 'self' 'sha256-")) {
        outgoing.writeHead(503).end("History preview requires the CSP build");
        return;
      }
      outgoing.setHeader("Content-Security-Policy", policy);
    }
    outgoing.writeHead(asset ? 200 : 404, { "Content-Type": contentType });
    outgoing.end(content);
  } catch {
    outgoing.writeHead(503).end("History preview unavailable");
  }
}).listen(4201, "127.0.0.1", () => {
  console.log("History preview: http://127.0.0.1:4201");
});
