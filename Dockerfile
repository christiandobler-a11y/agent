# Avelio im Betrieb (Schritt 9). Basis ist das offizielle Playwright-Image: Chromium samt Systembibliotheken passt
# genau zur Playwright-Version aus package-lock.json. Bei einem Playwright-Update beide Tags mitziehen.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY prompts ./prompts
COPY migrations ./migrations
COPY docker/entrypoint.sh /usr/local/bin/avelio-entrypoint
RUN mkdir -p /app/data/screenshots && chown -R pwuser:pwuser /app/data
# Nicht als root laufen (Benutzer kommt aus dem Playwright-Image).
USER pwuser
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["avelio-entrypoint"]
CMD ["node", "dist/main.js"]
