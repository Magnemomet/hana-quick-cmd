// assets/app-api.js — 应用内路由的统一入口
// v2 App 的接口都在 /api/apps/<appId>/routes/<path>，凭证走 appSurfaceSession 头。
export const APP_ID = "quick-cmd";

export function apiUrl(path) {
  return `${location.origin}/api/apps/${APP_ID}/routes/${path}`;
}

export function appHeaders(extra = {}) {
  const headers = new Headers(extra || {});
  const ss = new URLSearchParams(location.search).get("appSurfaceSession") || "";
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  return headers;
}

/** 调应用自己的后端；非 2xx 抛错，尽量把服务端的中文 message 带出来。 */
export async function apiFetch(path, init = {}, timeoutMs = 30000) {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: appHeaders(init.headers),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const error = new Error(body?.message || `HTTP ${res.status} ${init?.method || "GET"} ${apiUrl(path)}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function getJson(path, timeoutMs) {
  return apiFetch(path, { method: "GET" }, timeoutMs);
}

export function postJson(path, payload, timeoutMs) {
  return apiFetch(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload ?? {}) },
    timeoutMs,
  );
}

/** iframe 里的 console 外面看不到，借后端写进 Hana 日志。 */
export function clientLog(message) {
  try {
    void postJson("client-log", { message: String(message).slice(0, 400) }, 4000).catch(() => {});
  } catch {
    /* 记不上就算 */
  }
}
