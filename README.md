# Browserless Crawler & API Discovery

A single-file CLI tool that authenticates, crawls a target website using Puppeteer/Browserless, and discovers API endpoints in real time.

## Features

- **BFS crawling** with configurable depth and rate limiting
- **API discovery** — intercepts XHR/Fetch/Document traffic, infers JSON schemas
- **Authentication** — inject headers, bearer tokens, or automate login forms
- **Request deduplication** — merges identical endpoint signatures
- **Automatic page interaction** — clicks buttons/dropdowns to trigger lazy-loaded requests
- **Resource filtering** — exclude CSS, images, fonts, etc. from output
- **Real-time dashboard** — live progress bar and coloured log stream
- **Streaming JSON output** — results are appended incrementally (safe on crash)
- **Browserless support** — connect to a remote headless Chrome service

## Installation

**Requirements:** Node.js ≥ 18

```bash
# Clone / copy the directory, then:
bash setup.sh          # installs dependencies, creates output/ dir

# Or manually:
npm install
```

## Usage

```bash
node index.js <url> [options]

# Examples
node index.js https://example.com
node index.js https://example.com -d 3 -l 2 -o output/apis.json
node index.js https://example.com -a "Authorization: Bearer mytoken"
node index.js https://example.com -a mytoken          # → Bearer mytoken
node index.js https://example.com -a ./creds.json     # JSON credentials file
node index.js https://example.com -b ws://localhost:3000   # Browserless
node index.js --help
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --auth <value>` | — | Bearer token, `Header: Value` string, or path to a JSON credentials file |
| `-d, --depth <n>` | `1` | Maximum crawl depth |
| `-l, --limit <n>` | `1` | Rate limit (requests/second) |
| `-o, --output <path>` | `./output.json` | Output file path |
| `-c, --concurrency <n>` | `1` | Max concurrent pages |
| `-b, --browserless <url>` | — | Browserless WebSocket endpoint (e.g. `ws://localhost:3000`) |
| `--no-headless` | — | Run browser in headed (visible) mode |
| `--user-agent <string>` | Mozilla/5.0 | Custom User-Agent |
| `--filter <types>` | — | Comma-separated resource types to exclude: `css,js,image,font,media` |
| `--hide-filtered` | — | Suppress filtered requests from the live log |
| `--no-interact` | — | Disable automatic page interaction |

### Output format

```json
{
  "metadata": { "targetUrl": "…", "maxDepth": 1, "startedAt": "…" },
  "endpoints": [
    {
      "method": "GET",
      "url": "/api/v1/users",
      "status": 200,
      "resourceType": "xhr",
      "params": { "page": "number" },
      "response_schema": "id (number), name (string)",
      "discoveredAt": "…"
    }
  ],
  "summary": { "pagesVisited": 5, "totalApisDiscovered": 12, "duration": "38s" }
}
```

## Docker

### Build & run (local Chromium)

```bash
docker build -t browserless-crawler .
docker run --rm \
  -v "$(pwd)/output:/app/output" \
  browserless-crawler https://example.com -d 2 -o /app/output/result.json
```

### docker compose (recommended — uses Browserless service)

```bash
# Start browserless in the background, then run a crawl:
docker compose up -d browserless
docker compose run --rm crawler \
  https://example.com -b ws://browserless:3000 -o /app/output/result.json

# Tear down
docker compose down
```

## Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `PUPPETEER_EXECUTABLE_PATH` | Path to Chromium/Chrome binary (used in Docker / CI) |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Set to `true` to skip bundled Chromium download |
| `BROWSERLESS_ENDPOINT` | WebSocket URL for Browserless (same as `--browserless` flag) |
