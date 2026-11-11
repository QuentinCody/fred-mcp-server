/**
 * The commercial license profile for FRED (Federal Reserve Bank of St. Louis).
 *
 * License audit 2026-11-10: "Serve public-domain series only; filter the
 * series with third-party copyright." A reselling caller sends
 * `licenseProfile: "commercial"`; `createCommercialFredFetch` then applies the
 * rule below. Each other caller gets the adapter with no change.
 *
 * Terms, read on 2026-11-10:
 * - FRED legal notice (https://fred.stlouisfed.org/legal/): "There are three (3)
 *   types of data series copyright status you will encounter in FRED":
 *   "Public Domain: Citation requested" ("may be used without permission,
 *   provided you do not engage in any prohibited use"), "Copyrighted: Citation
 *   required" and "Copyrighted: Pre-approval required" ("these series may only
 *   be used for non-commercial educational or personal use"). A prohibited use:
 *   "Redistribute any third party's proprietary content, including any graphs,
 *   maps, images, logos, data, or datasets, for commercial use without first
 *   obtaining express written permission from the data provider."
 * - FRED API terms of use (https://fred.stlouisfed.org/docs/api/terms_of_use.html):
 *   "Data series available through the FRED® API, may be owned by third parties
 *   and subject to copyright restrictions." "Before using data series owned by
 *   third parties for anything other than your own personal use, you must
 *   contact the data owner to obtain permission." "Copyrighted series contain
 *   the word 'Copyright' in their notes." The terms do not forbid commercial
 *   use of the API itself. They require the notice `FRED_API_NOTICE`.
 *
 * Where the API states the status of a series:
 * - The tag of group `cc` ("cc = Citation & Copyright",
 *   https://fred.stlouisfed.org/docs/api/fred/tags.html) in `tags[]` of
 *   `/fred/series/tags`. The FRED series page shows the same label under Tags
 *   (GDP: "Public Domain: Citation Requested"; SP500: "Copyrighted:
 *   Pre-Approval Required").
 * - `copyright_id` of each series of `/fred/v2/release/observations`
 *   (documented example: "public domain: citation requested").
 * - `notes` of `/fred/series` (the word "Copyright").
 *
 * The rule for a reselling caller:
 * - Series values (`/series/observations`, also its ALFRED real-time and
 *   vintage selectors): the adapter first reads the `cc` tag and the notes of
 *   the series, and serves the values only for "public domain: citation
 *   requested" with no "Copyright" in the notes. Each other status, no status,
 *   and a read that fails are refused (HTTP 451) before the data request.
 * - Release-wide values (`/v2/release/observations`): each series of the page
 *   carries `copyright_id` and `notes`. The series that are not public domain
 *   are removed, and `_license_filter` gives them.
 * - `/release/tables` with observation values: refused. Without them: metadata.
 * - The documented metadata routes: served. A series record that states a
 *   copyright status gets `copyright_status`.
 * - Each other path is refused: its content is not confirmed to be metadata.
 *   GeoFRED maps (`/geofred/*`) are not reachable: the adapter reads only
 *   `https://api.stlouisfed.org/fred/*`.
 */

import { type ApiFetchFn, commercialUseRefusal } from "@bio-mcp/shared/codemode/catalog";
import { fail } from "./errors";
import { fredRead } from "./http";

type FredRequest = Parameters<ApiFetchFn>[0];
type FredResult = Awaited<ReturnType<ApiFetchFn>>;
type Refusal = ReturnType<typeof commercialUseRefusal>;

export const FRED_LEGAL_URL = "https://fred.stlouisfed.org/legal/";
export const FRED_API_TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html";
/** The notice that the FRED API terms of use require on each application. */
export const FRED_API_NOTICE =
    "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";
/** The only copyright status that this profile serves, as `normalizeCopyright` gives it. */
export const PUBLIC_DOMAIN = "public domain: citation requested";
export const COPYRIGHT_STATUS_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 500;
const STATUS_READ = { timeoutMs: 15_000, maxBytes: 512 * 1024 };

/**
 * The documented FRED API v1 routes whose responses have no series values.
 * `/series/observations`, `/release/tables` and `/v2/release/observations`
 * have their own rules. A path that is not here is refused.
 */
export const METADATA_ROUTES: ReadonlySet<string> = new Set([
    "/category", "/category/children", "/category/related", "/category/series", "/category/tags", "/category/related_tags",
    "/releases", "/releases/dates", "/release", "/release/dates", "/release/series", "/release/sources", "/release/tags",
    "/release/related_tags",
    "/series", "/series/categories", "/series/release", "/series/search", "/series/search/tags",
    "/series/search/related_tags", "/series/tags", "/series/updates", "/series/vintagedates",
    "/sources", "/source", "/source/releases",
    "/tags", "/related_tags", "/tags/series",
]);
export const SERIES_VALUES_ROUTE = "/series/observations";
export const RELEASE_VALUES_ROUTE = "/v2/release/observations";
export const RELEASE_TABLES_ROUTE = "/release/tables";
const SERIES_ID = /^[A-Za-z0-9_]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
const shown = (value: string) => JSON.stringify(value.slice(0, 120));
const statesCopyright = (notes: unknown) => typeof notes === "string" && /copyright/i.test(notes);

/** Lower case, one space between words: "Public Domain:  Citation Requested" gives `PUBLIC_DOMAIN`. */
export function normalizeCopyright(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim().replace(/\s+/g, " ").toLowerCase();
    return text || undefined;
}

/** The copyright status of one series, added to a served result as `copyright_status`. */
export interface CopyrightStatus {
    series_id: string;
    /** The `cc` tag name or `copyright_id` that FRED states. Null: FRED states none, or the read failed. */
    status: string | null;
    public_domain: boolean;
    /** Why the series is not public domain. Absent when it is. */
    reason?: string;
    field: string;
    sources: string[];
    terms: string;
    notice: string;
}

function status(seriesId: string, values: Partial<CopyrightStatus>): CopyrightStatus {
    return {
        series_id: seriesId, status: null, public_domain: false, field: "tags[group_id=cc].name of /fred/series/tags; notes of /fred/series",
        sources: [], terms: FRED_LEGAL_URL, notice: FRED_API_NOTICE, ...values,
    };
}

/** A part of the status. `unreadable`: the response does not establish a status, so it is not cached. */
type Finding = Partial<CopyrightStatus> & { unreadable?: boolean };

function tagStatus(data: Record<string, unknown>): Finding {
    const tags = data.tags;
    if (!Array.isArray(tags)) return { reason: "the tag list of the series has an unexpected shape", unreadable: true };
    if (typeof data.count === "number" && data.count > tags.length) return { reason: "the tag list of the series is not complete", unreadable: true };
    const names = tags.filter(isRecord).filter((tag) => tag.group_id === "cc").map((tag) => normalizeCopyright(tag.name));
    if (names.length === 0) return { reason: "FRED states no copyright status (no tag of group cc) for the series" };
    if (names.some((name) => name === undefined) || new Set(names).size > 1) {
        return { reason: `FRED states more than one copyright status for the series (${names.join("; ")})` };
    }
    const name = names[0] as string;
    return name === PUBLIC_DOMAIN ? { status: name, public_domain: true } : { status: name, reason: `the copyright status of the series is ${shown(name)}` };
}

function seriesRecordStatus(seriesId: string, data: Record<string, unknown>): Finding | undefined {
    const records = Array.isArray(data.seriess) ? data.seriess.filter(isRecord) : [];
    const matches = records.filter((record) => typeof record.id === "string" && record.id.toUpperCase() === seriesId.toUpperCase());
    if (matches.length !== 1) return { reason: "the series record does not identify exactly this series", unreadable: true };
    const [record] = matches;
    if (statesCopyright(record.notes)) return { reason: "the notes of the series contain the word \"Copyright\"" };
    const stated = normalizeCopyright(record.copyright_id);
    if (record.copyright_id !== undefined && stated !== PUBLIC_DOMAIN) {
        return { status: stated ?? null, reason: `the series record states the copyright status ${shown(String(record.copyright_id))}` };
    }
    return undefined;
}

/**
 * Read the copyright status of a series from FRED: the `cc` tag of
 * `/fred/series/tags` and the notes of `/fred/series`. Public domain only when
 * the two agree. Each failure gives `public_domain: false` with a reason.
 */
export async function readCopyrightStatus(seriesId: string, apiKey?: string): Promise<CopyrightStatus & { readable: boolean }> {
    let tags: Awaited<ReturnType<typeof fredRead>>;
    let series: Awaited<ReturnType<typeof fredRead>>;
    try {
        [tags, series] = await Promise.all([
            fredRead("/series/tags", { series_id: seriesId }, { apiKey, ...STATUS_READ }),
            fredRead("/series", { series_id: seriesId }, { apiKey, ...STATUS_READ }),
        ]);
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return { ...status(seriesId, { reason: `the copyright status of the series could not be read (${message.slice(0, 200)})` }), readable: false };
    }
    const sources = [tags.provenance.source_url, series.provenance.source_url];
    const { unreadable: tagsUnreadable, ...fromTags } = tagStatus(tags.data);
    const fromRecord = seriesRecordStatus(seriesId, series.data);
    const readable = !tagsUnreadable && !fromRecord?.unreadable;
    if (!fromTags.public_domain || !fromRecord) return { ...status(seriesId, { ...fromTags, sources }), readable };
    // The tag says public domain, and the series record disagrees or does not identify the series.
    const { unreadable: _unreadable, ...disagreement } = fromRecord;
    return { ...status(seriesId, { ...disagreement, status: disagreement.status ?? fromTags.status, sources }), readable };
}

/** A short cache of readable statuses per series id. Failed reads are not kept. */
export class CopyrightStatusCache {
    private readonly entries = new Map<string, { at: number; value: CopyrightStatus }>();
    constructor(private readonly now: () => number = Date.now, private readonly ttlMs = COPYRIGHT_STATUS_TTL_MS) {}

    async get(seriesId: string, read: (id: string) => ReturnType<typeof readCopyrightStatus>): Promise<CopyrightStatus> {
        const entry = this.entries.get(seriesId);
        if (entry && this.now() - entry.at < this.ttlMs) return entry.value;
        this.entries.delete(seriesId);
        const { readable, ...value } = await read(seriesId);
        if (readable) {
            if (this.entries.size >= CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value as string);
            this.entries.set(seriesId, { at: this.now(), value });
        }
        return value;
    }
}

const refuse = (what: string, terms: string): Refusal => commercialUseRefusal(what, terms);

function seriesRefusal(seriesId: string, copyright: CopyrightStatus): Refusal {
    return refuse(
        `The values of FRED series ${seriesId}`,
        `${copyright.reason}. FRED (${FRED_LEGAL_URL}): "A copyright notice on a FRED series indicates other parties may have ownership rights, and you must contact the data owner to obtain permission for any use other than your own personal use." Only series with the status "Public Domain: Citation Requested" are served. The series metadata (/series, /series/search, /series/tags) stays available.`,
    );
}

/** Run a data request; on failure keep the status and the message, and drop the response body. */
async function withoutErrorBody(work: () => Promise<FredResult>): Promise<FredResult> {
    try {
        return await work();
    } catch (error) {
        const code = isRecord(error) && typeof error.status === "number" ? error.status : 502;
        return fail(error instanceof Error ? error.message : "FRED request failed", code);
    }
}

async function seriesValues(request: FredRequest, unrestricted: ApiFetchFn, statusOf: (id: string) => Promise<CopyrightStatus>): Promise<FredResult> {
    const seriesId = request.params?.series_id;
    if (typeof seriesId !== "string" || !SERIES_ID.test(seriesId)) {
        return refuse("FRED series values without a valid series_id", "the adapter reads the copyright status of one series by its id (letters, digits, underscore) before it serves values.");
    }
    const copyright = await statusOf(seriesId);
    if (!copyright.public_domain) return seriesRefusal(seriesId, copyright);
    const result = await withoutErrorBody(() => unrestricted(request));
    if (!isRecord(result.data)) return refuse(`The values of FRED series ${seriesId}`, "the response is not a JSON object, so the copyright status cannot be attached.");
    return { ...result, data: { ...result.data, copyright_status: copyright } };
}

/** The series of a v2 release page: public domain only, by the `copyright_id` and `notes` of each series. */
async function releaseValues(request: FredRequest, unrestricted: ApiFetchFn): Promise<FredResult> {
    const result = await withoutErrorBody(() => unrestricted(request));
    const page = result.data;
    const upstream = isRecord(page) && isRecord(page.data) ? page.data : undefined;
    if (!isRecord(page) || !upstream || !Array.isArray(upstream.series)) {
        return refuse("This FRED release page", "it has no series list, so the copyright status of each series cannot be checked.");
    }
    const kept: Record<string, unknown>[] = [];
    const removed: { series_id: unknown; copyright_id: unknown; observations: number }[] = [];
    const series: unknown[] = upstream.series;
    for (const item of series) {
        const record = isRecord(item) ? item : {};
        const stated = normalizeCopyright(record.copyright_id);
        if (stated === PUBLIC_DOMAIN && !statesCopyright(record.notes)) {
            kept.push({ ...record, copyright_status: { status: stated, public_domain: true, field: "copyright_id of /fred/v2/release/observations", terms: FRED_LEGAL_URL } });
        } else {
            removed.push({ series_id: record.series_id ?? null, copyright_id: record.copyright_id ?? null, observations: Array.isArray(record.observations) ? record.observations.length : 0 });
        }
    }
    const data: Record<string, unknown> = { ...page, data: { ...upstream, series: kept } };
    if (removed.length === 0) return { ...result, data };
    // The exact upstream bytes hold the values of the removed series.
    const { raw_json: _raw, ...provenance } = isRecord(page.provenance) ? page.provenance : {};
    const detail = `Series removed by the commercial license profile: ${removed.length}. FRED states no public-domain status for them.`;
    return {
        ...result,
        data: {
            ...data,
            provenance: { ...provenance, raw_json_withheld: "The exact upstream response holds the values of series that are not public domain; response_sha256 identifies it." },
            _license_filter: {
                profile: "commercial", removed: removed.length, removed_series: removed,
                reason: "Only series with copyright_id \"public domain: citation requested\" and no \"Copyright\" in their notes are served. The page is not the complete release.",
                terms: FRED_LEGAL_URL, notice: FRED_API_NOTICE,
            },
        },
        completeness: { ...result.completeness, complete: false, truncation: { reason: result.completeness?.truncation?.reason ?? "unknown", detail: [detail, result.completeness?.truncation?.detail].filter(Boolean).join(" ") } },
    };
}

/** True when a `/release/tables` request asks for observation values, or for a value that is not plainly false. */
function asksForValues(params: FredRequest["params"]): boolean {
    const flag = params?.include_observation_values;
    return flag !== undefined && flag !== false && flag !== "false";
}

/** Add `copyright_status` to each series record of a metadata response that states it. */
export function withCopyrightStatusVisible(data: unknown): unknown {
    if (!isRecord(data) || !Array.isArray(data.seriess)) return data;
    const original: unknown[] = data.seriess;
    const annotate = (record: unknown) => {
        if (!isRecord(record)) return record;
        const stated = normalizeCopyright(record.copyright_id);
        if (stated) return { ...record, copyright_status: stated };
        return statesCopyright(record.notes) ? { ...record, copyright_status: "copyrighted (the notes contain \"Copyright\")" } : record;
    };
    const seriess = original.map(annotate);
    return seriess.every((record, index) => record === original[index]) ? data : { ...data, seriess };
}

/**
 * The FRED adapter for a reselling caller. `unrestricted` is the adapter of
 * each other caller; this function can only refuse a request, remove series
 * from its result, or add the copyright status.
 */
export function createCommercialFredFetch(unrestricted: ApiFetchFn, apiKey?: string, cache = new CopyrightStatusCache()): ApiFetchFn {
    const statusOf = (seriesId: string) => cache.get(seriesId, (id) => readCopyrightStatus(id, apiKey));
    return async (request) => {
        // The unrestricted adapter refuses these before any request.
        if (request.method !== "GET" || request.body !== undefined) return unrestricted(request);
        const route = request.path;
        if (route === SERIES_VALUES_ROUTE) return seriesValues(request, unrestricted, statusOf);
        if (route === RELEASE_VALUES_ROUTE) return releaseValues(request, unrestricted);
        if (route === RELEASE_TABLES_ROUTE && asksForValues(request.params)) {
            return refuse("FRED release tables with observation values", "the elements carry series values with no copyright status. Request the table without include_observation_values, then read each public-domain series through /series/observations.");
        }
        if (route === RELEASE_TABLES_ROUTE || METADATA_ROUTES.has(route)) {
            const result = await unrestricted(request);
            return { ...result, data: withCopyrightStatusVisible(result.data) };
        }
        return refuse(`The FRED path ${shown(route)}`, "it is not a documented FRED metadata route, so the adapter cannot confirm that it returns no values of copyrighted series.");
    };
}
