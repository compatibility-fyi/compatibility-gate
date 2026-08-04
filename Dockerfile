FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995

RUN apk add --no-cache ca-certificates git

LABEL org.opencontainers.image.source="https://github.com/compatibility-fyi/compatibility-gate" \
      org.opencontainers.image.description="Gate Renovate updates with source-backed compatibility.fyi metadata" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /opt/compatibility-gate
COPY dist/cli.js ./cli.js
