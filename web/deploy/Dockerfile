# Playwright's image ships the Chromium build and system libraries that match playwright 1.63.0.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace's package.json must be present for npm ci to match the lockfile (workspaces: site, backend, extension, tests).
COPY site/package.json site/package.json
COPY backend/package.json backend/package.json
COPY extension/package.json extension/package.json
COPY tests/package.json tests/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY backend ./backend
COPY site ./site
COPY web ./web
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
# Chromium's own sandbox needs privileges the container does not grant; the container (non-root, no published ports) is the boundary.
ENV NODE_ENV=production WEB_PORT=4300 SPEND_FILE=/data/spend.json NO_SANDBOX=1
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4300/api/health').then(r=>r.json()).then(j=>process.exit(j.browser==='up'?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "web/src/main.ts"]
