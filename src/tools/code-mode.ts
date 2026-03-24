import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { fredCatalog } from "../spec/catalog";
import { createFredApiFetch, setFredApiKey } from "../lib/api-adapter";

interface CodeModeEnv {
    FRED_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
    FRED_API_KEY?: string;
}

export function registerCodeMode(server: McpServer, env: CodeModeEnv) {
    if (env.FRED_API_KEY) {
        setFredApiKey(env.FRED_API_KEY);
    }

    const apiFetch = createFredApiFetch();

    const searchTool = createSearchTool({
        prefix: "fred",
        catalog: fredCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "fred",
        catalog: fredCatalog,
        apiFetch,
        doNamespace: env.FRED_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
