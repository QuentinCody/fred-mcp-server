import { fail } from "./errors";
import { fredRead } from "./http";
export { fail } from "./errors";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid FRED v2 object", 502);
  return value as Record<string, unknown>;
}
export function releaseParams(input: Record<string, unknown>) {
  for (const key of Object.keys(input)) if (!["release_id", "format", "limit", "next_cursor"].includes(key)) fail(`Unsupported FRED v2 parameter: ${key}`);
  const releaseId = input.release_id;
  const limit = input.limit ?? 1000;
  if (typeof releaseId !== "number" || !Number.isSafeInteger(releaseId) || releaseId <= 0) fail("release_id must be a positive integer");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail("Use limit 1–10000 observations per page; continue with next_cursor");
  if (input.format !== undefined && input.format !== "json") fail("This adapter uses format=json to validate cursor and observation metadata");
  if (input.next_cursor !== undefined && (typeof input.next_cursor !== "string" || !input.next_cursor || input.next_cursor.length > 2000 || /[\r\n]/.test(input.next_cursor))) fail("next_cursor must be the nonempty opaque string from the previous page");
  return {release_id: releaseId, format: "json", limit, ...(input.next_cursor === undefined ? {} : {next_cursor: input.next_cursor as string})};
}
export function inspectReleasePage(value: unknown, params: ReturnType<typeof releaseParams>) {
  const data = object(value);
  const release = object(data.release);
  if (release.release_id !== params.release_id || !Array.isArray(data.series)) fail("FRED release identity/series contract mismatch", 502);
  // Examples use booleans; the variables table also documents literal strings.
  if (![true, false, "true", "false"].includes(data.has_more as boolean | string)) fail("FRED has_more is missing or invalid", 502);
  let { observationCount, hasMore, seriesUpdates }: { observationCount: number; hasMore: boolean; seriesUpdates: { series_id: string; last_updated: string; }[]; } = inspectReleaseSeries(data, data.series, params);
  if (observationCount > params.limit || hasMore && !observationCount) fail("FRED page observation count mismatch", 502);
  return {data, series_updates: seriesUpdates, paging: {has_more: hasMore, returned_observations: observationCount,
    next_request: hasMore ? {path: "/v2/release/observations", params: {...params, next_cursor: data.next_cursor as string}} : null},
    complete_release_verified: false, atomic_snapshot_verified: false,
    note: "This is one page of current observation history, not revision history or an as-of vintage. A series can span pages: append by series/date while retaining metadata and compare last_updated across requests. If an update is detected, restart the release retrieval. Cursor exhaustion alone does not establish an atomic snapshot."};
}
function inspectReleaseSeries(data: Record<string, unknown>, values: unknown[], params: { next_cursor?: string | undefined; release_id: number; format: string; limit: number; }) {
  const hasMore = data.has_more === true || data.has_more === "true";
  if (hasMore && (typeof data.next_cursor !== "string" || !data.next_cursor || data.next_cursor.length > 2000 || /[\r\n]/.test(data.next_cursor) || data.next_cursor === params.next_cursor)) fail("FRED cursor missing or did not advance", 502);
  let observationCount = 0;
  const seriesUpdates: { series_id: string; last_updated: string; }[] = [];
  const seenSeries = new Set<string>();
  for (const item of values) {
    const series = object(item);
    if (typeof series.series_id !== "string" || !series.series_id || seenSeries.has(series.series_id) || !Array.isArray(series.observations) || typeof series.last_updated !== "string" || !Number.isFinite(Date.parse(series.last_updated))) fail("FRED series identity/observations/update metadata mismatch", 502);
    seenSeries.add(series.series_id);
    seriesUpdates.push({ series_id: series.series_id, last_updated: series.last_updated });
    const seenDates = new Set<string>();
    for (const value of series.observations) {
      const observation = object(value);
      if (typeof observation.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(observation.date) || !Number.isFinite(Date.parse(observation.date)) || new Date(observation.date).toISOString().slice(0, 10) !== observation.date || seenDates.has(observation.date) || typeof observation.value !== "string") fail("FRED observation date/value contract mismatch", 502);
      seenDates.add(observation.date);
      observationCount++;
    }
  }
  return { observationCount, hasMore, seriesUpdates };
}

export async function releaseObservations(input: Record<string, unknown>, apiKey?: string) {
  const params = releaseParams(input);
  const source = await fredRead("/v2/release/observations", params, {apiKey});
  let inspected: ReturnType<typeof inspectReleasePage>;
  try { inspected = inspectReleasePage(source.data, params); }
  catch (error) { fail(error instanceof Error ? error.message : "FRED release contract mismatch", 502, {provenance: source.provenance, data: source.data}); }
  const completeness = {complete: false, returned: inspected.paging.returned_observations,
    truncation: {reason: inspected.paging.has_more ? "page_limit" as const : "unknown" as const,
      detail: inspected.paging.has_more ? "This release page has continuation." : "Cursor exhaustion does not prove complete release coverage or an atomic snapshot."}};
  return {...inspected, completeness, _mcp: {completeness}, provenance: {...source.provenance, vintage_date: null}};
}
