#!/usr/bin/env node

/**
 * Browserless Crawler & API Discovery — Single-File Edition
 *
 * All agents combined into one program:
 *   - ConfigValidator  (Agent 3 – configuration)
 *   - NetworkMonitor   (Agent 2 – network interception & parsing)
 *   - Logger           (Agent 3 – real-time dashboard)
 *   - Reporter         (Agent 3 – file I/O)
 *   - CrawlerEngine    (Agent 1 – browser automation & crawling)
 *   - CLI entry point  (Agent 3 – orchestration)
 *
 * Usage:
 *   node index.js <url> [options]
 *
 * Options:
 *   -a, --auth <token>          Auth token, "Header: Value" string, or path to credentials JSON
 *   -d, --depth <number>        Maximum crawl depth (default: 1)
 *   -l, --limit <number>        Rate limit in requests per second (default: 1)
 *   -o, --output <path>         Output file path (default: ./output.json)
 *   -c, --concurrency <number>  Max concurrent pages (default: 1)
 *   -b, --browserless <url>     Browserless WebSocket endpoint URL
 *       --no-headless           Run browser in headed (visible) mode
 *       --user-agent <string>   Custom User-Agent string
 */

'use strict';

// ─── External dependencies ──────────────────────────────────────────────────
const puppeteer   = require('puppeteer');
const { Command } = require('commander');
const chalk       = require('chalk');
const cliProgress = require('cli-progress');
const fs          = require('fs');
const path        = require('path');
const { URL }     = require('url');
const { EventEmitter } = require('events');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1: ConfigValidator  (Agent 3 – configuration)
// ════════════════════════════════════════════════════════════════════════════

class ConfigValidator {
  /**
   * Validate and normalize the configuration object.
   * @param {object} rawConfig - Raw parsed CLI arguments
   * @returns {object} Validated and normalized config
   * @throws {Error} If required fields are invalid
   */
  static validate(rawConfig) {
    const config = {};

    config.targetUrl          = ConfigValidator.validateUrl(rawConfig.url);
    config.maxDepth           = ConfigValidator.validatePositiveInt(rawConfig.depth, 'depth', 1);
    config.requestsPerSecond  = ConfigValidator.validatePositiveNumber(rawConfig.limit, 'limit', 1);
    config.outputFile         = ConfigValidator.validateOutputPath(rawConfig.output || './output.json');
    config.authHeader         = ConfigValidator.parseAuth(rawConfig.auth);
    config.headless            = rawConfig.headless !== false;
    config.browserlessEndpoint = rawConfig.browserless || process.env.BROWSERLESS_ENDPOINT || null;
    config.maxConcurrentPages  = ConfigValidator.validatePositiveInt(rawConfig.concurrency, 'concurrency', 1);
    config.viewport            = { width: 1920, height: 1080 };
    config.userAgent           = rawConfig.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    // Feature 2: file type filtering
    config.filterTypes         = ConfigValidator.parseFilterTypes(rawConfig.filter);
    config.hideFiltered        = rawConfig.hideFiltered === true;
    // Feature 4: exclude path list
    config.excludePaths        = ConfigValidator.parseExcludePaths(rawConfig.excludePaths);
    // Feature 3: automatic page interaction
    config.enableInteract      = rawConfig.interact !== false;

    return config;
  }

  /**
   * Parse --filter flag: comma-separated category names → Puppeteer resource type strings.
   * Supported categories: css, js, image, font, media, document, xhr, fetch
   */
  static parseFilterTypes(filter) {
    if (!filter) return [];
    const CATEGORY_MAP = {
      css:      'stylesheet',
      js:       'script',
      image:    'image',
      images:   'image',
      font:     'font',
      fonts:    'font',
      media:    'media',
      document: 'document',
      xhr:      'xhr',
      fetch:    'fetch',
    };
    return filter.split(',')
      .map(s => s.trim().toLowerCase())
      .map(s => CATEGORY_MAP[s] || s)
      .filter(Boolean);
  }

  /**
   * Parse --exclude-paths flag: comma-separated paths or URLs to block.
   * Matching is prefix-based against URL pathname.
   */
  static parseExcludePaths(value) {
    if (!value) return [];
    const normalize = (raw) => {
      let p = String(raw || '').trim();
      if (!p) return null;
      try {
        if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
      } catch (_) {}
      if (!p.startsWith('/')) p = '/' + p;
      p = p.replace(/\*+$/, '');
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      return p || '/';
    };
    return [...new Set(value.split(',').map(normalize).filter(Boolean))];
  }

  static validateUrl(url) {
    if (!url) {
      throw new Error('URL is required. Provide a target URL as the first argument.');
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Invalid protocol "${parsed.protocol}". Only http and https are supported.`);
      }
      return parsed.toString();
    } catch (e) {
      if (e.code === 'ERR_INVALID_URL') {
        throw new Error(`Invalid URL: "${url}". Please provide a valid URL (e.g., https://example.com).`);
      }
      throw e;
    }
  }

  static validatePositiveInt(value, name, defaultValue) {
    if (value === undefined || value === null) return defaultValue;
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1) {
      throw new Error(`"${name}" must be a positive integer. Received: "${value}".`);
    }
    return num;
  }

  static validatePositiveNumber(value, name, defaultValue) {
    if (value === undefined || value === null) return defaultValue;
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) {
      throw new Error(`"${name}" must be a positive number. Received: "${value}".`);
    }
    return num;
  }

  static validateOutputPath(filePath) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        throw new Error(`Cannot create output directory: "${dir}". ${e.message}`);
      }
    }
    return resolved;
  }

  /**
   * Parse auth flag: supports "Header: Value" string, path to JSON file, or bare token.
   */
  static parseAuth(auth) {
    if (!auth) return null;

    if (fs.existsSync(auth)) {
      try {
        const content = JSON.parse(fs.readFileSync(auth, 'utf-8'));
        if (content.token) return { Authorization: `Bearer ${content.token}` };
        if (content.headers && typeof content.headers === 'object') return content.headers;
        throw new Error('Credentials file must contain "token" or "headers" field.');
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`Invalid JSON in credentials file: "${auth}".`);
        }
        throw e;
      }
    }

    if (auth.includes(':')) {
      const colonIdx = auth.indexOf(':');
      const key   = auth.substring(0, colonIdx).trim();
      const value = auth.substring(colonIdx + 1).trim();
      if (key && value) return { [key]: value };
    }

    return { Authorization: `Bearer ${auth}` };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1.5: ApiSignatureRegistry  (Feature 1 – request deduplication)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deduplicates structurally-identical requests by computing a signature from:
 *   method + normalised path + sorted param names + sorted body keys + sorted header names
 *
 * Requests that share the same signature but differ only in *values* are merged.
 */
class ApiSignatureRegistry {
  constructor() {
    this._signatures  = new Map(); // signature → endpoint object
    this._mergedCount = 0;
  }

  /**
   * Compute a structural signature for the given request data.
   * Values are ignored; only the *names* of keys matter.
   */
  computeSignature(requestData) {
    const pathname    = this._normalizePath(requestData.url);
    const paramNames  = requestData.params
      ? Object.keys(requestData.params).sort().join(',') : '';
    const bodyKeys    = requestData.body && typeof requestData.body === 'object'
      ? Object.keys(requestData.body).sort().join(',')   : '';
    const headerNames = Object.keys(requestData.headers || {}).sort().join(',');
    return `${requestData.method}|${pathname}|${paramNames}|${bodyKeys}|${headerNames}`;
  }

  /**
   * Attempt to register a new endpoint under its signature.
   * @returns {boolean} true = new unique entry; false = duplicate (merged)
   */
  register(signature, endpoint) {
    if (this._signatures.has(signature)) {
      this._mergedCount++;
      const existing = this._signatures.get(signature);
      existing.mergeCount = (existing.mergeCount || 1) + 1;
      if (endpoint.source && endpoint.source !== existing.source) {
        const variants = Array.isArray(existing.sourceVariants) ? existing.sourceVariants : [];
        if (existing.source) variants.push(existing.source);
        existing.sourceVariants = [...new Set([...variants, endpoint.source])];
      }
      return false; // duplicate
    }
    endpoint.mergeCount = 1;
    this._signatures.set(signature, endpoint);
    return true; // new
  }

  getMergedCount()  { return this._mergedCount; }
  getUniqueCount()  { return this._signatures.size; }

  /** Replace numeric path segments with :id for normalisation. */
  _normalizePath(urlString) {
    try {
      return new URL(urlString, 'http://x').pathname.replace(/\/\d+/g, '/:id');
    } catch (_) {
      return urlString.split('?')[0].replace(/\/\d+/g, '/:id');
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2: NetworkMonitor  (Agent 2 – network interception & parsing)
// ════════════════════════════════════════════════════════════════════════════

class NetworkMonitor extends EventEmitter {
  /**
   * @param {object} options
   * @param {string[]} options.filterTypes  - Puppeteer resource types to exclude from output
   * @param {boolean}  options.hideFiltered - If true, don't log filtered requests
   */
  constructor(options = {}) {
    super();
    this._discoveredApis  = [];
    this._pendingRequests = new Map();
    this._registry        = new ApiSignatureRegistry();
    this._filteredCount   = 0;
    this._filterSet       = new Set(options.filterTypes || []);
    this._excludePaths    = new Set(options.excludePaths || []);
    this._hideFiltered    = options.hideFiltered || false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Attach request/response listeners to a Puppeteer Page.
   * Called by CrawlerEngine before each page navigation.
   * @param {import('puppeteer').Page} page
   */
  async attachToPage(page, getSourceContext = null) {
    await page.setRequestInterception(true);
    page.on('request',         (req) => this._onRequest(req, getSourceContext));
    page.on('requestfinished', (req) => this._onRequestFinished(req));
    page.on('requestfailed',   (req) => this._pendingRequests.delete(req));
  }

  /** Return a copy of every unique ApiEndpoint collected so far. */
  getDiscoveredApis()  { return [...this._discoveredApis]; }
  /** Requests filtered out by user-supplied --filter types. */
  getFilteredCount()   { return this._filteredCount; }
  /** Requests merged into an existing signature (deduplicated). */
  getMergedCount()     { return this._registry.getMergedCount(); }
  /** Number of structurally distinct API signatures. */
  getUniqueApiCount()  { return this._registry.getUniqueCount(); }

  /** Clear accumulated data (useful between crawl sessions). */
  reset() {
    this._discoveredApis  = [];
    this._pendingRequests.clear();
    this._registry        = new ApiSignatureRegistry();
    this._filteredCount   = 0;
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  _isRelevantType(resourceType) {
    return ['xhr', 'fetch', 'document'].includes(resourceType.toLowerCase());
  }

  _isTrackingUrl(urlString) {
    const TRACKING = [
      /google-analytics\.com/i, /googletagmanager\.com/i, /analytics\./i,
      /pixel\./i, /doubleclick\.net/i, /facebook\.com\/tr/i,
      /hotjar\.com/i, /segment\.io/i, /mixpanel\.com/i, /amplitude\.com/i,
    ];
    return TRACKING.some((re) => re.test(urlString));
  }

  _isExcludedPath(urlString) {
    return this._getBlockedPathReason(urlString) !== null;
  }

  _getBlockedPathReason(urlString) {
    if (this._isSessionRiskPath(urlString)) return 'session_protection';
    if (!this._excludePaths.size) return null;
    try {
      const { pathname } = new URL(urlString, 'http://x');
      const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      for (const blocked of this._excludePaths) {
        if (path === blocked || path.startsWith(blocked + '/')) return 'exclude_paths';
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  _isSessionRiskPath(urlString) {
    try {
      const parsed = new URL(urlString, 'http://x');
      const full = `${parsed.pathname}${parsed.search}`.toLowerCase();
      if (/(^|\/)(log-?out|sign-?out|log-?off|sign-?off)(\/|$|\.|\?)/.test(full)) return true;
      if (/(^|[?&])(action|do|op)=log-?out([&#]|$)/.test(parsed.search.toLowerCase())) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // ── Request phase ─────────────────────────────────────────────────────────

  _onRequest(request, getSourceContext = null) {
    const resourceType = request.resourceType();

    if (this._getBlockedPathReason(request.url())) {
      this._filteredCount++;
      request.abort().catch(() => {});
      return;
    }

    if (!this._isRelevantType(resourceType) || this._isTrackingUrl(request.url())) {
      this._filteredCount++;
      request.continue();
      return;
    }

    // Feature 2: user-configured type filter — let the request through but skip reporting
    if (this._filterSet.has(resourceType.toLowerCase())) {
      this._filteredCount++;
      request.continue();
      return;
    }

    this._pendingRequests.set(request, {
      method:       request.method(),
      url:          request.url(),
      resourceType,
      headers:      this._extractImportantHeaders(request.headers()),
      params:       this._parseQueryParams(request.url()),
      body:         this._parseBody(request.postData(), request.headers()),
      source:       this._resolveSourceContext(request, getSourceContext),
    });

    request.continue();
  }

  // ── Response phase ────────────────────────────────────────────────────────

  async _onRequestFinished(request) {
    const requestData = this._pendingRequests.get(request);
    if (!requestData) return;

    this._pendingRequests.delete(request);

    const response = request.response();
    if (!response) return;

    const status = response.status();
    let responseBody   = null;
    let responseSchema = '';

    try {
      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        const text = await response.text();
        if (contentType.includes('application/json')) {
          try {
            responseSchema = this._inferSchema(JSON.parse(text));
          } catch (_) {
            responseBody = text.slice(0, 500);
          }
        } else {
          responseBody = text.slice(0, 500);
        }
      }
    } catch (_) {
      // Response body may not be available — skip gracefully
    }

    const endpoint = this._buildEndpoint(requestData, status, responseSchema, responseBody);

    // Feature 1: deduplicate by structural signature
    const sig = this._registry.computeSignature(requestData);
    if (!this._registry.register(sig, endpoint)) {
      return; // merged into existing group — do not emit
    }

    this._discoveredApis.push(endpoint);
    this.emit('apiDiscovered', endpoint);
  }

  // ── Data extraction helpers ───────────────────────────────────────────────

  _extractImportantHeaders(headers = {}) {
    const IMPORTANT = ['authorization', 'content-type', 'accept', 'x-api-key', 'x-auth-token', 'cookie'];
    const result = {};
    for (const key of Object.keys(headers)) {
      if (IMPORTANT.includes(key.toLowerCase())) result[key.toLowerCase()] = headers[key];
    }
    return result;
  }

  _parseQueryParams(urlString) {
    try {
      const { searchParams } = new URL(urlString);
      const params = {};
      for (const [key, value] of searchParams.entries()) params[key] = this._typeOf(value);
      return Object.keys(params).length ? params : undefined;
    } catch (_) {
      return undefined;
    }
  }

  _parseBody(postData, headers = {}) {
    if (!postData) return undefined;
    const contentType = (headers['content-type'] || '').toLowerCase();

    if (contentType.includes('application/json')) {
      try { return this._shallowTypeMap(JSON.parse(postData)); }
      catch (_) { return postData.slice(0, 500); }
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const result = {};
        for (const [k, v] of new URLSearchParams(postData).entries()) result[k] = this._typeOf(v);
        return result;
      } catch (_) { /* fall through */ }
    }
    return postData.slice(0, 500);
  }

  // ── Schema inference ──────────────────────────────────────────────────────

  /**
   * Recursively infer a human-readable schema string from a JSON value.
   * Example: { id: 1, name: "Alice", roles: ["admin"] }
   *       → "id (number), name (string), roles (array[string])"
   */
  _inferSchema(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      return value.length === 0 ? 'array[]' : `array[${this._inferSchema(value[0], depth + 1)}]`;
    }
    if (typeof value === 'object') {
      if (depth >= 2) return 'object';
      const fields = Object.keys(value).slice(0, 20)
        .map((key) => `${key} (${this._inferSchema(value[key], depth + 1)})`).join(', ');
      return fields || 'object';
    }
    return this._typeOf(String(value));
  }

  _shallowTypeMap(obj) {
    if (typeof obj !== 'object' || obj === null) return this._typeOf(String(obj));
    const result = {};
    for (const [key, val] of Object.entries(obj)) result[key] = this._typeOf(String(val));
    return result;
  }

  _typeOf(value) {
    if (value === null || value === 'null')           return 'null';
    if (value === 'true' || value === 'false')        return 'boolean';
    if (!isNaN(Number(value)) && value.trim() !== '') return 'number';
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(value)) return 'iso-date';
    if (/^https?:\/\//i.test(value))                 return 'url';
    return 'string';
  }

  // ── Endpoint construction ─────────────────────────────────────────────────

  _buildEndpoint(requestData, status, responseSchema, responseBody) {
    const parsedUrl = this._toRelativePath(requestData.url);
    const endpoint  = { method: requestData.method, url: parsedUrl, status, resourceType: requestData.resourceType };

    if (requestData.params && Object.keys(requestData.params).length) endpoint.params = requestData.params;
    if (requestData.body !== undefined)                                endpoint.requestBody = requestData.body;
    if (Object.keys(requestData.headers).length)                      endpoint.headers = requestData.headers;
    if (responseSchema)                                                endpoint.response_schema = responseSchema;
    else if (responseBody)                                             endpoint.response_body_snippet = responseBody;
    if (requestData.source)                                            endpoint.source = requestData.source;

    endpoint.notes       = this._generateNotes(requestData.method, status, parsedUrl);
    endpoint.discoveredAt = new Date().toISOString();
    return endpoint;
  }

  _resolveSourceContext(request, getSourceContext) {
    const sourceData = typeof getSourceContext === 'function' ? getSourceContext() : null;
    const frameUrl = (request.frame() && request.frame().url()) || request.url();
    const fallback = this._labelFromUrl(frameUrl);
    const pages = sourceData && typeof sourceData === 'object' && Array.isArray(sourceData.pageViews)
      ? sourceData.pageViews.filter((v) => typeof v === 'string' && v.trim()).slice(-2)
      : [fallback];
    const normalizedPages = pages.length >= 2 ? pages : [pages[0], pages[0]];
    const actionLabel = sourceData && typeof sourceData.action === 'string' && sourceData.action.trim()
      ? sourceData.action.trim()
      : 'Page View';
    const actionType = sourceData && typeof sourceData.actionType === 'string' && sourceData.actionType.trim()
      ? sourceData.actionType.trim()
      : 'page_view';
    const trigger = sourceData && typeof sourceData.trigger === 'string' && sourceData.trigger.trim()
      ? sourceData.trigger.trim()
      : undefined;
    const pageUrl = sourceData && typeof sourceData.currentPageUrl === 'string' && sourceData.currentPageUrl.trim()
      ? sourceData.currentPageUrl.trim()
      : frameUrl;
    const pagePath = this._toRelativePath(pageUrl);
    const meta = [`type=${actionType}`, `page=${pagePath}`];
    if (trigger) meta.push(`trigger=${trigger}`);
    return `Page flow: ${normalizedPages.join(' -> ')} | Action: ${actionLabel} (${meta.join(', ')})`;
  }

  _labelFromUrl(urlString) {
    try {
      const parsed = new URL(urlString, 'http://x');
      const parts = parsed.pathname.split('/').filter(Boolean);
      const raw = parts.length ? parts[parts.length - 1] : 'home';
      return this._humanizeLabel(raw.replace(/\.[a-z0-9]+$/i, '')) || 'Home';
    } catch (_) {
      return 'Page';
    }
  }

  _humanizeLabel(text) {
    const cleaned = decodeURIComponent(String(text || ''))
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    return cleaned
      .split(' ')
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join(' ');
  }

  _toRelativePath(urlString) {
    try {
      const { pathname, search } = new URL(urlString);
      return pathname + search;
    } catch (_) {
      return urlString;
    }
  }

  _generateNotes(method, status, urlPath) {
    const resource   = urlPath.split('/').filter(Boolean).pop() || 'resource';
    const statusDesc = status >= 500 ? 'server error'
      : status >= 400 ? 'client error'
      : status >= 300 ? 'redirect'
      : status >= 200 ? 'success'
      : 'unknown';
    const actionMap  = {
      GET: `Retrieves ${resource}`, POST: `Creates/submits ${resource}`,
      PUT: `Updates ${resource}`,   PATCH: `Partially updates ${resource}`,
      DELETE: `Deletes ${resource}`,
    };
    return `${actionMap[method.toUpperCase()] || `${method} ${resource}`} [${statusDesc}]`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3.5: PageInteractor  (Feature 3 – automatic page interaction)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Interacts with a loaded page to trigger additional network requests:
 *   - Clicks buttons and navigation elements
 *   - Detects forms, fills inputs with smart placeholder values, submits them
 *
 * Tracks interacted elements by fingerprint to prevent infinite loops.
 */
class PageInteractor {
  constructor(options = {}) {
    this._interacted        = new Set();
    this._maxInteractions   = options.maxInteractions || 30;
    this._totalInteractions = 0;
    // Smart fill values keyed by field-name/placeholder keywords
    this._fillMap = {
      email:    'test@example.com',
      mail:     'test@example.com',
      user:     'testuser',
      username: 'testuser',
      name:     'Test User',
      password: 'Test123!',
      pass:     'Test123!',
      phone:    '0123456789',
      tel:      '0123456789',
      search:   'test',
      query:    'test',
      keyword:  'test',
      q:        'test',
      number:   '42',
      amount:   '100',
      url:      'https://example.com',
      date:     '2024-01-01',
      year:     '2024',
      month:    '01',
      day:      '01',
      zip:      '10000',
      code:     '12345',
      city:     'Hanoi',
      address:  '123 Main Street',
      message:  'Test message',
      comment:  'Test comment',
      title:    'Test Title',
      subject:  'Test Subject',
    };
  }

  /**
   * Run all interactions on the page in six phases:
   *   1. Scroll to trigger lazy-loaded content / infinite scroll
   *   2. Expand collapsed sections (accordions, details, dropdowns)
   *   3. Cycle select/dropdown options
   *   4. Click buttons, tabs, nav links
   *   5. Fill and submit forms
   *   6. Click load-more / pagination controls
   * Then a second scroll pass to catch anything revealed above.
   */
  async interact(page, emitFn = () => {}) {
    let count = 0;
    try { await this._scrollPage(page); } catch (_) {}
    try { count += await this._interactExpandables(page, emitFn); } catch (_) {}
    try { count += await this._interactSelects(page, emitFn);     } catch (_) {}
    try { count += await this._interactButtons(page, emitFn);     } catch (_) {}
    try { count += await this._interactForms(page, emitFn);       } catch (_) {}
    try { count += await this._interactLoadMore(page, emitFn);    } catch (_) {}
    // Second scroll pass — picks up content revealed by the interactions above
    try { await this._scrollPage(page); } catch (_) {}
    this._totalInteractions += count;
    return count;
  }

  // ── Phase 1: scroll through the full page ─────────────────────────────────

  async _scrollPage(page) {
    await page.evaluate(async () => {
      await new Promise(resolve => {
        const step   = Math.max(200, Math.floor(window.innerHeight * 0.8));
        const delay  = 120;
        const maxMs  = 6000;
        const start  = Date.now();
        const timer  = setInterval(() => {
          window.scrollBy(0, step);
          const atBottom = (window.scrollY + window.innerHeight) >= document.body.scrollHeight - 10;
          if (atBottom || (Date.now() - start) > maxMs) {
            clearInterval(timer);
            window.scrollTo(0, 0);   // return to top so buttons/menus are reachable
            resolve();
          }
        }, delay);
      });
    }).catch(() => {});
  }

  // ── Phase 2: expand accordions, details, collapsed menus ─────────────────

  async _interactExpandables(page, emitFn) {
    let count = 0;
    const sel = [
      '[aria-expanded="false"]',
      'details:not([open]) > summary',
      '[data-toggle="collapse"]',
      '[data-bs-toggle="collapse"]',
      '[data-toggle="dropdown"]',
      '[data-bs-toggle="dropdown"]',
      '[data-toggle="tab"]',
      '[data-bs-toggle="tab"]',
      '.accordion-button.collapsed',
    ].join(', ');

    try {
      const items = await page.evaluate((sel) =>
        Array.from(document.querySelectorAll(sel))
          .map((el, i) => ({
            idx:  i,
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().substring(0, 60),
          }))
          .filter(e => e.text)
          .slice(0, 20),
        sel
      );

      for (const item of items) {
        if (count >= this._maxInteractions) break;
        const key = `expand:${item.text}`;
        if (this._interacted.has(key)) continue;
        try {
          emitFn('interactionStarted', {
            action: this._actionLabel('Expand', item.text, 'Section'),
            actionType: 'interaction',
            trigger: this._triggerLabel('expand', item.text, 'section'),
          });
          await page.evaluate((sel, idx) => {
            const el = document.querySelectorAll(sel)[idx];
            if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
          }, sel, item.idx);
          this._interacted.add(key);
          await new Promise(r => setTimeout(r, 250));
          emitFn('elementInteracted', { type: 'expandable', text: item.text });
          count++;
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  }

  // ── Phase 3: cycle through <select> options ───────────────────────────────

  async _interactSelects(page, emitFn) {
    let count = 0;
    try {
      const selects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select')).map((s, i) => ({
          idx:     i,
          name:    s.name || s.id || String(i),
          // skip default (index 0); try next 3 options
          options: Array.from(s.options)
            .map((o, oi) => ({ oi, val: o.value }))
            .slice(1, 4),
        })).filter(s => s.options.length > 0).slice(0, 10)
      );

      for (const sel of selects) {
        for (const opt of sel.options) {
          if (count >= this._maxInteractions) break;
          const key = `select:${sel.name}:${opt.val}`;
          if (this._interacted.has(key)) continue;
          try {
            emitFn('interactionStarted', {
              action: this._actionLabel('Change', sel.name, 'Selection'),
              actionType: 'interaction',
              trigger: this._triggerLabel('select', sel.name, 'selection'),
            });
            await page.evaluate((sIdx, optIdx) => {
              const s = document.querySelectorAll('select')[sIdx];
              if (!s) return;
              s.scrollIntoView({ block: 'center' });
              s.selectedIndex = optIdx;
              s.dispatchEvent(new Event('change', { bubbles: true }));
            }, sel.idx, opt.oi);
            this._interacted.add(key);
            await new Promise(r => setTimeout(r, 300));
            emitFn('elementInteracted', { type: 'select', name: sel.name, value: opt.val });
            count++;
          } catch (_) {}
        }
      }
    } catch (_) {}
    return count;
  }

  // ── Phase 4: buttons, tabs, nav links ────────────────────────────────────

  async _interactButtons(page, emitFn) {
    let count = 0;
    const sel = [
      'button:not([type="submit"])',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      'nav a',
      '[data-action]',
      '[data-toggle]',
      '[data-bs-toggle]',
      '[aria-controls]',
      '.nav-link',
      '.tab-link',
      'summary',
    ].join(', ');

    try {
      const buttons = await page.evaluate((sel) =>
        Array.from(document.querySelectorAll(sel))
          .map((el, i) => ({
            idx:  i,
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().substring(0, 60),
            tag:  el.tagName.toLowerCase(),
          }))
          .filter(b => b.text)
          .slice(0, 30),
        sel
      );

      for (const btn of buttons) {
        if (count >= this._maxInteractions) break;
        const key = `btn:${btn.text}:${btn.tag}`;
        if (this._interacted.has(key)) continue;
        try {
          emitFn('interactionStarted', {
            action: this._actionLabel('Click', btn.text, 'Button'),
            actionType: 'interaction',
            trigger: this._triggerLabel('button', btn.text, 'button'),
          });
          await page.evaluate((sel, idx) => {
            const el = document.querySelectorAll(sel)[idx];
            if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
          }, sel, btn.idx);
          this._interacted.add(key);
          await new Promise(r => setTimeout(r, 300));
          emitFn('elementInteracted', { type: 'button', text: btn.text });
          count++;
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  }

  // ── Phase 5: fill and submit forms ───────────────────────────────────────

  async _interactForms(page, emitFn) {
    let count = 0;
    try {
      const forms = await page.evaluate(() =>
        Array.from(document.querySelectorAll('form')).map((form, i) => ({
          index:  i,
          action: form.getAttribute('action') || '',
          method: (form.getAttribute('method') || 'GET').toUpperCase(),
          inputs: Array.from(form.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="file"]), textarea, select'
          )).map(inp => ({
            name:        inp.name || inp.id || '',
            type:        (inp.getAttribute('type') || inp.tagName).toLowerCase(),
            placeholder: (inp.placeholder || '').toLowerCase(),
          })).filter(inp => inp.name),
        })).filter(f => f.inputs.length > 0).slice(0, 8)
      );

      for (const form of forms) {
        if (count >= this._maxInteractions) break;
        const formKey = `form:${form.action}:${form.inputs.map(i => i.name).sort().join(',')}`;
        if (this._interacted.has(formKey)) continue;
        try {
          emitFn('interactionStarted', {
            action: this._formActionLabel(form),
            actionType: 'interaction',
            trigger: this._triggerLabel('form', form.action || form.method, 'form-submit'),
          });
          const fillMap = this._fillMap;
          await page.evaluate((formData, fillMap) => {
            const form = document.querySelectorAll('form')[formData.index];
            if (!form) return;
            for (const inp of formData.inputs) {
              const el = form.querySelector(`[name="${inp.name}"]`) || form.querySelector(`#${inp.name}`);
              if (!el) continue;
              const keyword = Object.keys(fillMap).find(k =>
                inp.name.toLowerCase().includes(k) || inp.placeholder.includes(k)
              );
              if (inp.type === 'checkbox' || inp.type === 'radio') {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else if (el.tagName.toLowerCase() === 'select') {
                if (el.options.length > 1) {
                  el.selectedIndex = 1;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              } else {
                const val = keyword ? fillMap[keyword] : (inp.type === 'number' ? '42' : 'test');
                el.value = val;
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }, form, fillMap);

          await page.evaluate((idx) => {
            const form   = document.querySelectorAll('form')[idx];
            const submit = form && (form.querySelector('[type="submit"]') || form.querySelector('button'));
            if (submit) { submit.scrollIntoView({ block: 'center' }); submit.click(); }
          }, form.index);

          this._interacted.add(formKey);
          await new Promise(r => setTimeout(r, 600));
          emitFn('formSubmitted', { action: form.action, method: form.method, fields: form.inputs.length });
          count++;
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  }

  // ── Phase 6: load-more / next-page buttons ───────────────────────────────

  async _interactLoadMore(page, emitFn) {
    let count = 0;
    // Patterns in English and Vietnamese
    const patterns = [
      'load more', 'show more', 'view more', 'see more', 'read more',
      'next', 'next page', 'xem thêm', 'tải thêm', 'tiếp theo',
      'xem tất cả', 'xem thêm tin', 'more results',
    ];
    try {
      const btns = await page.evaluate((patterns) =>
        Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]'))
          .map((el, i) => ({
            idx:  i,
            text: (el.innerText || el.value || '').trim().toLowerCase(),
          }))
          .filter(b => patterns.some(p => b.text.includes(p)))
          .slice(0, 5),
        patterns
      );

      for (const btn of btns) {
        if (count >= 3) break;
        const key = `loadmore:${btn.text}`;
        if (this._interacted.has(key)) continue;
        try {
          emitFn('interactionStarted', {
            action: this._actionLabel('Click', btn.text, 'Load More Button'),
            actionType: 'interaction',
            trigger: this._triggerLabel('load-more', btn.text, 'load-more'),
          });
          await page.evaluate((idx) => {
            const el = Array.from(document.querySelectorAll(
              'button, a, [role="button"], input[type="button"]'
            ))[idx];
            if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
          }, btn.idx);
          this._interacted.add(key);
          await new Promise(r => setTimeout(r, 800));
          emitFn('elementInteracted', { type: 'load-more', text: btn.text });
          count++;
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  }

  getTotalInteractions() { return this._totalInteractions; }

  _actionLabel(verb, text, fallback) {
    const label = String(text || '').trim().replace(/\s+/g, ' ').substring(0, 80);
    return `${verb} ${label || fallback}`;
  }

  _triggerLabel(prefix, text, fallback) {
    const clean = String(text || fallback || '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-_]/g, '')
      .toLowerCase()
      .substring(0, 60);
    return `${prefix}:${clean || fallback}`;
  }

  _formActionLabel(form) {
    const fieldNames = (form.inputs || []).map((i) => String(i.name || '').toLowerCase());
    const hasUserField = fieldNames.some((name) => /user|email|login/.test(name));
    const hasPassField = fieldNames.some((name) => /pass|pwd/.test(name));
    const combined = `${form.action || ''} ${fieldNames.join(' ')}`.toLowerCase();
    if (/(login|log[-_\s]?in|sign[-_\s]?in)/.test(combined) || (hasUserField && hasPassField)) {
      return 'Submit Login Button';
    }
    return `Submit ${(form.method || 'FORM').toUpperCase()} Form`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4: Logger  (Agent 3 – real-time dashboard)
// ════════════════════════════════════════════════════════════════════════════

class Logger {
  constructor() {
    this.status          = 'Idle';
    this.pagesVisited    = 0;
    this.apisDiscovered  = 0;
    this.errorCount      = 0;
    this.currentUrl      = '';
    this.startTime       = null;
    this.progressStarted = false;

    this.multiBar = new cliProgress.MultiBar({
      format: chalk.cyan('{bar}') + ' | {status} | Pages: {pages} | APIs: {apis} | Errors: {errors}',
      barCompleteChar:   '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor:     true,
      clearOnComplete: false,
      stopOnComplete:  false,
    }, cliProgress.Presets.shades_classic);
    this.progressBar = null;
  }

  banner(config) {
    console.log('');
    console.log(chalk.bold.cyan('╔══════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║') + chalk.bold.white('   🕷️  Browserless Crawler & API Discovery   ') + chalk.bold.cyan('║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.gray('  Target:    ') + chalk.white(config.targetUrl));
    console.log(chalk.gray('  Depth:     ') + chalk.white(config.maxDepth));
    console.log(chalk.gray('  Rate:      ') + chalk.white(config.requestsPerSecond + ' req/s'));
    console.log(chalk.gray('  Output:    ') + chalk.white(config.outputFile));
    if (config.authHeader)    console.log(chalk.gray('  Auth:      ') + chalk.green('✓ Configured'));
    if (config.filterTypes && config.filterTypes.length)
      console.log(chalk.gray('  Filter:    ') + chalk.yellow(config.filterTypes.join(', ')));
    if (config.excludePaths && config.excludePaths.length)
      console.log(chalk.gray('  Exclude:   ') + chalk.yellow(config.excludePaths.join(', ')));
    console.log(chalk.gray('  Session:   ') + chalk.cyan('✓ Logout-path protection enabled'));
    if (config.enableInteract)
      console.log(chalk.gray('  Interact:  ') + chalk.cyan('✓ Auto page interaction enabled'));
    console.log('');
  }

  startProgress() {
    this.startTime   = Date.now();
    this.status      = 'Starting';
    this.progressBar = this.multiBar.create(100, 0, { status: chalk.yellow('Starting'), pages: 0, apis: 0, errors: 0 });
    this.progressStarted = true;
  }

  updateProgress() {
    if (!this.progressStarted || !this.progressBar) return;
    this.progressBar.update(Math.min(this.pagesVisited * 10, 99), {
      status: this._fmtStatus(this.status),
      pages:  this.pagesVisited,
      apis:   this.apisDiscovered,
      errors: this.errorCount,
    });
  }

  stopProgress() {
    if (!this.progressStarted) return;
    if (this.progressBar) {
      this.progressBar.update(100, { status: chalk.green('Done'), pages: this.pagesVisited, apis: this.apisDiscovered, errors: this.errorCount });
    }
    this.multiBar.stop();
    this.progressStarted = false;
  }

  logNavigating(url, depth) {
    this.currentUrl = url;
    this.status     = 'Crawling';
    this.logBelow(chalk.gray(`  → [Depth ${depth}] `) + chalk.white(this._truncateUrl(url)));
    this.updateProgress();
  }

  logPageLoad(data) {
    this.pagesVisited = data.visited;
    this.logBelow(chalk.green('  ✓ ') + chalk.gray(`[${data.visited}] `) + chalk.white(data.title || data.url));
    this.updateProgress();
  }

  logApiDiscovered(endpoint) {
    this.apisDiscovered++;
    const method = this._colorMethod(endpoint.method);
    const status = this._colorStatus(endpoint.status);
    this.logBelow(`  ${chalk.magenta('⚡')} ${method} ${chalk.white(endpoint.url)} ${status}`);
    if (endpoint.source) {
      this.logBelow(chalk.gray(`      ↳ source: ${this._truncateUrl(endpoint.source, 95)}`));
    }
    this.updateProgress();
  }

  logError(data) {
    this.errorCount++;
    this.logBelow(chalk.red(`  ✗ [${data.type}] `) + chalk.gray(data.error?.message || 'Unknown error'));
    this.updateProgress();
  }

  logLinksDiscovered(count, depth) {
    if (count > 0) this.logBelow(chalk.gray(`    ├─ Found ${count} new links at depth ${depth}`));
  }

  logAuth(message) {
    this.logBelow(chalk.green('  🔐 ') + chalk.white(message));
  }

  logBrowserConnected(endpoint) {
    this.logBelow(chalk.green('  🌐 ') + chalk.white('Browser connected: ' + (endpoint || 'local')));
  }

  printSummary(stats, outputFile) {
    const elapsed  = stats.duration || ((Date.now() - (this.startTime || Date.now())) / 1000).toFixed(2) + 's';
    const merged   = stats.mergedCount        || 0;
    const filtered = stats.filteredCount      || 0;
    const interact = stats.interactionCount   || 0;
    console.log('');
    console.log(chalk.bold.cyan('┌──────────────────────────────────────────────┐'));
    console.log(chalk.bold.cyan('│') + chalk.bold.white('              📊 Crawl Summary                ') + chalk.bold.cyan('│'));
    console.log(chalk.bold.cyan('├──────────────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + chalk.gray('  Pages Visited:   ') + chalk.bold.white(String(stats.pagesVisited  || this.pagesVisited).padStart(6))   + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  APIs Discovered: ') + chalk.bold.green(String(this.apisDiscovered).padStart(6))                        + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  Dedup Merged:    ') + chalk.bold.yellow(String(merged).padStart(6))                                    + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  Filtered Out:    ') + chalk.bold.gray(String(filtered).padStart(6))                                    + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  Interactions:    ') + chalk.bold.cyan(String(interact).padStart(6))                                    + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  Errors:          ') + chalk.bold.red(String(stats.errors         || this.errorCount).padStart(6))       + '               ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.gray('  Duration:        ') + chalk.bold.white(String(elapsed).padStart(6))                                    + '               ' + chalk.cyan('│'));
    console.log(chalk.bold.cyan('├──────────────────────────────────────────────┤'));
    const outTrunc = this._truncate(outputFile, 33);
    console.log(chalk.cyan('│') + chalk.gray('  Output: ') + chalk.underline.white(outTrunc) + ' '.repeat(Math.max(0, 35 - outTrunc.length)) + chalk.cyan('│'));
    console.log(chalk.bold.cyan('└──────────────────────────────────────────────┘'));
    console.log('');
  }

  logBelow(message) {
    if (this.progressStarted) this.multiBar.log(message + '\n');
    else console.log(message);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _fmtStatus(status) {
    const map = { Crawling: chalk.green, Starting: chalk.yellow, Finishing: chalk.blue, Error: chalk.red };
    return (map[status] || chalk.white)(status);
  }

  _colorMethod(method) {
    const map = { GET: chalk.green, POST: chalk.yellow, PUT: chalk.blue, PATCH: chalk.cyan, DELETE: chalk.red, OPTIONS: chalk.gray, HEAD: chalk.gray };
    return (map[method] || chalk.white)(`[${method}]`.padEnd(9));
  }

  _colorStatus(status) {
    if (!status)                        return '';
    if (status >= 200 && status < 300)  return chalk.green(status);
    if (status >= 300 && status < 400)  return chalk.yellow(status);
    if (status >= 400 && status < 500)  return chalk.red(status);
    if (status >= 500)                  return chalk.bgRed.white(status);
    return chalk.gray(status);
  }

  _truncateUrl(url, max = 70) {
    return url.length > max ? url.substring(0, max - 3) + '...' : url;
  }

  _truncate(str, max = 40) {
    return str.length > max ? '...' + str.substring(str.length - max + 3) : str;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4b: ApiProber  – in-browser REST API discovery
// ════════════════════════════════════════════════════════════════════════════

class ApiProber {
  constructor() {
    this._probedUrls = new Set();
  }

  /**
   * Detect API hints in the current page, fire in-browser fetch() calls to
   * known API paths, and queue discovered REST routes back into the crawler.
   * Because Puppeteer intercepts all page fetch() calls, NetworkMonitor
   * captures each request/response automatically — no extra plumbing needed.
   *
   * @param {import('puppeteer').Page} page
   * @param {string} pageUrl
   * @param {(url: string, depth: number) => void} queueFn
   * @param {number} currentDepth
   * @param {number} maxDepth
   */
  async probe(page, pageUrl, queueFn, currentDepth, maxDepth) {
    const origin = new URL(pageUrl).origin;

    // ── Step 1: extract hints baked into the page ──────────────────────────
    const hints = await page.evaluate(() => {
      const h = { isWP: false, nonce: null, ajaxUrl: null, restBase: null, sitemapUrl: null };

      h.isWP = !!(
        document.querySelector('link[rel="https://api.w.org/"]') ||
        document.documentElement.innerHTML.includes('/wp-json/')
      );

      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const s of scripts) {
        const t = s.textContent;
        const nM = t.match(/"ajax_nonce"\s*:\s*"([^"]+)"/);
        if (nM && !h.nonce) h.nonce = nM[1];

        const aM = t.match(/"ajax_url"\s*:\s*"([^"]+)"/);
        if (aM && !h.ajaxUrl) h.ajaxUrl = aM[1].replace(/\\/g, '');

        const rM = t.match(/"rest"\s*:\s*"([^"\\]+)"/);
        if (rM && !h.restBase) h.restBase = rM[1].replace(/\\/g, '');
      }

      const sitemapLink = document.querySelector('link[rel="sitemap"]');
      if (sitemapLink) h.sitemapUrl = sitemapLink.href;

      return h;
    }).catch(() => ({ isWP: false }));

    // ── Step 2: build list of endpoints to probe ───────────────────────────
    const toFetch = [];

    if (hints.isWP) {
      const restBase = (hints.restBase || `${origin}/wp-json/`).replace(/\/$/, '');

      // REST API index — response contains all registered routes
      toFetch.push(`${restBase}/`);
      // Core collections
      toFetch.push(`${restBase}/wp/v2/posts?per_page=5&_fields=id,link,slug,_links`);
      toFetch.push(`${restBase}/wp/v2/pages?per_page=5&_fields=id,link,slug,_links`);
      toFetch.push(`${restBase}/wp/v2/categories?per_page=20&_fields=id,link,slug`);
      toFetch.push(`${restBase}/wp/v2/tags?per_page=20&_fields=id,link,slug`);
      toFetch.push(`${restBase}/wp/v2/users?per_page=10&_fields=id,link,slug`);
      toFetch.push(`${restBase}/wp/v2/media?per_page=5&_fields=id,source_url,link`);
      toFetch.push(`${restBase}/wp/v2/types`);
      toFetch.push(`${restBase}/wp/v2/taxonomies`);
      toFetch.push(`${restBase}/wp/v2/settings`);

      // Common WordPress plugin REST routes (Elementor, WooCommerce, etc.)
      toFetch.push(`${restBase}/elementor/v1/`);
      toFetch.push(`${restBase}/oembed/1.0/proxy`);

      // Feeds
      toFetch.push(`${origin}/feed`);
      toFetch.push(`${origin}/comments/feed`);

      // Sitemap
      toFetch.push(hints.sitemapUrl || `${origin}/wp-sitemap.xml`);
      toFetch.push(`${origin}/sitemap.xml`);
      toFetch.push(`${origin}/sitemap_index.xml`);

      // xmlrpc introspect (read-only system.listMethods)
      toFetch.push(`${origin}/xmlrpc.php`);
    }

    // Generic REST API paths (non-WP sites)
    for (const p of ['/api/', '/api/v1/', '/api/v2/', '/api/v3/', '/rest/', '/v1/', '/v2/']) {
      toFetch.push(`${origin}${p}`);
    }

    // ── Step 3: fire all fetches from within the browser ──────────────────
    // NetworkMonitor intercepts these automatically.
    const fresh = toFetch.filter(u => !this._probedUrls.has(u));
    fresh.forEach(u => this._probedUrls.add(u));

    if (fresh.length === 0) return;

    const discoveredRoutes = await page.evaluate(async (urls) => {
      window.__apiRoutes = window.__apiRoutes || [];
      window.__apiLinks  = window.__apiLinks  || [];

      for (const url of urls) {
        try {
          const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
          if (!r.ok) continue;

          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('json') && !ct.includes('xml')) continue;

          if (ct.includes('json')) {
            const json = await r.json();

            // WordPress REST index — collect all registered routes
            if (json && json.routes && typeof json.routes === 'object') {
              Object.keys(json.routes).forEach(route => {
                if (!route.includes('(?P<') && !route.includes('<id>'))
                  window.__apiRoutes.push(route);
              });
            }

            // Extract _links.self and collection hrefs from any response
            const extractLinks = (obj, depth = 0) => {
              if (!obj || typeof obj !== 'object' || depth > 3) return;
              if (Array.isArray(obj)) {
                obj.forEach(item => extractLinks(item, depth + 1));
                return;
              }
              if (obj._links) {
                Object.values(obj._links).forEach(links => {
                  (Array.isArray(links) ? links : [links]).forEach(l => {
                    if (l && l.href) window.__apiLinks.push(l.href);
                  });
                });
              }
              if (obj.link && typeof obj.link === 'string') window.__apiLinks.push(obj.link);
              if (obj.url  && typeof obj.url  === 'string') window.__apiLinks.push(obj.url);
            };
            extractLinks(json);
          }
        } catch (_) {}
      }

      return {
        routes: window.__apiRoutes,
        links:  window.__apiLinks,
      };
    }, fresh).catch(() => ({ routes: [], links: [] }));

    // ── Step 4: fetch discovered REST routes directly (NetworkMonitor captures them)
    //           Only queue actual HTML page links for full browser visits.
    const restBase = hints.isWP
      ? (hints.restBase || `${origin}/wp-json/`).replace(/\/$/, '')
      : null;

    const extraFetches = [];
    const htmlLinks    = [];
    const seen         = new Set(fresh);

    for (const route of (discoveredRoutes.routes || [])) {
      try {
        const fullUrl = new URL(route, restBase || origin).href;
        if (!seen.has(fullUrl)) { seen.add(fullUrl); extraFetches.push(fullUrl); }
      } catch (_) {}
    }

    for (const link of (discoveredRoutes.links || [])) {
      try {
        const u = new URL(link, origin);
        if (u.origin !== origin) continue;
        const isRestPath = u.pathname.startsWith('/wp-json/') ||
                           u.pathname.startsWith('/api/');
        if (isRestPath) {
          if (!seen.has(u.href)) { seen.add(u.href); extraFetches.push(u.href); }
        } else {
          // Regular HTML page — queue for browser visit
          htmlLinks.push(u.href);
        }
      } catch (_) {}
    }

    // Fetch REST routes in-browser (batched, without navigating)
    if (extraFetches.length > 0) {
      extraFetches.forEach(u => this._probedUrls.add(u));
      await page.evaluate(async (urls) => {
        for (const url of urls) {
          try { await fetch(url, { credentials: 'include', cache: 'no-store' }); }
          catch (_) {}
        }
      }, extraFetches).catch(() => {});
    }

    // Queue HTML page links for browser visits (respects maxDepth)
    if (currentDepth < maxDepth) {
      for (const link of htmlLinks) {
        queueFn(link, currentDepth + 1);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5: Reporter  (Agent 3 – file I/O & persistence)
// ════════════════════════════════════════════════════════════════════════════

class Reporter {
  constructor(outputFile) {
    this.outputFile  = outputFile;
    this.endpoints   = [];
    this.metadata    = null;
    this.writeStream = null;
    this.firstEntry  = true;
  }

  initialize(config) {
    this.metadata = {
      targetUrl:        config.targetUrl,
      maxDepth:         config.maxDepth,
      requestsPerSecond: config.requestsPerSecond,
      startedAt:        new Date().toISOString(),
    };

    this.writeStream = fs.createWriteStream(this.outputFile, { flags: 'w', encoding: 'utf-8' });
    this.writeStream.write('{\n');
    this.writeStream.write(`  "metadata": ${JSON.stringify(this.metadata, null, 4).split('\n').join('\n  ')},\n`);
    this.writeStream.write('  "endpoints": [\n');
    this.firstEntry = true;
  }

  appendEndpoint(endpoint) {
    this.endpoints.push(endpoint);
    if (!this.writeStream) return;

    const prefix = this.firstEntry ? '    ' : ',\n    ';
    const json   = JSON.stringify(endpoint, null, 6)
      .split('\n').map((line, i) => (i === 0 ? line : '    ' + line)).join('\n');

    this.writeStream.write(prefix + json);
    this.firstEntry = false;
  }

  finalize(stats) {
    if (!this.writeStream) return;

    const summary = {
      completedAt:          new Date().toISOString(),
      pagesVisited:         stats.pagesVisited    || 0,
      totalApisDiscovered:  this.endpoints.length,
      mergedDuplicates:     stats.mergedCount      || 0,
      filteredRequests:     stats.filteredCount    || 0,
      pageInteractions:     stats.interactionCount || 0,
      errors:               stats.errors           || 0,
      duration:             stats.duration         || 'unknown',
    };

    this.writeStream.write('\n  ],\n');
    this.writeStream.write(`  "summary": ${JSON.stringify(summary, null, 4).split('\n').join('\n  ')}\n`);
    this.writeStream.write('}\n');
    this.writeStream.end();
    this.writeStream = null;
  }

  emergencyFlush() {
    if (!this.writeStream) return;
    try {
      this.writeStream.write('\n  ],\n');
      this.writeStream.write(`  "summary": { "status": "interrupted", "endpointsCollected": ${this.endpoints.length} }\n`);
      this.writeStream.write('}\n');
      this.writeStream.end();
    } catch (_) { /* best-effort */ }
    this.writeStream = null;
  }

  getEndpoints()  { return this.endpoints; }
  getOutputPath() { return this.outputFile; }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6: CrawlerEngine  (Agent 1 – browser automation & crawling)
// ════════════════════════════════════════════════════════════════════════════

class CrawlerEngine extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      targetUrl:          config.targetUrl,
      browserlessEndpoint: config.browserlessEndpoint || null,
      maxDepth:           config.maxDepth || 1,
      requestsPerSecond:  config.requestsPerSecond || 1,
      maxConcurrentPages: config.maxConcurrentPages || 1,
      viewport:           config.viewport || { width: 1920, height: 1080 },
      userAgent:          config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      headless:           config.headless !== false,
      authHeader:         config.authHeader || null,
      loginCredentials:   config.loginCredentials || null,
      excludePaths:       config.excludePaths || [],
      ...config,
    };

    this.browser        = null;
    this.visited        = new Set();
    this.queue          = [];
    this.networkMonitor = null;
    this.isRunning      = false;
    this.interactor     = this.config.enableInteract ? new PageInteractor() : null;
    this.apiProber      = new ApiProber();
    this.stats          = { pagesVisited: 0, errors: 0, startTime: null, endTime: null };
  }

  attachNetworkMonitor(monitor) {
    this.networkMonitor = monitor;
  }

  async initialize() {
    try {
      if (this.config.browserlessEndpoint) {
        this.browser = await puppeteer.connect({ browserWSEndpoint: this.config.browserlessEndpoint });
      } else {
        this.browser = await puppeteer.launch({ headless: this.config.headless, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      }
      this.emit('browserConnected', { endpoint: this.config.browserlessEndpoint });
      return true;
    } catch (error) {
      this.emit('onError', { type: 'browser_init', error });
      throw error;
    }
  }

  async authenticate(page) {
    if (this.config.authHeader) {
      await page.setExtraHTTPHeaders(this.config.authHeader);
      this.emit('authHeaderSet', this.config.authHeader);
      return true;
    }
    if (this.config.loginCredentials) return await this.performLogin(page);
    return true;
  }

  async performLogin(page) {
    const { loginUrl, username, password, selectors } = this.config.loginCredentials;
    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      const userSel   = selectors?.username || 'input[name="username"], input[type="email"], input[name="email"]';
      const passSel   = selectors?.password || 'input[name="password"], input[type="password"]';
      const submitSel = selectors?.submit   || 'button[type="submit"], input[type="submit"]';

      await page.waitForSelector(userSel,   { timeout: 10000 });
      await page.type(userSel, username);
      await page.waitForSelector(passSel,   { timeout: 10000 });
      await page.type(passSel, password);

      await Promise.all([
        page.click(submitSel),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      ]);

      if (await page.$(userSel)) throw new Error('Login failed: Form still present after submission');

      this.emit('loginSuccess', { loginUrl });
      return true;
    } catch (error) {
      this.emit('onError', { type: 'authentication', error });
      throw error;
    }
  }

  async extractLinks(page, currentUrl, currentDepth) {
    if (currentDepth >= this.config.maxDepth) return [];
    try {
      const links = await page.evaluate(() => {
        const hrefs = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
        const dataLinks = Array.from(
          document.querySelectorAll('[data-href],[data-url],[data-link],[data-src]')
        ).map(el => el.dataset.href || el.dataset.url || el.dataset.link || el.dataset.src || '');
        return [...new Set([...hrefs, ...dataLinks])].filter(Boolean);
      });
      const baseUrl = new URL(this.config.targetUrl);
      const result  = [];
      for (const link of links) {
        try {
          const lu = new URL(link);
          if (lu.hostname === baseUrl.hostname) {
            const norm = this.normalizeUrl(link);
            if (!this.visited.has(norm) && !this._isPathExcluded(norm)) {
              result.push({ url: norm, depth: currentDepth + 1 });
            }
          }
        } catch (_) { /* invalid URL */ }
      }
      return result;
    } catch (error) {
      this.emit('onError', { type: 'link_extraction', error, url: currentUrl });
      return [];
    }
  }

  normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash  = '';
      const s = u.toString();
      return s.endsWith('/') ? s : s + '/';
    } catch (_) {
      return url;
    }
  }

  _isPathExcluded(url) {
    return this._getPathBlockReason(url) !== null;
  }

  _getPathBlockReason(url) {
    if (this._isSessionRiskPath(url)) return 'session_protection';
    const list = this.config.excludePaths || [];
    if (!list.length) return null;
    try {
      const { pathname } = new URL(url);
      const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
      return list.some((blocked) => path === blocked || path.startsWith(blocked + '/'))
        ? 'exclude_paths'
        : null;
    } catch (_) {
      return null;
    }
  }

  _isSessionRiskPath(url) {
    try {
      const parsed = new URL(url);
      const full = `${parsed.pathname}${parsed.search}`.toLowerCase();
      if (/(^|\/)(log-?out|sign-?out|log-?off|sign-?off)(\/|$|\.|\?)/.test(full)) return true;
      if (/(^|[?&])(action|do|op)=log-?out([&#]|$)/.test(parsed.search.toLowerCase())) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  _cleanPageLabel(text) {
    if (typeof text !== 'string') return '';
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized ? normalized.substring(0, 80) : '';
  }

  _labelFromUrl(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const raw = parts.length ? parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, '') : 'Home';
      const clean = decodeURIComponent(raw).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      return clean ? clean.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : 'Home';
    } catch (_) {
      return 'Page';
    }
  }

  _buildCurrentPageViews(pageChain, currentUrl) {
    const cleanChain = Array.isArray(pageChain)
      ? pageChain.filter((item) => typeof item === 'string' && item.trim()).slice(-2)
      : [];
    if (cleanChain.length > 0) return cleanChain;
    return [this._labelFromUrl(currentUrl)];
  }

  _buildChildPageViews(parentPageViews, childUrl) {
    const parent = Array.isArray(parentPageViews)
      ? parentPageViews.filter((item) => typeof item === 'string' && item.trim()).slice(-1)
      : [];
    const child = this._labelFromUrl(childUrl);
    return [...parent, child];
  }

  async visitPage(url, depth, pageChain = []) {
    let page = null;
    try {
      const blockReason = this._getPathBlockReason(url);
      if (blockReason) {
        this.emit('pathExcluded', { url, depth, reason: blockReason });
        return;
      }

      page = await this.browser.newPage();
      await page.setViewport(this.config.viewport);
      await page.setUserAgent(this.config.userAgent);
      const sourceState = {
        pageViews: this._buildCurrentPageViews(pageChain, url),
        actionLabel: 'Page View',
        actionType: 'page_view',
        trigger: 'navigation',
        currentPageUrl: url,
      };

      if (depth === 0) {
        await this.authenticate(page);
      } else if (this.config.authHeader) {
        await page.setExtraHTTPHeaders(this.config.authHeader);
      }

      // Inject before-navigation script to track SPA route changes
      await page.evaluateOnNewDocument(() => {
        window.__spaNavigations = [];
        try {
          const _push    = history.pushState.bind(history);
          const _replace = history.replaceState.bind(history);
          history.pushState = function(s, t, url) {
            if (url) window.__spaNavigations.push(String(new URL(url, location.href)));
            return _push(s, t, url);
          };
          history.replaceState = function(s, t, url) {
            if (url) window.__spaNavigations.push(String(new URL(url, location.href)));
            return _replace(s, t, url);
          };
          window.addEventListener('hashchange', () => {
            window.__spaNavigations.push(location.href);
          });
        } catch (_) {}
      });

      if (this.networkMonitor) {
        await this.networkMonitor.attachToPage(page, () => ({
          pageViews: [...sourceState.pageViews],
          action: sourceState.actionLabel,
          actionType: sourceState.actionType,
          trigger: sourceState.trigger,
          currentPageUrl: sourceState.currentPageUrl,
        }));
      }

      this.emit('navigating', { url, depth });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      this.visited.add(this.normalizeUrl(url));
      this.stats.pagesVisited++;

      const pageTitle = await page.title();
      sourceState.currentPageUrl = page.url() || sourceState.currentPageUrl;
      const cleanTitle = this._cleanPageLabel(pageTitle);
      if (cleanTitle) {
        sourceState.pageViews = sourceState.pageViews.length > 1
          ? [...sourceState.pageViews.slice(0, -1), cleanTitle]
          : [cleanTitle];
      }
      sourceState.actionLabel = 'Page View';
      sourceState.actionType = 'page_view';
      sourceState.trigger = 'page-load';
      this.emit('onPageLoad', { url, depth, title: pageTitle, visited: this.stats.pagesVisited });

      // Probe REST APIs and fire in-browser fetches (captured by NetworkMonitor)
      sourceState.actionLabel = 'Auto API Probe';
      sourceState.actionType = 'system';
      sourceState.trigger = 'api-prober';
      await this.apiProber.probe(
        page, url,
        (queueUrl, queueDepth) => {
          const norm = this.normalizeUrl(queueUrl);
          if (!this.visited.has(norm) && !this._getPathBlockReason(norm)) {
            this.queue.push({
              url: norm,
              depth: queueDepth,
              pageChain: this._buildChildPageViews(sourceState.pageViews, norm),
            });
          }
        },
        depth, this.config.maxDepth
      );
      await this._waitForQuiet(page, 2000);
      sourceState.actionLabel = 'Page View';
      sourceState.actionType = 'page_view';
      sourceState.trigger = 'idle';

      // Feature 3: interact with page to trigger additional requests
      if (this.interactor) {
        const interacted = await this.interactor.interact(page, (event, data) => {
          if (event === 'interactionStarted') {
            sourceState.actionLabel = data && data.action ? data.action : 'Action';
            sourceState.actionType = data && data.actionType ? data.actionType : 'interaction';
            sourceState.trigger = data && data.trigger ? data.trigger : 'manual';
            return;
          }
          this.emit(event, data);
        });
        if (interacted > 0) {
          this.emit('pageInteracted', { url, count: interacted });
          await this._waitForQuiet(page, 2000);
        }
      }

      // Collect SPA navigations triggered by JS interactions and queue them
      const spaLinks = await page.evaluate(() => window.__spaNavigations || []).catch(() => []);
      const baseHostname = new URL(this.config.targetUrl).hostname;
      for (const spaUrl of spaLinks) {
        try {
          const u = new URL(spaUrl);
          if (u.hostname === baseHostname) {
            const norm = this.normalizeUrl(u.toString());
            if (!this.visited.has(norm) && !this._getPathBlockReason(norm) && depth + 1 <= this.config.maxDepth)
              this.queue.push({
                url: norm,
                depth: depth + 1,
                pageChain: this._buildChildPageViews(sourceState.pageViews, norm),
              });
          }
        } catch (_) {}
      }

      const newLinks = await this.extractLinks(page, url, depth);
      for (const link of newLinks) {
        if (!this._getPathBlockReason(link.url)) {
          this.queue.push({
            ...link,
            pageChain: this._buildChildPageViews(sourceState.pageViews, link.url),
          });
        }
      }
      this.emit('linksDiscovered', { count: newLinks.length, depth: depth + 1 });

    } catch (error) {
      this.stats.errors++;
      this.emit('onError', { type: 'navigation', error, url, depth });
    } finally {
      if (page) await page.close();
    }
  }

  // Wait for network to go quiet after interactions
  async _waitForQuiet(page, maxWaitMs = 2000) {
    try {
      await page.waitForNetworkIdle({ idleTime: 400, timeout: maxWaitMs });
    } catch (_) {
      // waitForNetworkIdle not available or timed out — use a fixed fallback
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async rateLimit() {
    await new Promise(resolve => setTimeout(resolve, 1000 / this.config.requestsPerSecond));
  }

  async start() {
    if (this.isRunning) throw new Error('Crawler is already running');
    this.isRunning       = true;
    this.stats.startTime = Date.now();

    try {
      await this.initialize();

      const startUrl = this.normalizeUrl(this.config.targetUrl);
      const startBlockReason = this._getPathBlockReason(startUrl);
      if (startBlockReason) {
        const reasonText = startBlockReason === 'session_protection'
          ? 'session-protection guard'
          : '--exclude-paths';
        throw new Error(`Target URL path is blocked by ${reasonText}: ${startUrl}`);
      }
      this.queue.push({ url: startUrl, depth: 0, pageChain: [this._labelFromUrl(startUrl)] });
      this.emit('crawlStarted', { targetUrl: this.config.targetUrl, maxDepth: this.config.maxDepth, requestsPerSecond: this.config.requestsPerSecond });

      while (this.queue.length > 0 && this.isRunning) {
        const batchSize   = Math.min(this.config.maxConcurrentPages, this.queue.length);
        const activeTasks = [];
        for (let i = 0; i < batchSize; i++) {
          const item = this.queue.shift();
          if (item && !this.visited.has(item.url)) {
            const blockReason = this._getPathBlockReason(item.url);
            if (blockReason) {
              this.emit('pathExcluded', { url: item.url, depth: item.depth, reason: blockReason });
              continue;
            }
            activeTasks.push(this.visitPage(item.url, item.depth, item.pageChain));
          }
        }
        if (activeTasks.length > 0) {
          await Promise.all(activeTasks);
          await this.rateLimit();
        }
      }

      this.stats.endTime = Date.now();
      const duration     = ((this.stats.endTime - this.stats.startTime) / 1000).toFixed(2) + 's';
      this.emit('crawlCompleted', { pagesVisited: this.stats.pagesVisited, errors: this.stats.errors, duration });

    } catch (error) {
      this.emit('onError', { type: 'crawl', error });
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  async stop() {
    this.isRunning = false;
    this.emit('crawlStopped');
  }

  async cleanup() {
    this.isRunning = false;
    if (this.browser) {
      try { await this.browser.close(); this.emit('browserClosed'); }
      catch (error) { this.emit('onError', { type: 'cleanup', error }); }
    }
  }

  getStats() {
    return { ...this.stats, queueSize: this.queue.length, visitedCount: this.visited.size, isRunning: this.isRunning };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7: CLI Entry Point  (Agent 3 – orchestration)
// ════════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name('index')
  .description('Authenticated web crawler with API discovery using Browserless/Puppeteer')
  .version('1.0.0')
  .argument('<url>', 'Target URL to crawl (required)')
  .option('-a, --auth <token>',          'Auth token, "Header: Value" string, or path to credentials JSON file')
  .option('-d, --depth <number>',        'Maximum crawl depth (default: 1)', '1')
  .option('-l, --limit <number>',        'Rate limit in requests per second (default: 1)', '1')
  .option('-o, --output <path>',         'Output file path (default: ./output.json)', './output.json')
  .option('-c, --concurrency <number>',  'Max concurrent pages (default: 1)', '1')
  .option('-b, --browserless <endpoint>','Browserless WebSocket endpoint URL')
  .option('--no-headless',               'Run browser in headed mode (visible)')
  .option('--user-agent <string>',       'Custom User-Agent string')
  .option('--filter <types>',            'Comma-separated resource types to exclude from output (css,js,image,font,media,document,xhr,fetch)')
  .option('--exclude-paths <paths>',     'Comma-separated path prefixes to block (e.g. /admin,/private,/internal)')
  .option('--hide-filtered',             'Suppress filtered-type requests from real-time log')
  .option('--no-interact',               'Disable automatic page interaction (buttons, forms)')
  .action(run);

program.parse(process.argv);

async function run(url, options) {
  const logger = new Logger();

  try {
    // 1. Validate & build config
    const config = ConfigValidator.validate({
      url,
      auth:         options.auth,
      depth:        options.depth,
      limit:        options.limit,
      output:       options.output,
      concurrency:  options.concurrency,
      browserless:  options.browserless,
      headless:     options.headless,
      userAgent:    options.userAgent,
      filter:       options.filter,
      excludePaths: options.excludePaths,
      hideFiltered: options.hideFiltered,
      interact:     options.interact,
    });

    // 2. Show banner
    logger.banner(config);

    // 3. Initialize Reporter
    const reporter = new Reporter(config.outputFile);
    reporter.initialize(config);

    // 4. Instantiate NetworkMonitor and CrawlerEngine
    const monitor = new NetworkMonitor({
      filterTypes: config.filterTypes,
      hideFiltered: config.hideFiltered,
      excludePaths: config.excludePaths,
    });
    const crawler = new CrawlerEngine(config);

    // 5. Wire Agent 2 → Agent 3
    crawler.attachNetworkMonitor(monitor);
    monitor.on('apiDiscovered', (endpoint) => {
      logger.logApiDiscovered(endpoint);
      reporter.appendEndpoint(endpoint);
    });

    // 6. Wire Agent 1 events → Logger
    crawler.on('browserConnected', (data) => logger.logBrowserConnected(data.endpoint));
    crawler.on('authHeaderSet',    ()     => logger.logAuth('Auth headers injected'));
    crawler.on('loginSuccess',     (data) => logger.logAuth(`Login successful: ${data.loginUrl}`));
    crawler.on('crawlStarted',     ()     => logger.startProgress());
    crawler.on('navigating',       (data) => logger.logNavigating(data.url, data.depth));
    crawler.on('onPageLoad',       (data) => logger.logPageLoad(data));
    crawler.on('linksDiscovered',  (data) => logger.logLinksDiscovered(data.count, data.depth));
    crawler.on('onError',          (data) => logger.logError(data));
    crawler.on('pathExcluded',     (data) => {
      const reasonText = data.reason === 'session_protection' ? 'session safeguard' : 'exclude list';
      logger.logBelow(chalk.yellow(`  ⤫ Skipped (${reasonText}): `) + chalk.gray(logger._truncateUrl(data.url)));
    });
    crawler.on('pageInteracted',   (data) => {
      logger.logBelow(chalk.cyan(`  🖱️  Interacted with ${data.count} element(s) on `) + chalk.gray(logger._truncateUrl(data.url)));
    });

    crawler.on('crawlCompleted', (stats) => {
      const enriched = {
        ...stats,
        mergedCount:      monitor.getMergedCount(),
        filteredCount:    monitor.getFilteredCount(),
        interactionCount: crawler.interactor ? crawler.interactor.getTotalInteractions() : 0,
      };
      logger.stopProgress();
      reporter.finalize(enriched);
      logger.printSummary(enriched, reporter.getOutputPath());
    });

    crawler.on('crawlStopped', () => {
      logger.stopProgress();
      reporter.finalize({
        pagesVisited:     logger.pagesVisited,
        errors:           logger.errorCount,
        duration:         'interrupted',
        mergedCount:      monitor.getMergedCount(),
        filteredCount:    monitor.getFilteredCount(),
        interactionCount: crawler.interactor ? crawler.interactor.getTotalInteractions() : 0,
      });
      logger.logBelow('  ⏹  Crawl stopped by user.');
    });

    // 7. Graceful shutdown
    const shutdown = async (signal) => {
      logger.logBelow(`\n  ⚠  Received ${signal}. Shutting down gracefully...`);
      await crawler.stop();
      reporter.emergencyFlush();
      process.exit(0);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
      logger.logError({ type: 'uncaughtException', error: err });
      reporter.emergencyFlush();
      process.exit(1);
    });

    // 8. Start the crawl
    await crawler.start();

  } catch (error) {
    const msg = error.message || String(error);
    console.error('\n  ' + chalk.red('✗ Error: ') + msg + '\n');
    process.exit(1);
  }
}
