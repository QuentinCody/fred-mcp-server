import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class FredDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        const obj = data as Record<string, unknown>;

        // Series observations — the core data response
        if (obj.observations && Array.isArray(obj.observations)) {
            return {
                tableName: "observations",
                indexes: ["date", "value"],
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
