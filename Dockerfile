# Playwright-image bevat Chromium + alle systeembibliotheken voor screenshots.
# Versie moet gelijk zijn aan playwright-core in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4300

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Database + screenshots blijven bewaard in een volume.
VOLUME ["/app/data"]
EXPOSE 4300

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
