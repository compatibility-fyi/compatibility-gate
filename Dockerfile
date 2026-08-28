FROM node:24.20.0-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca

RUN apk add --no-cache ca-certificates git

LABEL org.opencontainers.image.source="https://github.com/compatibility-fyi/compatibility-gate" \
      org.opencontainers.image.description="Gate Renovate updates with source-backed compatibility.fyi metadata" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /opt/compatibility-gate
COPY dist/cli.js ./cli.js
