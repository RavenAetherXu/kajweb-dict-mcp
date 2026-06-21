# kajweb-dict-mcp

Read-only remote MCP server for the IELTS subset of [`kajweb/dict`](https://github.com/kajweb/dict).

This repository is meant to be deployed as a Cloudflare Worker and connected to Notion as a Custom MCP server:

```text
https://<your-worker>.<your-subdomain>.workers.dev/mcp
```

## Data

Current dataset:

- Source repository: `https://github.com/kajweb/dict`
- Source commit: `3992bcb94c800a2fd38a9fd6ff95b2353e755363`
- Books: 3 IELTS books
- Raw word rows: 10,429 book-specific source rows
- Unique canonical words: 5,275 deduplicated headwords
- Duplicate word groups: 3,427
- Translation conflicts preserved: 1,694 canonical words have multiple source translations

Data files:

```text
data/ielts_books.json
data/ielts_words.json
data/metadata.json
```

The Notion-facing tools use canonical words by default. A canonical word is one
normalized headword with all source books, ranks, word IDs, and translations kept
under `sources`. Raw rows remain available for audit and book-order provenance.
The worker builds this canonical index in memory from `ielts_words.json`, so the
GitHub dataset stays compact.

## MCP Tools

The server exposes read-only tools:

- `list_books`: list available IELTS vocabulary books
- `search_words`: search deduplicated canonical words by spelling or translation
- `get_word`: get one canonical word and its source-book provenance
- `get_word_rows`: get raw book rows for an exact word
- `get_book_stats`: get row count, unique word count, and sample canonical words by book
- `get_vocabulary_stats`: get dataset counts that separate raw rows from unique words

Use `mode: "rows"` with `search_words` or `get_word` only when you explicitly
want row-level results. For vocabulary size, trust `unique_word_count`, not raw
row count.

## Deploy

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Deploy to Cloudflare:

```bash
npm run deploy
```

Then put this URL into Notion Custom MCP:

```text
https://<worker-url>/mcp
```

## GitHub-backed data loading

By default the worker fetches JSON data from:

```text
https://raw.githubusercontent.com/RavenAetherXu/kajweb-dict-mcp/main/data
```

Change `DATA_BASE_URL` in `wrangler.toml` if the GitHub owner/repo is different.

## Optional simple token

If you want a lightweight shared secret, set `MCP_TOKEN` as a Cloudflare secret:

```bash
wrangler secret put MCP_TOKEN
```

Then call the MCP endpoint with:

```text
Authorization: Bearer <token>
```

Only use this as a simple gate. It is not OAuth.
