import { config } from "../../config";
import { log } from "../../log";

export type WebResult = { title: string; url: string; snippet: string };
export type WebSearchResponse = { results: WebResult[]; message?: string };

const T = 15_000;
const json = async (res: Response) => {
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return (await res.json()) as any;
};

/** Provider chosen by SEARCH_PROVIDER. Unconfigured or failing search returns [] + a message, never throws. */
export async function webSearch(query: string, limit = 5): Promise<WebSearchResponse> {
  const { SEARCH_PROVIDER: p, SEARCH_API_KEY: key } = config;
  if (!p || !key) return { results: [], message: "Web search is not configured (set SEARCH_PROVIDER and SEARCH_API_KEY)." };
  try {
    const signal = AbortSignal.timeout(T);
    if (p === "tavily") {
      const d = await json(await fetch("https://api.tavily.com/search", {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: limit }),
      }));
      return { results: (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" })) };
    }
    if (p === "brave") {
      const d = await json(await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`, {
        signal, headers: { "x-subscription-token": key, accept: "application/json" },
      }));
      return { results: (d.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? "" })) };
    }
    const d = await json(await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, limit }),
    }));
    return { results: (d.data ?? []).map((r: any) => ({ title: r.title ?? r.url, url: r.url, snippet: r.description ?? "" })) };
  } catch (e) {
    log.warn("web search failed", { provider: p, error: String(e) });
    return { results: [], message: "Web search failed. Try rephrasing the query." };
  }
}
