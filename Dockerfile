FROM ghcr.io/puppeteer/puppeteer:23.9.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN chown -R pptruser:pptruser /app

USER pptruser
RUN npm install --omit=dev \
    && npx puppeteer browsers install chrome

COPY --chown=pptruser:pptruser . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
