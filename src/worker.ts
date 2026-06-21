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

type WordSource = {
  bookId: string;
  bookTitle: string;
  wordId: string;
  rank: number | null;
  word: string;
  translation: string;
};

type CanonicalWordEntry = {
  canonicalWordId: string;
  word: string;
  normWord: string;
  primaryTranslation: string;
  translations: string[];
  sourceBookIds: string[];
  sourceBookCount: number;
  rowCount: number;
  qualityFlags: string[];
  sources: WordSource[];
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
  rowCount?: number;
  uniqueWordCount?: number;
  duplicateWordCount?: number;
  translationConflictCount?: number;
  canonicalSchemaVersion?: number;
};

type Dataset = {
  books: BookEntry[];
  words: WordEntry[];
  canonicalWords: CanonicalWordEntry[];
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
    description: "Search IELTS words by spelling or Chinese/English translation. Returns deduplicated canonical words by default; use mode='rows' or get_word_rows for raw book rows.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, e.g. abandon, 废除, thesis." },
        bookId: { type: "string", description: "Optional book ID filter, e.g. IELTS_2." },
        limit: { type: "number", description: "Maximum result count, default 20, max 100." },
        mode: { type: "string", enum: ["canonical", "rows"], description: "canonical returns unique words; rows returns raw book entries." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "get_word",
    description: "Get one deduplicated IELTS canonical word for an exact word. Includes source book rows for provenance.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Exact word to look up." },
        bookId: { type: "string", description: "Optional book ID filter." },
        mode: { type: "string", enum: ["canonical", "rows"], description: "canonical returns one unique word; rows returns raw book entries." }
      },
      required: ["word"],
      additionalProperties: false
    }
  },
  {
    name: "get_word_rows",
    description: "Get raw IELTS book rows for an exact word. Use this for audit/provenance, not vocabulary size counting.",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "Exact word to look up." },
        bookId: { type: "string", description: "Optional book ID filter." },
        limit: { type: "number", description: "Maximum raw row count, default 20, max 100." }
      },
      required: ["word"],
      additionalProperties: false
    }
  },
  {
    name: "get_book_stats",
    description: "Get row count, unique word count, and sample canonical words for a book.",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "Book ID, e.g. IELTSluan_2, IELTS_2, IELTS_3." }
      },
      required: ["bookId"],
      additionalProperties: false
    }
  },
  {
    name: "get_vocabulary_stats",
    description: "Get dataset-level counts that distinguish raw rows from unique deduplicated vocabulary items.",
    inputSchema: {
      type: "object",
      properties: {},
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
    const query = normText(args.query);
    if (!query) throw new Error("query is required");
    const bookId = optionalString(args.bookId);
    const limit = clampNumber(args.limit, 20, 1, 100);
    const mode = optionalString(args.mode) ?? "canonical";

    if (mode === "rows") {
      const results = ds.words
        .filter((entry) => !bookId || entry.bookId === bookId)
        .filter((entry) => {
          return (
            normText(entry.word).includes(query) ||
            normText(entry.translation).includes(query)
          );
        })
        .slice(0, limit);
      return textContent(
        JSON.stringify({ query, bookId, mode, count: results.length, row_count: results.length, results }, null, 2)
      );
    }

    const canonicalResults = ds.canonicalWords
      .filter((entry) => !bookId || entry.sourceBookIds.includes(bookId))
      .filter((entry) => canonicalMatches(entry, query))
      .slice(0, limit);
    return textContent(
      JSON.stringify(
        {
          query,
          bookId,
          mode: "canonical",
          count: canonicalResults.length,
          row_count: canonicalResults.reduce((sum, entry) => sum + matchingSourceCount(entry, bookId), 0),
          results: canonicalResults.map((entry) => filterCanonicalSources(entry, bookId))
        },
        null,
        2
      )
    );
  }

  if (name === "get_word") {
    const word = normText(args.word);
    if (!word) throw new Error("word is required");
    const bookId = optionalString(args.bookId);
    const mode = optionalString(args.mode) ?? "canonical";

    if (mode === "rows") {
      return getWordRows(ds, word, bookId, clampNumber(args.limit, 100, 1, 100));
    }

    const result = ds.canonicalWords.find((entry) => {
      return entry.normWord === word && (!bookId || entry.sourceBookIds.includes(bookId));
    });
    const canonical = result ? filterCanonicalSources(result, bookId) : null;
    return textContent(
      JSON.stringify(
        {
          word,
          bookId,
          mode: "canonical",
          found: Boolean(canonical),
          count: canonical ? 1 : 0,
          row_count: canonical ? matchingSourceCount(result!, bookId) : 0,
          canonical
        },
        null,
        2
      )
    );
  }

  if (name === "get_word_rows") {
    const word = normText(args.word);
    if (!word) throw new Error("word is required");
    const bookId = optionalString(args.bookId);
    const limit = clampNumber(args.limit, 20, 1, 100);
    return getWordRows(ds, word, bookId, limit);
  }

  if (name === "get_book_stats") {
    const bookId = String(args.bookId ?? "").trim();
    if (!bookId) throw new Error("bookId is required");
    const book = ds.books.find((item) => item.id === bookId);
    if (!book) throw new Error(`Unknown bookId: ${bookId}`);
    const words = ds.words.filter((entry) => entry.bookId === bookId);
    const canonicalWords = ds.canonicalWords.filter((entry) => entry.sourceBookIds.includes(bookId));
    return textContent(
      JSON.stringify(
        {
          book,
          row_count: words.length,
          unique_word_count: canonicalWords.length,
          duplicate_row_count: words.length - canonicalWords.length,
          sample: canonicalWords.slice(0, 20).map((entry) => filterCanonicalSources(entry, bookId))
        },
        null,
        2
      )
    );
  }

  if (name === "get_vocabulary_stats") {
    return textContent(
      JSON.stringify(
        {
          metadata: ds.metadata,
          book_count: ds.books.length,
          row_count: ds.words.length,
          unique_word_count: ds.canonicalWords.length,
          duplicate_word_count: ds.canonicalWords.filter((entry) => entry.rowCount > 1).length,
          duplicate_extra_rows: ds.words.length - ds.canonicalWords.length,
          translation_conflict_count: ds.canonicalWords.filter((entry) =>
            entry.qualityFlags.includes("translation_conflict")
          ).length
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
  const canonicalWords = buildCanonicalWords(words, books);
  cache = { books, words, canonicalWords, metadata, loadedAt: now };
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

function normText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalWordId(norm: string): string {
  const slug = norm.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `cw_${slug.slice(0, 80)}` : "cw_empty";
}

function buildCanonicalWords(words: WordEntry[], books: BookEntry[]): CanonicalWordEntry[] {
  const bookTitles = new Map(books.map((book) => [book.id, book.title]));
  const grouped = new Map<string, WordEntry[]>();
  for (const entry of words) {
    const key = normText(entry.word);
    if (!key) continue;
    const entries = grouped.get(key) ?? [];
    entries.push(entry);
    grouped.set(key, entries);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normWord, entries]) => {
      const translations = [...new Set(entries.map((entry) => entry.translation.trim()).filter(Boolean))].sort();
      const sourceBookIds = [...new Set(entries.map((entry) => entry.bookId))].sort();
      const qualityFlags = [];
      if (entries.length > 1) qualityFlags.push("source_duplicate");
      if (translations.length > 1) qualityFlags.push("translation_conflict");

      const wordCounts = new Map<string, number>();
      const translationCounts = new Map<string, number>();
      for (const entry of entries) {
        wordCounts.set(entry.word, (wordCounts.get(entry.word) ?? 0) + 1);
        if (entry.translation) {
          translationCounts.set(entry.translation, (translationCounts.get(entry.translation) ?? 0) + 1);
        }
      }

      const displayWord = mostCommonShortest(wordCounts);
      const primaryTranslation = mostCommonShortest(translationCounts);
      const sources = entries
        .slice()
        .sort((left, right) => left.bookId.localeCompare(right.bookId) || Number(left.rank ?? 0) - Number(right.rank ?? 0))
        .map((entry) => ({
          bookId: entry.bookId,
          bookTitle: bookTitles.get(entry.bookId) ?? "",
          wordId: entry.wordId,
          rank: entry.rank,
          word: entry.word,
          translation: entry.translation
        }));

      return {
        canonicalWordId: canonicalWordId(normWord),
        word: displayWord,
        normWord,
        primaryTranslation,
        translations,
        sourceBookIds,
        sourceBookCount: sourceBookIds.length,
        rowCount: entries.length,
        qualityFlags,
        sources
      };
    });
}

function mostCommonShortest(counts: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && value.length < best.length)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function canonicalMatches(entry: CanonicalWordEntry, query: string): boolean {
  return (
    entry.normWord.includes(query) ||
    normText(entry.word).includes(query) ||
    normText(entry.primaryTranslation).includes(query) ||
    entry.translations.some((translation) => normText(translation).includes(query))
  );
}

function matchingSourceCount(entry: CanonicalWordEntry, bookId?: string): number {
  if (!bookId) return entry.rowCount;
  return entry.sources.filter((source) => source.bookId === bookId).length;
}

function filterCanonicalSources(entry: CanonicalWordEntry, bookId?: string): CanonicalWordEntry {
  if (!bookId) return entry;
  const sources = entry.sources.filter((source) => source.bookId === bookId);
  return {
    ...entry,
    sourceBookIds: [bookId],
    sourceBookCount: sources.length > 0 ? 1 : 0,
    rowCount: sources.length,
    sources
  };
}

function getWordRows(ds: Dataset, word: string, bookId: string | undefined, limit: number) {
  const results = ds.words
    .filter((entry) => normText(entry.word) === word && (!bookId || entry.bookId === bookId))
    .slice(0, limit);
  return textContent(
    JSON.stringify(
      {
        word,
        bookId,
        count: results.length,
        row_count: results.length,
        rows: results
      },
      null,
      2
    )
  );
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}
