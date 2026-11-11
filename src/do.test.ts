/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { FredDataDO } from "./do";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
async function store(data: unknown) {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  let ready: Promise<unknown> = Promise.resolve();
  const exec = (sql: string, ...args: SQLInputValue[]) => {
    const rows = database.prepare(sql).all(...args);
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  const ctx = { blockConcurrencyWhile: (run: () => Promise<unknown>) => { ready = run(); return ready; },
    storage: { sql: { exec }, transactionSync: (run: () => unknown) => {
      database.exec("BEGIN"); try { const result = run(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } } };
  // This test fixture implements only the Durable Object storage interfaces used here.
  const instance = new FredDataDO(ctx as unknown as ConstructorParameters<typeof FredDataDO>[0], {} as ConstructorParameters<typeof FredDataDO>[1]);
  await ready;
  const result = await instance.fetch(new Request("https://fixture/process", { method: "POST", body: JSON.stringify({ data }) }));
  expect(await result.json()).toMatchObject({ success: true });
  return database;
}

const observations = [{date:"2025-01-01",value:".",_rowid:7,extra:{keep:[1,"2",null]}},{date:"2025-04-01",value:"9007199254740993.0100",_rowid:7}];
const series = [{series_id:"A",last_updated:"2025-09-01T00:00:00Z",units:"Native unit",observations}];
const page = {data:{release:{release_id:52},series},series_updates:[{series_id:"A",last_updated:series[0].last_updated}],paging:{has_more:true,next_request:{path:"/v2/release/observations",params:{release_id:52,next_cursor:"A,2025-07-01"}}}};
it("materializes v2 source segments, exact observation strings and page controls", async()=>{
 const database=await store(page);
 const rows=database.prepare("SELECT series_index,observation_index,series_id,date,value,native_json FROM observations ORDER BY series_index,observation_index").all();
 expect(rows.map(row=>JSON.parse(String(row.native_json)))).toEqual(observations);
 expect(rows.map(row=>row.value)).toEqual([".","9007199254740993.0100"]);
 expect(database.prepare("SELECT series_index,series_id FROM fred_series").all()).toEqual([{series_index:0,series_id:"A"}]);
 expect(database.prepare("SELECT native_json FROM fred_series").all().map(row=>JSON.parse(String(row.native_json)))).toEqual(series);
 const metadata=database.prepare("SELECT control_json FROM fred_page WHERE page_index=0").get();
 expect(JSON.parse(String(metadata?.control_json))).toEqual({paging:page.paging,series_updates:page.series_updates});
});
it("preserves v1 real-time fields, repeated rows and original scalar types",async()=>{
 const native=[{...observations[1],realtime_start:"2025-09-01",realtime_end:"2025-09-01"},{...observations[1],value:"0.0000",realtime_start:"2025-09-02",realtime_end:"2025-09-02"}];
 const database=await store({observations:native});
 const rows=database.prepare("SELECT mcp_source_index,mcp_native_json,value,realtime_start,realtime_end FROM observations ORDER BY mcp_source_index").all();
 expect(rows.map(row=>JSON.parse(String(row.mcp_native_json)))).toEqual(native);
 expect(rows.map(row=>[row.value,row.realtime_start,row.realtime_end])).toEqual(native.map(row=>[row.value,row.realtime_start,row.realtime_end]));
});
it("materializes full result envelopes and collision-safe restaged SQL",async()=>{
 const database=await store({content:[],structuredContent:{success:true,data:page}});
 expect(database.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({n:2});
 const rows=[{_rowid:7,value:"0.0100"},{_rowid:7,value:null}];
 const second=await store({content:[],structuredContent:{success:true,data:{rows,sql:"SELECT * FROM observations"}}});
 expect(second.prepare("SELECT native_json FROM query_rows ORDER BY row_index").all().map(row=>JSON.parse(String(row.native_json)))).toEqual(rows);
});
