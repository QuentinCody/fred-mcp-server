import { fail } from "./errors";

/** Fixed-host, single-attempt JSON reads. The deadline includes the complete body. */
export async function fredRead(path: string, params: Record<string, unknown>, opts?: {
  apiKey?: string; timeoutMs?: number; maxBytes?: number;
}) {
  const apiKey = opts?.apiKey;
  if (!apiKey?.trim()) fail("FRED_API_KEY is required; demo responses do not establish data access", 401);
  if (!/^\/(?:v2\/)?[a-z_]+(?:\/[a-z_]+){0,2}$/.test(path)) fail("Use a relative FRED API resource path");
  const { url, headers, sourceUrl, version } = prepareFredRequest(path, params, apiKey);
  const controller = new AbortController();
  const maxBytes = opts?.maxBytes ?? 4 * 1024 * 1024;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, opts?.timeoutMs ?? 50_000);
  });
  try {
    try {
      const pending = Promise.resolve(fetch(url, { headers, redirect: "manual", signal: controller.signal })).then(value => {
        if (controller.signal.aborted) { void value.body?.cancel().catch(() => {}); throw new Error("deadline"); }
        return value;
      });
      response = await Promise.race([pending, expired]);
    } catch { fail("FRED request failed or timed out", 502); }
    if (Number(response.headers.get("content-length")) > maxBytes) fail("FRED response exceeds byte limit (default 4 MiB)", 502);
    reader = response.body?.getReader();
    const { digest, size, raw, original } = await readRedactedBody(reader, expired, maxBytes, apiKey);
    const provenance = fredProvenance(sourceUrl, version, params, digest, size, raw, original);
    return decodeProviderResponse(response, raw, provenance);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response) void response.body?.cancel().catch(() => {});
  }
}

function fredProvenance(sourceUrl: string, version: string, params: Record<string, unknown>, digest: ArrayBuffer, size: number, raw: string, original: string) {
  return {
    source_url: sourceUrl, api_version: version, request: params, retrieved_at: new Date().toISOString(),
    response_sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""),
    response_bytes: size, raw_json: raw, redacted: raw !== original
  };
}

function decodeProviderResponse(response: Response, raw: string, provenance: { source_url: string; api_version: string; request: Record<string, unknown>; retrieved_at: string; response_sha256: string; response_bytes: number; raw_json: string; redacted: boolean; }) {
  const evidence = {
    upstream_http_status: response.status, retry_after: response.headers.get("retry-after"),
    content_type: response.headers.get("content-type"), text: raw, provenance
  };
  if (response.status !== 200 || response.headers.has("content-range")) {
    fail(`FRED HTTP ${response.status}: a complete HTTP 200 response is required`, response.status === 200 ? 502 : response.status, evidence);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { fail("FRED returned invalid JSON", 502, evidence); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Invalid FRED response", 502, evidence);
  const data = parsed as Record<string, unknown>;
  if (data.error_code !== undefined || typeof data.error_message === "string") fail("FRED returned an API error envelope", 502, evidence);
  return { status: response.status, data, provenance };
}

async function readRedactedBody(reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | undefined, expired: Promise<never>, maxBytes: number, apiKey: string) {
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (reader) {
      const { value, done } = await Promise.race([reader.read(), expired]); if (done) break;
      size += value.byteLength; if (size > maxBytes) fail("Response exceeds byte limit", 502);
      chunks.push(value);
    }
  } catch { fail("FRED response unreadable, timed out or exceeds byte limit (default 4 MiB)", 502); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: string;
  try { raw = (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "\uFEFF" : "") + new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { fail("FRED returned invalid UTF-8", 502); }
  const original = raw;
  for (const value of new Set([apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)])) raw = raw.split(value).join("[REDACTED]");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { digest, size, raw, original };
}

function prepareFredRequest(path: string, params: Record<string, unknown>, apiKey: string) {
  const version = path === "/v2/release/observations" ? "2" : "1";
  const url = new URL("https://api.stlouisfed.org/fred" + path);
  if (params.file_type !== undefined && params.file_type !== "json") fail("FRED Code Mode reads JSON; XML/CSV are not exposed");
  for (const [key, value] of Object.entries(params)) {
    if (/api_?key|authorization|token/i.test(key)) fail("Configure FRED_API_KEY on the Worker; do not pass credentials in Code Mode");
    if (value === undefined || value === null) continue;
    if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 32000 || typeof value === "number" && !Number.isFinite(value)) fail("Use bounded scalar FRED parameters");
    url.searchParams.set(key, String(value));
  }
  if (version === "1") url.searchParams.set("file_type", "json");
  if (url.toString().length > 32000) fail("FRED query exceeds local URL limit");
  const sourceUrl = url.toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (version === "2") headers.Authorization = "Bearer " + apiKey;
  else url.searchParams.set("api_key", apiKey);
  return { url, headers, sourceUrl, version };
}
