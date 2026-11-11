import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { fredCatalog } from "../spec/catalog";
import { createFredApiFetch } from "../lib/api-adapter";
import { fredResponse, FRED_SOURCE } from "../lib/tool-result";

interface CodeModeEnv {
  FRED_DATA_DO: DurableObjectNamespace;
  CODE_MODE_LOADER: WorkerLoader;
  FRED_API_KEY?: string;
}

export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
  const apiFetch = createFredApiFetch(env.FRED_API_KEY);
  const registrar = { tool: (...args: unknown[]) => {
    const [name, ...rest] = args;
    const register = server.tool.bind(server) as (...values: unknown[]) => void;
    const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof fredResponse>;
    for (const alias of [String(name), `mcp_${String(name)}`]) register(alias, ...rest,
      (input: unknown, extra: unknown) => fredResponse(() => handler(input, extra), env, alias, extra, input));
  } };

  const searchTool = createSearchTool({
    prefix: "fred",
    catalog: fredCatalog,
  });
  searchTool.register(registrar);

  const executeTool = createExecuteTool({
    prefix: "fred",
    // Verifiable provenance: fred_execute results carry a _meta.citation.
    source: FRED_SOURCE,
    catalog: fredCatalog,
    apiFetch,
    preserveApiErrors: true,
    maxInlineBytes: 30 * 1024,
    stagingThreshold: 30 * 1024,
    timeout: 90_000,
    doNamespace: env.FRED_DATA_DO,
    loader: env.CODE_MODE_LOADER,
  });
  executeTool.register(registrar);
}
