import {afterEach, expect, it, vi} from "vitest";
import {McpServer} from "@bio-mcp/shared/mcp";
import {createApiProxyTool} from "@bio-mcp/shared/tools/api-proxy";
import {registerCodeMode} from "./code-mode";
import {registerGetSchema} from "./get-schema";
import {registerQueryData} from "./query-data";
import {fredCatalog} from "../spec/catalog";
import {releaseWorkflows} from "../spec/release-workflows";
import {createFredApiFetch} from "../lib/api-adapter";
const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {"content-type": "application/json"}});
afterEach(() => vi.unstubAllGlobals());
it("registers both aliases and returns both fields on keyless errors", async () => {
  const server = new McpServer({name: "fixture", version: "1"});
  registerCodeMode(server, {CODE_MODE_LOADER: {get: () => ({})}} as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  const tools = (server as unknown as {_registeredTools: Record<string, {handler: (args: unknown, extra: unknown) => Promise<unknown>}>})._registeredTools;
  for (const suffix of ["search", "execute", "query_data", "get_schema"]) { expect(tools[`fred_${suffix}`]).toBeDefined(); expect(tools[`mcp_fred_${suffix}`]).toBeDefined(); }
  expect(await tools.fred_search.handler({query: "release", category: "workflows", max_results: 5}, {})).toMatchObject({content: expect.any(Array), structuredContent: {success: true}});
  expect(await tools.mcp_fred_query_data.handler({data_access_id: "fred_fixture", sql: "SELECT 1"}, {})).toMatchObject({isError: true, content: expect.any(Array), structuredContent: expect.any(Object)});
});
it("stages the complete release metadata, string values and continuation context", async () => {
  const raw = {has_more: true, next_cursor: "GDP,2025-04-01", release: {release_id: 53, name: "GDP"}, series: [{series_id: "GDP", last_updated: "2025-09-01T00:00:00Z", notes: "α".repeat(20000), copyright_id: "source terms", observations: [{date: "2025-01-01", value: "."}]}]};
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json(raw)));
  const stored: unknown[] = [];
  const namespace = {idFromName: (name: string) => name, get: () => ({fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as {data: unknown}).data);
      return json({success: true, tables_created: ["observations"], total_rows: 1, input_rows: 1, table_row_counts: {observations: 1}});
    }
    return json({success: true, schema: {tables: {observations: {columns: [{name: "value"}]}}}});
  }})} as unknown as DurableObjectNamespace;
  const proxy = createApiProxyTool({apiFetch: createFredApiFetch("fixture-key"), catalog: fredCatalog, doNamespace: namespace, stagingPrefix: "fred", maxInlineBytes: 30 * 1024});
  expect(await proxy.handler({method: "GET", path: "/v2/release/observations", params: {release_id: 53}}, {sql: () => []})).toMatchObject({__staged: true, data_access_id: expect.any(String)});
  expect(JSON.parse(stored[0] as string)).toMatchObject({data: raw, paging: {next_request: {params: {release_id: 53, next_cursor: raw.next_cursor}}}, provenance: {vintage_date: null}});
  expect(JSON.stringify(stored)).not.toContain("fixture-key");
});
it.each([{__api_error: true}, {__stage_error: true}])("bulk recipe preserves failure handle %#", async handle => {
  const api = {get: vi.fn().mockResolvedValue(handle)};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(api)).toMatchObject({pending_page: handle, complete: false}); expect(api.get).toHaveBeenCalledTimes(1);
});
it("bulk recipe detects a multi-page cursor cycle", async () => {
  const page = (cursor: string) => ({series_updates: [], paging: {has_more: true, next_request: {path: "/v2/release/observations", params: {release_id: 52, next_cursor: cursor}}}});
  const api = {get: vi.fn().mockResolvedValueOnce(page("A")).mockResolvedValueOnce(page("B")).mockResolvedValueOnce(page("A"))};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(api)).toMatchObject({cursor_cycle: true, complete: false});
});
it("cursor exhaustion does not imply an atomic snapshot", async () => {
  const api = {get: vi.fn().mockResolvedValue({series_updates: [], paging: {has_more: false, next_request: null}})};
  expect(await new Function("api", `return (async()=>{${releaseWorkflows[0].code}})()`)(api)).toMatchObject({cursor_exhausted: true, atomic_snapshot_verified: false});
});
