# FRED MCP server

`fred_search` discovers the catalog and workflows; `fred_execute` runs Code Mode.
`fred_query_data` and `fred_get_schema` inspect staged data. All four tools have
`mcp_fred_` aliases. Configure `FRED_API_KEY` on the Worker; credentials are scoped
to its adapter and are not accepted as Code Mode query parameters.

## Release observations (local additions, 2026-09-28)

`GET /v2/release/observations` uses the [FRED v2 bulk endpoint](https://fred.stlouisfed.org/docs/api/fred/v2/release_observations.html).
It authenticates with a bearer header, while the existing v1 endpoints continue
using their documented query-key authentication. Source URLs and v2 provenance
contain no credentials. Both versions use single-attempt bounded reads with a
50-second deadline covering headers and body, strict UTF-8/JSON decoding and a
4 MiB cap. Redirects, partial HTTP/Content-Range and provider error envelopes fail
explicitly. Bounded native error text and Retry-After are retained; echoed keys
are redacted with an explicit flag. Byte hashes/counts describe the original
response, while retained text reflects any redaction. No implicit retry.

```js
return await api.get("/v2/release/observations", {release_id: 52, limit: 1000});
```

The result keeps the complete native page in `data`, a `series_updates` list and
`paging.next_request`. Pass that request's parameters on the next call. A series
can continue on a subsequent page: retain each segment instead of overwriting
its earlier observations. Series units, frequency, seasonal adjustment, source
and copyright metadata survive unchanged. Values remain strings, preserving
precision and the `"."` missing marker.

The adapter defaults to 1,000 observations and accepts 1–10,000 per page, with a
4 MiB/50-second response bound. The provider supports larger pages; smaller MCP
pages make staging and resumable retrieval practical. JSON is the exposed format.
Large responses stage above 30 KiB, including cursor and source context. If a
page stages, the recipe reads its control metadata through SQL before continuing.

The catalog includes a three-page recipe with continuation, cursor-cycle checks
and detection of changed `last_updated` values when a series recurs. FRED warns
that releases can update during retrieval; restart if an update is detected.
No stable cross-page snapshot is promised, even when the cursor is exhausted.
The recipe returns a `checkpoint` containing the next request, all observed
series timestamps and previously seen cursors. Replace its `const resume = null`
with that checkpoint on the next invocation. Persist prior page handles too;
each invocation returns its new pages. A changed timestamp or cursor cycle
returns an explicit restart/failure result. A failed SQL control read preserves
the pending source handle and current checkpoint instead of advancing. Control
reads use 4,000-character slices with a 131,072-character bound.

V2 staging exposes `observations(series_index, observation_index, series_id,
date, value, native_json)`, `fred_series(series_index, series_id, last_updated,
native_json)` and `fred_page(page_index, control_json)`. Full native records,
units, notes, source/copyright context and unknown fields remain recoverable;
`provenance.raw_json` keeps exact source text, including BOM and line endings.
Original JSON numeric tokens survive there; parsed numbers retain JavaScript's
precision limits. V1 adds `_mcp.provenance` and conservative coverage metadata,
and stages ordered `mcp_native_json` observation rows alongside scalar columns.

```sql
SELECT series_index, observation_index, series_id, date, value, native_json
FROM observations
ORDER BY series_index, observation_index
LIMIT 25 OFFSET 0
```

Full MCP envelopes and large SQL/error responses stage above 30 KiB with SDK
headroom and verifiable citations through both aliases. `payloads` independently
retains the complete response; large text uses `content_chunks`. SQL restaging
exposes ordered `query_rows(row_index, native_json)`. Inspect schema and use
bounded batches/slices. Source coverage remains conservative after composition.

## Revision and as-of semantics

V2 supplies current historical observations; it does **not** expose all revision
vintages. Use the existing v1 `/series/observations` with explicit real-time
periods or vintage dates for [as-of research](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html).
The catalog now exposes `realtime_start`, `realtime_end`, `vintage_dates`,
`output_type`, pagination and aggregation parameters.

```js
return await api.get("/series/observations", {
  series_id: "GDP", realtime_start: "2025-09-01", realtime_end: "2025-09-01",
  observation_start: "2020-01-01", observation_end: "2025-08-31",
  output_type: 1, units: "lin", limit: 1000, offset: 0
});
```

Retain both real-time and observation dates, which describe different things.
Day-level vintages do not prove intraday publication/availability. v2 rejects
v1-only vintage parameters instead of silently presenting current values as
historical knowledge.

## Validation

Local fixtures cover v2 header authentication, credential isolation, schema and
cursor failures, precision/missing values, revision detection and staging.
Fixtures are derived from documented contracts, not authenticated captures.
TypeScript, lint and dry bundling pass. Actual MCP HTTP/Node SQLite replay covers
multi-page staging, checkpoint resumption, revisions/cycles and v1 as-of records;
local JavaScript substitutes for isolate execution. Authenticated provider
validation, complete native release traversal and edited Workerd acceptance
remain pending. The transport permits the documented 2,000 JSON vintage dates
within a 32,000-character encoded URL bound; provider acceptance is unverified.
See the [review](../../../../docs/audits/2026-10-06-fred-response-review.md).
These additions have not been deployed.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from FRED / ALFRED and stays under the terms of that source: Many series third-party copyrighted.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
