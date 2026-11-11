import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function unwrap(value: unknown): unknown {
    return record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent
        ? value.structuredContent.data : value;
}
function isReleasePage(value: unknown): value is Record<string, unknown> & {data: {series: Record<string, unknown>[]}} {
    return record(value) && record(value.data) && Array.isArray(value.data.series) && record(value.paging) && Array.isArray(value.series_updates);
}

export class FredDataDO extends RestStagingDO {
    protected getTabularData(value: unknown): unknown {
        const data = unwrap(value);
        if (record(data) && typeof data.sql === "string" && Array.isArray(data.rows)) {
            return {query_rows: data.rows.map((native, row_index) => ({row_index, native_json: JSON.stringify(native)}))};
        }
        if (isReleasePage(data)) {
            const observations: Record<string, unknown>[] = [];
            const fred_series = data.data.series.map((series, series_index) => {
                if (Array.isArray(series.observations)) series.observations.forEach((native, observation_index) => {
                    observations.push({series_index, observation_index, series_id: series.series_id,
                        ...(record(native) ? {date: native.date, value: native.value} : {}), native_json: JSON.stringify(native)});
                });
                return {series_index, series_id: series.series_id, last_updated: series.last_updated, native_json: JSON.stringify(series)};
            });
            return {observations, fred_series, fred_page: [{page_index: 0,
                control_json: JSON.stringify({paging: data.paging, series_updates: data.series_updates})}]};
        }
        if (record(data) && Array.isArray(data.observations)) {
            return {...data, observations: data.observations.map((native, mcp_source_index) => {
                const row: Record<string, unknown> = {mcp_source_index, mcp_native_json: JSON.stringify(native)};
                const names = new Set(["_rowid", ...Object.keys(row)]);
                for (const [key, value] of Object.entries(record(native) ? native : {})) {
                    if (value !== null && typeof value === "object" || names.has(key.toLowerCase())) continue;
                    names.add(key.toLowerCase()); row[key] = value;
                }
                return row;
            })};
        }
        return data;
    }

    protected getSchemaHints(value: unknown): SchemaHints | undefined {
        const data = unwrap(value);
        if (isReleasePage(data)) return {columnTypes: {native_json: "TEXT", control_json: "TEXT", date: "TEXT", value: "TEXT", series_id: "TEXT", last_updated: "TEXT"}};
        if (!data || typeof data !== "object") return undefined;

        const obj = data as Record<string, unknown>;

        // Series observations — the core data response
        if (obj.observations && Array.isArray(obj.observations)) {
            return {
                tableName: "observations",
                indexes: ["mcp_source_index"],
                columnTypes: {value: "TEXT", date: "TEXT", realtime_start: "TEXT", realtime_end: "TEXT", mcp_native_json: "TEXT"},
            };
        }

        // Series metadata
        if (obj.seriess && Array.isArray(obj.seriess)) {
            return {
                tableName: "series_metadata",
                indexes: ["id", "title", "frequency"],
            };
        }

        // Search results
        if (obj.seriess && obj.count) {
            return {
                tableName: "search_results",
                indexes: ["id", "title"],
            };
        }

        // Release data
        if (obj.releases && Array.isArray(obj.releases)) {
            return {
                tableName: "releases",
                indexes: ["id", "name"],
            };
        }

        // Release dates
        if (obj.release_dates && Array.isArray(obj.release_dates)) {
            return {
                tableName: "release_dates",
                indexes: ["release_id", "date"],
            };
        }

        // Category data
        if (obj.categories && Array.isArray(obj.categories)) {
            return {
                tableName: "categories",
                indexes: ["id", "name", "parent_id"],
            };
        }

        // Tags
        if (obj.tags && Array.isArray(obj.tags)) {
            return {
                tableName: "tags",
                indexes: ["name", "group_id"],
            };
        }

        // Sources
        if (obj.sources && Array.isArray(obj.sources)) {
            return {
                tableName: "sources",
                indexes: ["id", "name"],
            };
        }

        return undefined;
    }
}
