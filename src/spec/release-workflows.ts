import type {WorkflowRecipe} from "@bio-mcp/shared/codemode/catalog";
export const releaseWorkflows: WorkflowRecipe[] = [
  {title: "Read and resume release-wide FRED v2 observations", keywords: ["release", "bulk", "v2", "cursor", "revision", "last_updated"],
    description: "Read at most three small pages and return the next request. Keep repeated series as page segments, compare last_updated when a series recurs and restart if it changes. Staged pages recover control metadata through bounded SQL reads. Resume with the returned checkpoint to retain revision/cursor history. These are current historical observations, not all vintages; this bounded sample cannot prove an atomic release snapshot.",
    code: `const resume = null; // replace null with the previous returned checkpoint to resume safely
const pages = [];
const updates = new Map(resume?.series_updates ?? []);
const cursors = new Set(resume?.cursors ?? []);
let params = resume?.next_request?.params ?? {release_id: 52, limit: 100};
if (resume && (resume.release_id !== params.release_id || resume.next_request?.path !== "/v2/release/observations")) throw new Error("Checkpoint release/path mismatch");
const checkpoint = next_request => ({release_id: params.release_id, next_request, series_updates: Array.from(updates), cursors: Array.from(cursors)});
async function controls(page) {
  if (!page.__staged) return page;
  const id = page.data_access_id;
  const size = await api.query(id, "SELECT length(control_json) AS n FROM fred_page WHERE page_index=0");
  const n = size.results[0]?.n;
  if (!Number.isSafeInteger(n) || n < 1 || n > 131072) throw new Error("Staged page control exceeds 131072-character bound; retain source handle");
  let text = "";
  for (let start = 1; start <= n; start += 4000) {
    const result = await api.query(id, "SELECT substr(control_json," + start + ",4000) AS part FROM fred_page WHERE page_index=0");
    if (result.truncated || result.results.length !== 1 || typeof result.results[0].part !== "string") throw new Error("Incomplete staged page control");
    text += result.results[0].part;
  }
  if (Array.from(text).length !== n) throw new Error("Incomplete staged page control text");
  const control = JSON.parse(text);
  if (!Array.isArray(control.series_updates) || typeof control.paging?.has_more !== "boolean") throw new Error("Invalid staged page control");
  return control;
}
let next = {path: "/v2/release/observations", params};
for (let i = 0; i < 3; i++) {
  const page = await api.get("/v2/release/observations", params);
  if (page.__api_error || page.__stage_error) return {pages, pending_page: page, checkpoint: checkpoint(next), complete: false};
  let control;
  try { control = await controls(page); }
  catch (error) { return {pages, pending_page: page, control_error: String(error), checkpoint: checkpoint(next), complete: false}; }
  pages.push(page);
  for (const series of control.series_updates) {
    if (updates.has(series.series_id) && updates.get(series.series_id) !== series.last_updated)
      return {pages, restart_required: true, changed_series: series.series_id, checkpoint: null, complete: false};
    updates.set(series.series_id, series.last_updated);
  }
  if (!control.paging.has_more) return {pages, next_request: null, checkpoint: null, series_updates: Array.from(updates), cursor_exhausted: true, atomic_snapshot_verified: false};
  next = control.paging.next_request;
  if (cursors.has(next.params.next_cursor)) return {pages, cursor_cycle: true, checkpoint: null, complete: false};
  cursors.add(next.params.next_cursor);
  params = next.params;
}
return {pages, next_request: next, checkpoint: checkpoint(next), series_updates: Array.from(updates), complete: false};`},
  {title: "Retrieve FRED observations as known on a historical date", keywords: ["ALFRED", "vintage", "as of", "backtest", "realtime"],
    description: "Use v1 real-time periods for revision-aware research. Set realtime_start and realtime_end to the same as-of date; observation dates identify economic periods, not publication times. Retain per-row real-time fields and envelope pagination. Day-level vintages do not prove intraday availability. V2 release observations have no vintage selector.",
    code: `const asOfDate = "2025-09-01"; // explicit historical knowledge date
return await api.get("/series/observations", {series_id: "GDP", realtime_start: asOfDate, realtime_end: asOfDate, observation_start: "2020-01-01", observation_end: "2025-08-31", output_type: 1, units: "lin", limit: 1000, offset: 0});`},
];
