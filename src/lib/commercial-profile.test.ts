import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fredCatalog } from "../spec/catalog";
import { createFredApiFetch } from "./api-adapter";
import {
  COPYRIGHT_STATUS_TTL_MS, CopyrightStatusCache, createCommercialFredFetch, FRED_API_NOTICE, METADATA_ROUTES,
  normalizeCopyright, PUBLIC_DOMAIN, withCopyrightStatusVisible,
} from "./commercial-profile";

// License audit 2026-11-10: "Serve public-domain series only; filter the series
// with third-party copyright." FRED states the status of a series as its tag of
// group "cc" (Citation & Copyright): "public domain: citation requested",
// "copyrighted: citation required" or "copyrighted: pre-approval required". The
// API terms add: "Copyrighted series contain the word 'Copyright' in their notes."

const key = "fixture-key-not-a-credential";
const commercial = { method: "GET", licenseProfile: "commercial" as const };
const plain = { method: "GET" };
afterEach(() => vi.unstubAllGlobals());

// Shapes of the FRED API v1 documentation (series, series/tags, series/observations).
const tag = (name: string, group_id: string, series_count = 1000) => ({ name, group_id, notes: "", created: "2012-02-27 10:18:19-06", popularity: 50, series_count });
const tagList = (...tags: ReturnType<typeof tag>[]) => ({ realtime_start: "2026-11-10", realtime_end: "2026-11-10", order_by: "series_count", sort_order: "desc", count: tags.length, offset: 0, limit: 1000, tags });
const seriesRecord = (id: string, notes: string) => ({ realtime_start: "2026-11-10", realtime_end: "2026-11-10", seriess: [{ id, realtime_start: "2026-11-10", realtime_end: "2026-11-10", title: `Fixture ${id}`, observation_start: "1947-01-01", observation_end: "2025-07-01", frequency: "Quarterly", frequency_short: "Q", units: "Billions of Dollars", units_short: "Bil. of $", seasonal_adjustment: "Seasonally Adjusted Annual Rate", seasonal_adjustment_short: "SAAR", last_updated: "2025-09-25 07:56:01-05", popularity: 93, notes }] });
const observations = (values: string[]) => ({ realtime_start: "2026-11-10", realtime_end: "2026-11-10", observation_start: "1600-01-01", observation_end: "9999-12-31", units: "lin", output_type: 1, file_type: "json", order_by: "observation_date", sort_order: "asc", count: values.length, offset: 0, limit: 100000, observations: values.map((value, index) => ({ realtime_start: "2026-11-10", realtime_end: "2026-11-10", date: `2025-0${index + 1}-01`, value })) });

const GDP_NOTES = "BEA Account Code: A191RC\n\nGross domestic product (GDP), the featured measure of U.S. output, is the market value of the goods and services produced by labor and property located in the United States.";
const SP500_NOTES = "The observations for the S&P 500 represent the daily index value at market close.\n\nCopyright © 2016, S&P Dow Jones Indices LLC. All rights reserved. Reproduction of S&P 500 in any form is prohibited except with the prior written permission of S&P Dow Jones Indices LLC (\"S&P\").";
const PD = tag("public domain: citation requested", "cc", 610000);

/** The upstream state of each series: its tags, its record and its values. */
const fixtures: Record<string, { tags?: unknown; series?: unknown; values: string[] }> = {
  GDP: { tags: tagList(tag("nation", "geot"), tag("bea", "src"), tag("gdp", "gen"), PD, tag("quarterly", "freq")), series: seriesRecord("GDP", GDP_NOTES), values: ["29962.047", "30331.117"] },
  SP500: { tags: tagList(tag("s&p", "src"), tag("copyrighted: pre-approval required", "cc"), tag("daily", "freq")), series: seriesRecord("SP500", SP500_NOTES), values: ["6738.44", "6750.10"] },
  CITEREQ: { tags: tagList(tag("Copyrighted: Citation Required", "cc")), series: seriesRecord("CITEREQ", "Copyright, 2025, a third party."), values: ["1.5"] },
  NOCCTAG: { tags: tagList(tag("nation", "geot"), tag("monthly", "freq")), series: seriesRecord("NOCCTAG", "No status."), values: ["4.2"] },
  NOTESCOPY: { tags: tagList(PD), series: seriesRecord("NOTESCOPY", "Copyright, 2024, Fixture Ltd. All rights reserved."), values: ["7.7"] },
  TWOCC: { tags: tagList(PD, tag("copyrighted: citation required", "cc")), series: seriesRecord("TWOCC", "Two tags."), values: ["8.8"] },
  PARTIAL: { tags: { ...tagList(PD), count: 40 }, series: seriesRecord("PARTIAL", ""), values: ["9.9"] },
  OTHERID: { tags: tagList(PD), series: seriesRecord("GDP", GDP_NOTES), values: ["3.3"] },
  BROKEN: { tags: "not json", series: seriesRecord("BROKEN", ""), values: ["5.5"] },
};

function upstream(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/fred/, "");
    const id = url.searchParams.get("series_id") ?? "";
    calls.push(`${route}${id ? ` ${id}` : ""}`);
    const fixture = fixtures[id];
    const reply = (body: unknown) => typeof body === "string" ? new Response(body, { status: 500 }) : Response.json(body);
    if (route in extra) return reply(extra[route]);
    if (route === "/series/tags" && fixture) return reply(fixture.tags);
    if (route === "/series" && fixture) return reply(fixture.series);
    if (route === "/series/observations" && fixture) return reply(observations(fixture.values));
    return Response.json({ native: true });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher, valueCalls: () => calls.filter(call => call.startsWith("/series/observations") || call.startsWith("/v2/") || call.startsWith("/release/tables")) };
}

const valuesOf = (seriesId: string, params: Record<string, unknown> = {}) => ({ path: "/series/observations", params: { series_id: seriesId, ...params } });
const refused = (result: { status: number; data: unknown }) => {
  expect(result.status).toBe(451);
  expect(result.data).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
};

describe("FRED series values under the commercial license profile", () => {
  it("serves a public-domain series with its copyright status, read before the values", async () => {
    const { calls } = upstream();
    const result = await createFredApiFetch(key)({ ...commercial, ...valuesOf("GDP", { realtime_start: "2025-09-01", realtime_end: "2025-09-01" }) });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      observations: [{ date: "2025-01-01", value: "29962.047" }, { date: "2025-02-01", value: "30331.117" }],
      copyright_status: { series_id: "GDP", status: PUBLIC_DOMAIN, public_domain: true, terms: "https://fred.stlouisfed.org/legal/", notice: FRED_API_NOTICE },
    });
    expect(calls.slice(0, 2).sort()).toEqual(["/series GDP", "/series/tags GDP"]);
    expect(calls[2]).toBe("/series/observations GDP");
    const status = (result.data as { copyright_status: { sources: string[] } }).copyright_status;
    expect(status.sources).toEqual(["https://api.stlouisfed.org/fred/series/tags?series_id=GDP&file_type=json", "https://api.stlouisfed.org/fred/series?series_id=GDP&file_type=json"]);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each([
    ["copyrighted: pre-approval required (SP500)", "SP500", /copyrighted: pre-approval required/],
    ["copyrighted: citation required", "CITEREQ", /copyrighted: citation required/],
    ["no tag of group cc", "NOCCTAG", /no copyright status/],
    ["a public-domain tag with \"Copyright\" in the notes", "NOTESCOPY", /notes of the series contain the word "Copyright"/],
    ["two cc tags that disagree", "TWOCC", /more than one copyright status/],
    ["an incomplete tag list", "PARTIAL", /not complete/],
    ["a series record of a different series", "OTHERID", /does not identify exactly this series/],
    ["a tag read that fails (HTTP 500)", "BROKEN", /could not be read/],
  ])("refuses a series with %s: HTTP 451 and no data request", async (_name, seriesId, reason) => {
    const { calls, valueCalls } = upstream();
    const result = await createFredApiFetch(key)({ ...commercial, ...valuesOf(seriesId) });
    refused(result);
    expect(String((result.data as { message: string }).message)).toMatch(reason);
    expect(String((result.data as { message: string }).message)).toContain(seriesId);
    expect(valueCalls()).toEqual([]);
    expect(calls.sort()).toEqual([`/series ${seriesId}`, `/series/tags ${seriesId}`]);
  });

  it("fails closed when the status read has a network error or no API key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    refused(await createFredApiFetch(key)({ ...commercial, ...valuesOf("GDP") }));
    const { calls } = upstream();
    refused(await createFredApiFetch()({ ...commercial, ...valuesOf("GDP") }));
    expect(calls).toEqual([]);
  });

  it("refuses a request without a valid series_id and makes no request", async () => {
    const { calls } = upstream();
    const api = createFredApiFetch(key);
    for (const params of [{}, { series_id: "" }, { series_id: ["GDP"] }, { series_id: "GDP&x=1" }, { series_id: "GDP,SP500" }]) {
      refused(await api({ ...commercial, path: "/series/observations", params }));
    }
    expect(calls).toEqual([]);
  });

  it("caches a status per series for a short time, and does not cache a failed read", async () => {
    const { calls } = upstream();
    let now = 0;
    const inner = createFredApiFetch(key);
    const unrestricted: ApiFetchFn = request => inner({ ...request, licenseProfile: undefined });
    const api = createCommercialFredFetch(unrestricted, key, new CopyrightStatusCache(() => now));
    await api({ ...commercial, ...valuesOf("GDP") });
    await api({ ...commercial, ...valuesOf("GDP") });
    refused(await api({ ...commercial, ...valuesOf("SP500") }));
    refused(await api({ ...commercial, ...valuesOf("SP500") }));
    expect(calls.filter(call => call.startsWith("/series/tags"))).toEqual(["/series/tags GDP", "/series/tags SP500"]);
    now = COPYRIGHT_STATUS_TTL_MS + 1;
    await api({ ...commercial, ...valuesOf("GDP") });
    expect(calls.filter(call => call === "/series/tags GDP")).toHaveLength(2);
    refused(await api({ ...commercial, ...valuesOf("BROKEN") }));
    refused(await api({ ...commercial, ...valuesOf("BROKEN") }));
    expect(calls.filter(call => call === "/series/tags BROKEN")).toHaveLength(2);
  });

  it("drops the upstream body from a failed data request", async () => {
    upstream({ "/series/observations": "upstream failure with values 1,2,3" });
    await expect(createFredApiFetch(key)({ ...commercial, ...valuesOf("GDP") })).rejects.toSatisfy((error: { status?: number; data?: unknown }) => error.status === 500 && error.data === undefined);
    // Without the profile the native evidence stays.
    await expect(createFredApiFetch(key)({ ...plain, ...valuesOf("GDP") })).rejects.toMatchObject({ status: 500, data: { text: "upstream failure with values 1,2,3" } });
  });

  it("does not change a caller without the commercial profile", async () => {
    const { calls } = upstream();
    const api = createFredApiFetch(key);
    for (const seriesId of ["SP500", "NOCCTAG", "GDP"]) {
      const result = await api({ ...plain, ...valuesOf(seriesId) });
      expect(result.status).toBe(200);
      expect(result.data).not.toHaveProperty("copyright_status");
      expect(result.data).toMatchObject(observations(fixtures[seriesId].values));
    }
    expect(calls).toEqual(["/series/observations SP500", "/series/observations NOCCTAG", "/series/observations GDP"]);
    const other = await api({ ...plain, path: "/series/foo", params: {} });
    expect(other.data).toMatchObject({ native: true });
  });

  it("reports the refusal through the Code Mode proxy as a failed call with its reason", async () => {
    const { valueCalls } = upstream();
    const proxy = createApiProxyTool({ apiFetch: createFredApiFetch(key), catalog: fredCatalog });
    const request = { method: "GET", ...valuesOf("SP500") };
    const result = await proxy.handler(request, { sql: () => [], requestContext: { licenseProfile: "commercial" } });
    expect(result).toMatchObject({ __api_error: true, status: 451, message: expect.stringMatching(/^NOT_LICENSED_FOR_COMMERCIAL_USE: The values of FRED series SP500/) });
    expect(valueCalls()).toEqual([]);
    expect(await proxy.handler(request, { sql: () => [] })).toMatchObject({ observations: [{ value: "6738.44" }, { value: "6750.10" }] });
  });
});

describe("FRED release values and metadata under the commercial license profile", () => {
  // The documented v2 example: each series carries copyright_id and notes.
  const v2Series = (series_id: string, copyright_id: unknown, notes: string, value: string) => ({ series_id, title: `Fixture ${series_id}`, frequency: "Quarterly", units: "Billions of Dollars", seasonal_adjustment: "Not Seasonally Adjusted", last_updated: "2025-09-12T18:44:53Z", copyright_id, notes, observations: [{ date: "2025-01-01", value }] });
  const page = {
    has_more: false, release: { release_id: 52, name: "Z.1 Financial Accounts of the United States", sources: [{ name: "Board of Governors of the Federal Reserve System (US)" }] },
    series: [
      v2Series("ABSITCMAHDFS", "public domain: citation requested", "Source ID: FL674004005.Q", "1404.392"),
      v2Series("THIRDPARTY", "copyrighted: citation required", "Copyright, 2025, Fixture.", "777.001"),
      v2Series("NOSTATUS", undefined, "", "888.002"),
      v2Series("PDNOTES", "public domain: citation requested", "Copyright © Fixture.", "999.003"),
    ],
  };
  const release = { path: "/v2/release/observations", params: { release_id: 52 } };

  it("serves the public-domain series of a release page and removes the others", async () => {
    upstream({ "/v2/release/observations": page });
    const result = await createFredApiFetch(key)({ ...commercial, ...release });
    const data = result.data as Record<string, any>;
    expect(data.data.series.map((series: { series_id: string }) => series.series_id)).toEqual(["ABSITCMAHDFS"]);
    expect(data.data.series[0]).toMatchObject({ copyright_status: { status: PUBLIC_DOMAIN, public_domain: true, field: "copyright_id of /fred/v2/release/observations" } });
    expect(data._license_filter).toMatchObject({ profile: "commercial", removed: 3, notice: FRED_API_NOTICE, removed_series: [
      { series_id: "THIRDPARTY", copyright_id: "copyrighted: citation required", observations: 1 },
      { series_id: "NOSTATUS", copyright_id: null, observations: 1 },
      { series_id: "PDNOTES", copyright_id: "public domain: citation requested", observations: 1 },
    ] });
    expect(data.provenance).not.toHaveProperty("raw_json");
    expect(data.provenance.response_sha256).toEqual(expect.any(String));
    expect(result.completeness).toMatchObject({ complete: false, truncation: { detail: expect.stringContaining("Series removed by the commercial license profile: 3") } });
    for (const value of ["777.001", "888.002", "999.003"]) expect(JSON.stringify(result)).not.toContain(value);
  });

  it("keeps the release page of a caller without the profile", async () => {
    upstream({ "/v2/release/observations": page });
    const result = await createFredApiFetch(key)({ ...plain, ...release });
    const data = result.data as Record<string, any>;
    expect(data.data.series).toEqual(page.series);
    expect(data).not.toHaveProperty("_license_filter");
    expect(data.provenance.raw_json).toContain("777.001");
  });

  it("refuses release tables with observation values and serves them without", async () => {
    const { valueCalls } = upstream({ "/release/tables": { name: "Personal Income and Its Disposition", element_id: 12886, release_id: "53", elements: {} } });
    const api = createFredApiFetch(key);
    for (const include_observation_values of [true, "true", "1", "TRUE"]) {
      refused(await api({ ...commercial, path: "/release/tables", params: { release_id: 53, include_observation_values } }));
    }
    expect(valueCalls()).toEqual([]);
    for (const params of [{ release_id: 53 }, { release_id: 53, include_observation_values: false }, { release_id: 53, include_observation_values: "false" }]) {
      expect((await api({ ...commercial, path: "/release/tables", params })).status).toBe(200);
    }
    expect((await api({ ...plain, path: "/release/tables", params: { release_id: 53, include_observation_values: true } })).status).toBe(200);
  });

  it("serves the metadata routes and shows the copyright status that a series record states", async () => {
    const search = { realtime_start: "2026-11-10", count: 3, offset: 0, limit: 1000, seriess: [
      { id: "SP500", title: "S&P 500", notes: SP500_NOTES },
      { id: "GDP", title: "Gross Domestic Product", notes: GDP_NOTES },
      { id: "FIXTURE", title: "Fixture", copyright_id: "Public Domain: Citation Requested" },
    ] };
    const { calls } = upstream({ "/series/search": search });
    const api = createFredApiFetch(key);
    const result = await api({ ...commercial, path: "/series/search", params: { search_text: "gdp" } });
    expect((result.data as typeof search).seriess.map(record => (record as { copyright_status?: string }).copyright_status)).toEqual([
      "copyrighted (the notes contain \"Copyright\")", undefined, PUBLIC_DOMAIN,
    ]);
    expect((await api({ ...plain, path: "/series/search", params: { search_text: "gdp" } })).data).not.toHaveProperty("seriess.0.copyright_status");
    for (const route of ["/series/vintagedates", "/series/tags", "/category/series", "/releases", "/sources", "/tags/series"]) {
      expect((await api({ ...commercial, path: route, params: { series_id: "SP500" } })).status, route).toBe(200);
    }
    expect(calls.filter(call => call.startsWith("/series/observations"))).toEqual([]);
  });

  it.each(["/series/foo", "/geofred/series_data", "/release/observations", "/v2/series"])("refuses the path %s without a request: it is not a documented metadata route", async path => {
    const { calls } = upstream();
    refused(await createFredApiFetch(key)({ ...commercial, path, params: { series_id: "GDP" } }));
    expect(calls).toEqual([]);
  });

  it("covers each catalog route with a rule", () => {
    const valueRoutes = ["/series/observations", "/v2/release/observations"];
    for (const endpoint of fredCatalog.endpoints) {
      expect(valueRoutes.includes(endpoint.path) || METADATA_ROUTES.has(endpoint.path), endpoint.path).toBe(true);
    }
  });

  it("normalizes copyright labels and keeps a record without one", () => {
    expect(normalizeCopyright("  Public Domain:   Citation Requested ")).toBe(PUBLIC_DOMAIN);
    for (const value of [undefined, null, 4, "", "  "]) expect(normalizeCopyright(value)).toBeUndefined();
    const data = { seriess: [{ id: "GDP", notes: GDP_NOTES }] };
    expect(withCopyrightStatusVisible(data)).toBe(data);
    expect(withCopyrightStatusVisible("text")).toBe("text");
  });
});
