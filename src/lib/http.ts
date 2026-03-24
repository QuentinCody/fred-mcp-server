import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const FRED_BASE = "https://api.stlouisfed.org/fred";

export interface FredFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    apiKey?: string;
}

/**
 * Fetch from the FRED API.
 * All requests include api_key and file_type=json as query params.
 */
export async function fredFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: FredFetchOptions,
): Promise<Response> {
    const apiKey = opts?.apiKey || "";
    const queryParams: Record<string, unknown> = {
        api_key: apiKey,
        file_type: "json",
        ...params,
    };

    return restFetch(FRED_BASE, path, queryParams, {
        ...opts,
        headers: {
            Accept: "application/json",
            ...(opts?.headers ?? {}),
        },
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 2,
        timeout: opts?.timeout ?? 30_000,
        userAgent: "fred-mcp-server/1.0 (bio-mcp)",
    });
}
