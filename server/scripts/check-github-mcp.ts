// Usage: GITHUB_TOKEN=ghp_... bun scripts/check-github-mcp.ts
// Connects to GitHub's MCP server and shows what the bot's tool search returns for common queries.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { rankTools } from "../src/mcp/tool-search";

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("Set GITHUB_TOKEN"); process.exit(1); }
const client = new Client({ name: "check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://api.githubcopilot.com/mcp/"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const tools = (await client.listTools()).tools;
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "), "\n");
const items = tools.map((t) => ({ name: t.name, info: { name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> } }));
for (const q of ["list repos", "list my repositories", "repositories"]) console.log(`"${q}" =>`, rankTools(q, items, 8).map((x) => x.name).join(", "));
const me = await client.callTool({ name: "get_me", arguments: {} });
console.log("\nget_me ok:", !me.isError);
await client.close();
