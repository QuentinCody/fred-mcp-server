import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { createCommercialFredFetch } from "./commercial-profile";
import { fredRead } from "./http";
import { fail, releaseObservations } from "./release-observations";

/**
 * A reselling caller (`licenseProfile: "commercial"`) gets the rule of
 * ./commercial-profile: series values only for public-domain series. Each
 * other caller gets the adapter with no change.
 */
export function createFredApiFetch(apiKey?: string): ApiFetchFn {
  const unrestricted: ApiFetchFn = async request => {
    const params = {...request.params};
    if (request.method !== "GET" || request.body !== undefined) fail("FRED supports GET requests");
    if (request.path === "/v2/release/observations") {
      const data = await releaseObservations(params, apiKey);
      return {status: 200, data, completeness: data.completeness, upstreamTotal: null};
    }
    if (request.path.startsWith("/v2/")) fail("Unknown FRED v2 operation");
    const source = await fredRead(request.path, params, {apiKey});
    const completeness = {complete: false, ...(Array.isArray(source.data.observations) ? {returned: source.data.observations.length} : {}),
      truncation: {reason: "unknown" as const, detail: "One FRED response does not establish complete series/release coverage or all revision vintages."}};
    return {status: source.status, completeness, upstreamTotal: null,
      data: {...source.data, _mcp: {completeness, provenance: source.provenance}}};
  };
  const commercial = createCommercialFredFetch(unrestricted, apiKey);
  return request => (request.licenseProfile === "commercial" ? commercial(request) : unrestricted(request));
}
