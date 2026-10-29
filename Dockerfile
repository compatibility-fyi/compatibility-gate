FROM node:26.13.0-alpine3.23@sha256:e6c03d42b46af3b1e98207e59f06a43cfe5efd3ec4b4d3d9802bddf04f833374

RUN apk add --no-cache ca-certificates git

LABEL org.opencontainers.image.source="https://github.com/compatibility-fyi/compatibility-gate" \
      org.opencontainers.image.description="Gate Renovate updates with source-backed compatibility.fyi metadata" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /opt/compatibility-gate
COPY dist/cli.js ./cli.js
