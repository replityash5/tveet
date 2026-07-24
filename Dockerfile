FROM ghcr.io/puppeteer/puppeteer:23.9.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install --omit=dev

COPY . .

USER pptruser
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
