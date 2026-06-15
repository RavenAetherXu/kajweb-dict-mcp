type Env = {
  DATA_BASE_URL: string;
  MCP_NAME?: string;
  MCP_VERSION?: string;
  MCP_TOKEN?: string;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type WordEntry = {
  word: string;
  rank: number | null;
  wordId: string;
  bookId: string;
  translation: string;
};

type BookEntry = {
  id: string;
  title: string;
  wordCount: number;
  tags: string;
  origin: string;
  zipFile: string;
  originalUrl: string;
  localCsv: string;
  introduction: string;
};

type Metadata = {
  sourceRepo: string;
  sourceCommit: string;
  dataset: string;
  bookCount: number;
  wordCount: number;
};

type Dataset = {
  books: BookEntry[];
  words: WordEntry[];
  metadata: Metadata;
  loadedAt: number;
};

let cache: Dataset | null = null;
const CACHE_MS = 10 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id"
};

const tools = [
  {
    name: "list_books",
    description: "List IELTS vocabulary books available in kajweb/dict.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "search_words",
    description: "Search IELTS words by spelling or Chinese/English translation. Returns ranked lightweight entries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, e.g. abandon, 废除, thesis." },
        bookId: { type: "string", description: "Optional book ID filter, e.g. IELTS_2." },
        limit: { type: "number", description: "Maximum result count, default 20, max 100." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "get_word",
    description: "Get IELTS entries for an exact word, optionally filtered by book ID.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Exact word to look up." },
        bookId: { type: "string", description: "Optional book ID filter." }
      },
      required: ["word"],
      additionalProperties: false
    }
  },
  {
    name: "get_book_stats",
    description: "Get word count and sample words for a book.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "Book ID, e.g. IELTSluan_2, IELTS_2, IELTS_3." }
      },
      required: ["bookId"],
      additionalProperties: false
    }
  }
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, name: env.MCP_NAME ?? "kajweb-dict-mcp" });
    }

    if (url.pathname !== "/mcp") {
      return json({ ok: false, error: "Use /mcp for MCP JSON-RPC requests." }, 404);
    }

    if (!authorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (request.method === "GET") {
      return new Response("event: endpoint\ndata: /mcp\n\n", {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache"
        }
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await request.json<JsonRpcRequest | JsonRpcRequest[]>();
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((item) => handleRpc(item, env)));
      return json(results.filter(Boolean));
    }

    const result = await handleRpc(body, env);
    if (result === null) {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    return json(result);
  }
};

async function handleRpc(req: JsonRpcRequest, env: Env) {
  const id = req.id ?? null;
  const method = req.method ?? "";

  try {
    if (method.startsWith("notifications/")) {
      return null;
    }

    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: env.MCP_NAME ?? "kajweb-dict-mcp",
          version: env.MCP_VERSION ?? "0.1.0"
        }
      });
    }

    if (method === "tools/list") {
      return rpcResult(id, { tools });
    }

    if (method === "resources/list") {
      return rpcResult(id, {
        resources: [
          {
            uri: "kajweb-dict://metadata",
            name: "kajweb/dict IELTS metadata",
            mimeType: "application/json"
          }
        ]
      });
    }

    if (method === "resources/read") {
      const ds = await loadDataset(env);
      return rpcResult(id, {
        contents: [
          {
            uri: "kajweb-dict://metadata",
            mimeType: "application/json",
            text: JSON.stringify(ds.metadata, null, 2)
          }
        ]
      });
    }

    if (method === "tools/call") {
      const params = req.params ?? {};
      const name = String(params.name ?? "");
      const args = asRecord(params.arguments);
      return rpcResult(id, await callTool(name, args, env));
    }

    return rpcError(id, -32601, `Unknown method: ${method}`);
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(name: string, args: Record<string, unknown>, env: Env) {
  const ds = await loadDataset(env);

  if (name === "list_books") {
    return textContent(JSON.stringify({ metadata: ds.metadata, books: ds.books }, null, 2));
  }

  if (name === "search_words") {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) throw new Error("query is required");
    const bookId = optionalString(args.bookId);
    const limit = clampNumber(args.limit, 20, 1, 100);
    const results = ds.words
      .filter((entry) => !bookId || entry.bookId === bookId)
      .filter((entry) => {
        return (
          entry.word.toLowerCase().includes(query) ||
          entry.translation.toLowerCase().includes(query)
        );
      })
      .slice(0, limit);
    return textContent(JSON.stringify({ query, bookId, count: results.length, results }, null, 2));
  }

  if (name === "get_word") {
    const word = String(args.word ?? "").trim().toLowerCase();
    if (!word) throw new Error("word is required");
    const bookId = optionalString(args.bookId);
    const results = ds.words.filter((entry) => {
      return entry.word.toLowerCase() === word && (!bookId || entry.bookId === bookId);
    });
    return textContent(JSON.stringify({ word, bookId, count: results.length, results }, null, 2));
  }

  if (name === "get_book_stats") {
    const bookId = String(args.bookId ?? "").trim();
    if (!bookId) throw new Error("bookId is required");
    const book = ds.books.find((item) => item.id === bookId);
    if (!book) throw new Error(`Unknown bookId: ${bookId}`);
    const words = ds.words.filter((entry) => entry.bookId === bookId);
    return textContent(
      JSON.stringify(
        {
          book,
          wordCount: words.length,
          sample: words.slice(0, 20)
        },
        null,
        2
      )
    );
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function loadDataset(env: Env): Promise<Dataset> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_MS) return cache;

  const base = env.DATA_BASE_URL.replace(/\/$/, "");
  const [books, words, metadata] = await Promise.all([
    fetchJson<BookEntry[]>(`${base}/ielts_books.json`),
    fetchJson<WordEntry[]>(`${base}/ielts_words.json`),
    fetchJson<Metadata>(`${base}/metadata.json`)
  ]);
  cache = { books, words, metadata, loadedAt: now };
  return cache;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "kajweb-dict-mcp/0.1.0" },
    cf: { cacheTtl: 600, cacheEverything: true }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json<T>();
}

function authorized(request: Request, env: Env): boolean {
  if (!env.MCP_TOKEN) return true;
  const header = request.headers.get("Authorization") ?? "";
  return header === `Bearer ${env.MCP_TOKEN}`;
}

function textContent(text: string) {
  return {
    content: [{ type: "text", text }]
  };
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}
