import { afterEach, expect, it, vi } from "vitest";
import { fredRead } from "./http";
import { createFredApiFetch } from "./api-adapter";
const apiKey = "fixture-key-not-real";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("retains exact UTF-8/BOM source bytes and literal query values", async () => {
  const raw = '\uFEFF{"feed":[],"text":"α😀"}\r\n';
  const bytes = new TextEncoder().encode(raw);
  const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
  }})));
  vi.stubGlobal("fetch", fetcher);
  const result = await fredRead("/v2/release/observations", {next_cursor:"A+B,FOREX:USD"}, {apiKey});
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  expect(result.provenance).toMatchObject({ raw_json: raw, response_bytes: bytes.length, redacted: false,
    response_sha256: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("") });
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("next_cursor")).toBe("A+B,FOREX:USD");
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:"manual"});
  expect(JSON.stringify(result)).not.toContain(apiKey);
});

it.each([302,401,429,503,206])("preserves bounded native HTTP %i evidence without replay", async status => {
  const text = "native failure α".repeat(3000);
  const fetcher=vi.fn().mockResolvedValue(new Response(text,{status,headers:{"retry-after":"60"}}));
  vi.stubGlobal("fetch",fetcher);
  await expect(fredRead("/v2/release/observations",{}, {apiKey})).rejects.toMatchObject({status,data:{text,retry_after:"60",provenance:{raw_json:text,response_sha256:expect.any(String)}}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects byte fragments even with successful status",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("{}",{headers:{"content-range":"bytes 0-1/100"}})));
  await expect(fredRead("/v2/release/observations",{}, {apiKey})).rejects.toMatchObject({status:502,data:{text:"{}"}});
});

it.each([true,false])("bounds bytes with or without declared length (%s)",async declared=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("α".repeat(10),{headers:declared?{"content-length":"20"}:{}})));
  await expect(fredRead("/v2/release/observations",{}, {apiKey,maxBytes:19})).rejects.toThrow("byte limit");
});

it("rejects malformed UTF-8",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(new Uint8Array([0xc0,0xaf]))));
  await expect(fredRead("/v2/release/observations",{}, {apiKey})).rejects.toThrow("UTF-8");
});

it.each(["headers","body"])("enforces the deadline during %s even when abort/cancel do not settle",async phase=>{
  vi.useFakeTimers(); const cancel=vi.fn(()=>new Promise<void>(()=>{}));
  const fetcher=vi.fn().mockImplementation(()=>phase==="headers"?new Promise(()=>{}):Promise.resolve(new Response(new ReadableStream({cancel}))));
  vi.stubGlobal("fetch",fetcher);
  const promise=expect(fredRead("/v2/release/observations",{}, {apiKey,timeoutMs:50})).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(51); await promise;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  if(phase==="body")expect(cancel).toHaveBeenCalled();
});

it("disposes a response arriving after the header deadline",async()=>{
  vi.useFakeTimers();const cancel=vi.fn();let finish:(response:Response)=>void=()=>{};
  vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve})));
  const pending=expect(fredRead("/v2/release/observations",{}, {apiKey,timeoutMs:50})).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(51);await pending;
  finish(new Response(new ReadableStream({cancel})));await Promise.resolve();await Promise.resolve();
  expect(cancel).toHaveBeenCalled();
});

it("redacts echoed keys and preserves original-byte hash scope",async()=>{
  const secret='fixture+key/"value';const raw=JSON.stringify({error_message:"Failure α ".repeat(4000)+secret+encodeURIComponent(secret)});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw,{status:429})));
  const error=await fredRead("/v2/release/observations",{}, {apiKey:secret}).catch(error=>error);
  expect(error).toMatchObject({status:429,data:{provenance:{redacted:true,response_bytes:new TextEncoder().encode(raw).length}}});
  expect(error.data.text.length).toBeGreaterThan(30000);expect(error.data.text).toContain("[REDACTED]");
  expect(JSON.stringify(error.data)).not.toContain(encodeURIComponent(secret));
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
  expect(error.data.provenance.response_sha256).toBe(Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,"0")).join(""));
});
it("keeps v1 vintage metadata, raw tokens and colliding native metadata",async()=>{
  const raw='{"observations":[{"date":"2025-01-01","value":"9007199254740993.00","realtime_start":"2025-09-01"}],"_mcp":{"native":true},"unknown":9007199254740993}';
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw)));
  const result=await createFredApiFetch(apiKey)({method:"GET",path:"/series/observations",params:{series_id:"GDP",realtime_start:"2025-09-01",realtime_end:"2025-09-01"}});
  expect(result).toMatchObject({upstreamTotal:null,completeness:{complete:false},data:{_mcp:{provenance:{raw_json:raw,api_version:"1"}}}});
});
it("rejects credentials, non-scalar parameters, non-JSON and foreign paths before fetch",async()=>{
  const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
  for(const params of [{api_key:"key"},{APIKEY:"key"},{authorization:"key"},{limit:Number.NaN},{series_id:["A"]},{file_type:"xml"}]) await expect(fredRead("/series",params,{apiKey})).rejects.toThrow();
  for(const path of ["https://evil.test/series","//evil.test/series","/series/../observations","/series?api_key=bad"]) await expect(fredRead(path,{}, {apiKey})).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("surfaces HTTP-200 FRED error envelopes",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('{"error_code":400,"error_message":"invalid release"}')));
  await expect(fredRead("/v2/release/observations",{}, {apiKey})).rejects.toMatchObject({status:502,data:{upstream_http_status:200}});
});
it("forwards the documented 2000 JSON vintage dates without an arbitrary shorter scalar limit",async()=>{
  const vintage_dates=Array.from({length:2000},(_,i)=>new Date(Date.UTC(2000,0,1+i)).toISOString().slice(0,10)).join(",");
  const fetcher=vi.fn().mockResolvedValue(new Response('{"observations":[]}'));vi.stubGlobal("fetch",fetcher);
  await fredRead("/series/observations",{series_id:"GDP",output_type:2,vintage_dates},{apiKey});
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("vintage_dates")).toBe(vintage_dates);
});
it.each(["null","[]","1","<html>verification page</html>"])("rejects non-object/JSON success %s",async raw=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(raw)));
  await expect(fredRead("/v2/release/observations",{}, {apiKey})).rejects.toMatchObject({status:502,data:{text:raw}});
});
