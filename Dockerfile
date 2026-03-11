# ─── Stage 1: dependencies ───────────────────────────────────────────────────
FROM node:18-slim AS deps

WORKDIR /app
COPY package*.json ./

# Skip Puppeteer's bundled Chromium download — we use the system one instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN npm ci --only=production

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:18-slim

# Install Chromium and its runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libgdk-pixbuf2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer where to find Chromium and don't re-download it
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY index.js ./

# Output directory (mount a host volume here to persist results)
RUN mkdir -p /app/output

ENTRYPOINT ["node", "index.js"]
# Default: print help. Override with: docker run ... <url> [options]
CMD ["--help"]
