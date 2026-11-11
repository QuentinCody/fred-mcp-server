import {afterEach, expect, it, vi} from "vitest";
import {createFredApiFetch} from "./api-adapter";
import {releaseWorkflows} from "../spec/release-workflows";
const key = "fixture-key-not-a-credential";
const api = createFredApiFetch(key);
const series = {series_id: "SERIES_A", title: "Fixture series", frequency: "Quarterly", units: "Billions", seasonal_adjustment: "Not Seasonally Adjusted", last_updated: "2025-09-12T18:44:53Z", copyright_id: "fixture copyright", notes: "original notes", observations: [{date: "2025-01-01", value: "."}, {date: "2025-04-01", value: "9007199254740993.123456789"}]};
// Synthetic reduced contract example; the official documentation includes ellipses.
const page = {has_more: true, next_cursor: "SERIES_A,2025-07-01", release: {release_id: 52, name: "Fixture release", sources: [{name: "Fixture source", notes: "source context"}]}, series: [series], extra: {preserve: true}};
const query = {method: "GET" as const, path: "/v2/release/observations", params: {release_id: 52}};
function mock(value: unknown = page) { vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}}))); }
afterEach(() => vi.unstubAllGlobals());
it("uses bearer authentication with a credential-free URL/provenance", async () => {
  mock(); const result = await api(query);
  const [input, init] = vi.mocked(fetch).mock.calls[0]; const url = new URL(String(input));
  expect(url.pathname).toBe("/fred/v2/release/observations"); expect(url.searchParams.get("format")).toBe("json"); expect(url.searchParams.get("limit")).toBe("1000"); expect(url.searchParams.has("api_key")).toBe(false); expect(url.searchParams.has("file_type")).toBe(false);
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${key}`);
  expect(JSON.stringify(result)).not.toContain(key);
  expect(result.data).toMatchObject({data: page, provenance: {api_version: "2", vintage_date: null}, series_updates: [{series_id: "SERIES_A", last_updated: series.last_updated}], paging: {returned_observations: 2, next_request: {params: {release_id: 52, next_cursor: page.next_cursor, limit: 1000}}}, atomic_snapshot_verified: false});
});
it("preserves missing markers, numeric precision, metadata and unknown fields", async () => { mock(); expect((await api(query)).data).toMatchObject({data: page}); });
it.each([false, "false"])("handles a terminal has_more=%j without claiming an atomic release", async has_more => {
  mock({...page, has_more, next_cursor: undefined});
  expect((await api(query)).data).toMatchObject({paging: {has_more: false, next_request: null}, complete_release_verified: false, atomic_snapshot_verified: false});
});
it("accepts the documented literal string true without changing native data", async () => {
  mock({...page, has_more: "true"}); expect((await api(query)).data).toMatchObject({data: {has_more: "true"}, paging: {has_more: true}});
});
it("encodes an opaque cursor as a query value rather than a URL fragment", async () => {
  mock({...page, has_more: false}); await api({...query, params: {...query.params, next_cursor: "SERIES_A,2025-01-01&opaque=1"}});
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0])); expect(url.searchParams.get("next_cursor")).toBe("SERIES_A,2025-01-01&opaque=1"); expect(url.searchParams.has("opaque")).toBe(false);
});
it.each([{release_id: 0}, {release_id: "52"}, {limit: 10001}, {limit: 1.5}, {next_cursor: ""}, {format: "xml"}, {file_type: "json"}, {realtime_start: "2025-01-01"}, {vintage_dates: "2025-01-01"}, {api_key: "bad"}])("rejects invalid and v1-only parameters before network access %#", async changes => {
  mock(); await expect(api({...query, params: {...query.params, ...changes}})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each([{release: {release_id: 1}}, {has_more: 1}, {next_cursor: undefined}, {series: {}}, {series: [{...series, last_updated: "invalid"}]}, {series: [{...series, observations: [{date: "2025-01-01", value: 0}]}]}, {series: [series, series]}, {series: [{...series, observations: [series.observations[0], series.observations[0]]}]}, {series: []}])("rejects malformed pages and zero-progress cursors %#", async changes => {
  mock({...page, ...changes}); await expect(api(query)).rejects.toThrow();
});
it("rejects a cursor that repeats the submitted cursor", async () => { mock(); await expect(api({...query, params: {...query.params, next_cursor: page.next_cursor}})).rejects.toThrow("advance"); });
it("counts observations, not series, against the page limit", async () => { mock(); await expect(api({...query, params: {...query.params, limit: 1}})).rejects.toThrow("count"); });
it("returns an actionable missing-key error without reusing another adapter's key", async () => {
  mock(); const missing = createFredApiFetch(); await expect(missing(query)).rejects.toMatchObject({status: 401}); expect(fetch).not.toHaveBeenCalled(); await api(query); expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps independent credentials and v1 vintage parameters across interleaved adapters", async () => {
  mock({observations: [{date: "2025-01-01", value: ".", realtime_start: "2025-09-01", realtime_end: "2025-09-01"}]});
  const first = createFredApiFetch("first-fixture-key");
  const second = createFredApiFetch("second-fixture-key");
  const input = {method: "GET" as const, path: "/series/observations", params: {series_id: "GDP", realtime_start: "2025-09-01", realtime_end: "2025-09-01", output_type: 1, offset: 20}};
  await first(input); await second(input); await first(input);
  const urls = vi.mocked(fetch).mock.calls.map(c => new URL(String(c[0])));
  expect(urls.map(u => u.searchParams.get("api_key"))).toEqual(["first-fixture-key", "second-fixture-key", "first-fixture-key"]);
  expect(urls[0].searchParams.get("realtime_start")).toBe("2025-09-01"); expect(urls[0].searchParams.get("offset")).toBe("20"); expect(urls[0].searchParams.get("file_type")).toBe("json");
});
it("does not reflect credentials in HTTP or network errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(key, {status: 401})).mockResolvedValueOnce(new Response(key, {status: 400})));
  await expect(api(query)).rejects.toMatchObject({status: 401, data: {text: "[REDACTED]"}});
  await expect(api({method: "GET", path: "/series", params: {series_id: "GDP"}})).rejects.toMatchObject({status: 400, data: {text: "[REDACTED]"}});
});
it("bounds upstream bytes and rejects malformed JSON", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("x".repeat(4 * 1024 * 1024 + 1))).mockResolvedValueOnce(new Response("invalid")));
  await expect(api(query)).rejects.toThrow("4 MiB"); await expect(api(query)).rejects.toThrow("JSON");
});
function workflowPage(cursor: string | null, updated = series.last_updated) { return {data: {...page, series: [{...series, last_updated: updated}]}, series_updates: [{series_id: "SERIES_A", last_updated: updated}], paging: {has_more: cursor !== null, next_request: cursor === null ? null : {path: query.path, params: {release_id: 52, limit: 100, next_cursor: cursor}}}}; }
it("bulk recipe retains segments and returns a resumable request", async () => {
  const pages = [workflowPage("A"), workflowPage("B"), workflowPage("C")]; const local = {get: vi.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]).mockResolvedValueOnce(pages[2])};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(local)).toMatchObject({pages, next_request: {params: {next_cursor: "C"}}, complete: false});
});
it("bulk recipe flags a series revision and preserves both conflicting pages", async () => {
  const pages = [workflowPage("A"), workflowPage("B", "2025-09-13T00:00:00Z")]; const local = {get: vi.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1])};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(local)).toMatchObject({pages, restart_required: true, changed_series: "SERIES_A", complete: false});
});
it("bulk recipe preserves staging handles if control recovery is unavailable", async () => {
  const handle = {__staged: true, data_access_id: "release"}; const local = {get: vi.fn().mockResolvedValue(handle)};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(local)).toMatchObject({pages: [], pending_page: handle, complete: false}); expect(local.get).toHaveBeenCalledTimes(1);
});
it("as-of recipe keeps real-time dates separate from economic observation dates", async () => {
  const local = {get: vi.fn().mockResolvedValue({observations: []})};
  await new Function("api", `return (async()=>{${releaseWorkflows[1].code}})()`)(local);
  expect(local.get).toHaveBeenCalledWith("/series/observations", expect.objectContaining({realtime_start: "2025-09-01", realtime_end: "2025-09-01", observation_end: "2025-08-31", output_type: 1}));
});

const runBulk = (local: unknown, resume: unknown = null) => new Function("api", `return (async()=>{${releaseWorkflows[0].code.replace("const resume = null;", "const resume = " + JSON.stringify(resume) + ";")}})()`)(local);
it("recovers staged page controls and carries revision/cursor history across invocations", async () => {
  const pages = [workflowPage("A😀"), workflowPage("B"), workflowPage("C")];
  const get = vi.fn().mockImplementation(async () => ({__staged:true,data_access_id:String(get.mock.calls.length-1)}));
  const sqlQuery = vi.fn().mockImplementation(async (id: string, sql: string) => {
    const text = JSON.stringify(pages[Number(id)]);
    return {results: sql.includes("length(") ? [{n:Array.from(text).length}] : [{part:text}]};
  });
  const result = await runBulk({get,query:sqlQuery});
  expect(result.pages.map((page: {data_access_id: string}) => page.data_access_id)).toEqual(["0","1","2"]);
  expect(result.checkpoint).toMatchObject({release_id:52,next_request:{params:{next_cursor:"C"}},series_updates:[["SERIES_A",series.last_updated]],cursors:["A😀","B","C"]});
  const continued = {get:vi.fn().mockResolvedValue(workflowPage("D","2025-09-13T00:00:00Z"))};
  expect(await runBulk(continued,result.checkpoint)).toMatchObject({restart_required:true,changed_series:"SERIES_A",checkpoint:null});
  expect(continued.get).toHaveBeenCalledWith(query.path,expect.objectContaining({next_cursor:"C"}));
});

it("detects cursor cycles across checkpoints and rejects mismatched releases before reads", async () => {
  const resume={release_id:52,next_request:{path:query.path,params:{release_id:52,limit:100,next_cursor:"C"}},series_updates:[],cursors:["A","B","C"]};
  const local={get:vi.fn().mockResolvedValue(workflowPage("A"))};
  expect(await runBulk(local,resume)).toMatchObject({cursor_cycle:true,checkpoint:null});
  local.get.mockClear();
  await expect(runBulk(local,{...resume,release_id:53})).rejects.toThrow("Checkpoint");
  expect(local.get).not.toHaveBeenCalled();
});

it.each([0,131073])("retains the source handle when staged control size is unsupported (%s)", async n => {
  const handle={__staged:true,data_access_id:"source"};
  const local={get:vi.fn().mockResolvedValue(handle),query:vi.fn().mockResolvedValue({results:[{n}]})};
  expect(await runBulk(local)).toMatchObject({pending_page:handle,complete:false,control_error:expect.any(String),checkpoint:{next_request:{params:{release_id:52}}}});
  expect(local.get).toHaveBeenCalledTimes(1);
});

it("retains complete native evidence for invalid calendar dates", async () => {
  const invalid={...page,series:[{...series,observations:[{date:"2025-02-30",value:"0"}]}]};mock(invalid);
  await expect(api(query)).rejects.toMatchObject({status:502,data:{data:invalid,provenance:{raw_json:JSON.stringify(invalid)}}});
});
