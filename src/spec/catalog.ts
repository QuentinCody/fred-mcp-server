import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const fredCatalog: ApiCatalog = {
    name: "FRED (Federal Reserve Economic Data)",
    baseUrl: "https://api.stlouisfed.org/fred",
    version: "1.0",
    auth: "required",
    endpointCount: 15,
    notes:
        "- All requests require api_key and file_type=json params (auto-injected)\n" +
        "- Core endpoint: /series/observations — returns {observations: [{date, value}]}\n" +
        "- Popular series IDs: GDP, CPIAUCSL, UNRATE, FEDFUNDS, DGS10, DGS2, T10Y2Y,\n" +
        "  MORTGAGE30US, SP500, DEXUSEU, WTISPLC, M2SL, HOUST, RSXFS, PAYEMS\n" +
        "- Use observation_start/observation_end (YYYY-MM-DD) to filter date ranges\n" +
        "- frequency param: d (daily), w (weekly), bw, m (monthly), q (quarterly), sa, a (annual)\n" +
        "- units param: lin (levels), chg (change), ch1 (change from year ago),\n" +
        "  pch (% change), pc1 (% change from year ago), pca (compounded annual % change),\n" +
        "  cch (continuously compounded rate of change), log (natural log)\n" +
        "- Search supports order_by: search_rank, series_id, title, units, frequency,\n" +
        "  seasonal_adjustment, realtime_start, realtime_end, last_updated, observation_start,\n" +
        "  observation_end, popularity, group_popularity",
    endpoints: [
        // --- Series ---
        {
            method: "GET",
            path: "/series/observations",
            summary: "Get data points for a series. The core FRED data endpoint. Returns {observations: [{date, value}]}",
            category: "series",
            queryParams: [
                { name: "series_id", type: "string", required: true, description: "FRED series ID (e.g. GDP, UNRATE, FEDFUNDS)" },
                { name: "observation_start", type: "string", required: false, description: "Start date YYYY-MM-DD" },
                { name: "observation_end", type: "string", required: false, description: "End date YYYY-MM-DD" },
                { name: "frequency", type: "string", required: false, description: "Frequency aggregation: d, w, bw, m, q, sa, a" },
                { name: "units", type: "string", required: false, description: "Data transformation: lin, chg, ch1, pch, pc1, pca, cch, log" },
                { name: "sort_order", type: "string", required: false, description: "asc or desc", default: "asc" },
                { name: "limit", type: "number", required: false, description: "Max observations (max 100000)", default: 100000 },
            ],
        },
        {
            method: "GET",
            path: "/series",
            summary: "Get metadata for a series (title, units, frequency, seasonal adjustment, notes)",
            category: "series",
            queryParams: [
                { name: "series_id", type: "string", required: true, description: "FRED series ID" },
            ],
        },
        {
            method: "GET",
            path: "/series/search",
            summary: "Full-text search for FRED series by keyword. Returns matching series with metadata",
            category: "series",
            queryParams: [
                { name: "search_text", type: "string", required: true, description: "Search query (e.g. 'unemployment rate')" },
                { name: "search_type", type: "string", required: false, description: "full_text or series_id", default: "full_text" },
                { name: "order_by", type: "string", required: false, description: "Sort field: search_rank, series_id, title, popularity, etc." },
                { name: "limit", type: "number", required: false, description: "Max results (max 1000)", default: 100 },
                { name: "offset", type: "number", required: false, description: "Pagination offset" },
            ],
        },
        {
            method: "GET",
            path: "/series/updates",
            summary: "Recently updated FRED series",
            category: "series",
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max results", default: 100 },
                { name: "offset", type: "number", required: false, description: "Pagination offset" },
                { name: "filter_value", type: "string", required: false, description: "Filter: macro, regional, all" },
            ],
        },
        {
            method: "GET",
            path: "/series/vintagedates",
            summary: "Revision history dates — when data was originally published vs revised",
            category: "series",
            queryParams: [
                { name: "series_id", type: "string", required: true, description: "FRED series ID" },
                { name: "limit", type: "number", required: false, description: "Max results", default: 10000 },
                { name: "sort_order", type: "string", required: false, description: "asc or desc", default: "asc" },
            ],
        },
        {
            method: "GET",
            path: "/series/categories",
            summary: "Categories a series belongs to",
            category: "series",
            queryParams: [
                { name: "series_id", type: "string", required: true, description: "FRED series ID" },
            ],
        },
        {
            method: "GET",
            path: "/series/tags",
            summary: "Tags assigned to a series",
            category: "series",
            queryParams: [
                { name: "series_id", type: "string", required: true, description: "FRED series ID" },
            ],
        },
        // --- Releases ---
        {
            method: "GET",
            path: "/releases",
            summary: "List all FRED data releases",
            category: "releases",
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
                { name: "offset", type: "number", required: false, description: "Pagination offset" },
                { name: "order_by", type: "string", required: false, description: "Sort: release_id, name, press_release" },
            ],
        },
        {
            method: "GET",
            path: "/releases/dates",
            summary: "Release dates — upcoming = economic calendar. Shows when data will be published",
            category: "releases",
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
                { name: "offset", type: "number", required: false, description: "Pagination offset" },
                { name: "order_by", type: "string", required: false, description: "Sort: release_date, release_id, release_name" },
                { name: "sort_order", type: "string", required: false, description: "asc or desc", default: "asc" },
                { name: "include_release_dates_with_no_data", type: "string", required: false, description: "true or false" },
            ],
        },
        {
            method: "GET",
            path: "/release/series",
            summary: "All series in a specific release",
            category: "releases",
            queryParams: [
                { name: "release_id", type: "number", required: true, description: "Release ID" },
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
            ],
        },
        // --- Categories ---
        {
            method: "GET",
            path: "/category",
            summary: "Get a category by ID",
            category: "categories",
            queryParams: [
                { name: "category_id", type: "number", required: true, description: "Category ID (root = 0)" },
            ],
        },
        {
            method: "GET",
            path: "/category/children",
            summary: "Child categories of a parent category",
            category: "categories",
            queryParams: [
                { name: "category_id", type: "number", required: true, description: "Parent category ID" },
            ],
        },
        {
            method: "GET",
            path: "/category/series",
            summary: "All series in a category",
            category: "categories",
            queryParams: [
                { name: "category_id", type: "number", required: true, description: "Category ID" },
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
                { name: "order_by", type: "string", required: false, description: "Sort: series_id, title, popularity" },
            ],
        },
        // --- Tags ---
        {
            method: "GET",
            path: "/tags",
            summary: "List all FRED tags",
            category: "tags",
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
                { name: "order_by", type: "string", required: false, description: "Sort: series_count, popularity, created, name, group_id" },
            ],
        },
        // --- Sources ---
        {
            method: "GET",
            path: "/sources",
            summary: "List all data sources that provide FRED series",
            category: "sources",
            queryParams: [
                { name: "limit", type: "number", required: false, description: "Max results", default: 1000 },
                { name: "order_by", type: "string", required: false, description: "Sort: source_id, name, realtime_start" },
            ],
        },
    ],
};
