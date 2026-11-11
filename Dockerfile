# syntax=docker/dockerfile:1
# The download queue with a browser of its own, for a machine that runs around the clock (any CPU: amd64, arm64).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates tini xvfb x11vnc \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PMS_DATA_DIR=/data \
    PMS_DOWNLOAD_DIR=/media \
    PMS_BROWSER=/usr/bin/chromium \
    PMS_BROWSER_ARGS="--no-sandbox --disable-gpu --disable-dev-shm-usage" \
    PMS_API_HOST=0.0.0.0 \
    PMS_API_ALLOWED_HOSTS="localhost:38542,127.0.0.1:38542,media-downloader:38542"

WORKDIR /app
COPY --chown=node:node package.json manifest.json ./
COPY --chown=node:node cli ./cli
COPY --chown=node:node lib ./lib
COPY --chown=node:node src ./src
COPY docker/entrypoint.sh /usr/local/bin/pms-entrypoint
RUN chmod +x /usr/local/bin/pms-entrypoint && mkdir -p /data /media && chown node:node /data /media

USER node
VOLUME ["/data", "/media"]
EXPOSE 38542
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:38542/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pms-entrypoint"]
CMD ["serve"]
