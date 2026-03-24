import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { fredFetch } from "./http";

let envApiKey: string | undefined;

export function setFredApiKey(key: string | undefined) {
    envApiKey = key;
}

export function createFredApiFetch(): ApiFetchFn {
    return async (request) => {
        const params = { ...(request.params as Record<string, unknown> || {}) };

        // Path maps directly to FRED endpoints (e.g., /series/observations)
        const response = await fredFetch(request.path, params, { apiKey: envApiKey });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => response.statusText);
            const error = new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const data = await response.json();
        return { status: response.status, data };
    };
}
