FROM node:26.13.1-alpine3.23@sha256:2a7b5ab38661380b55e8ac9f94badae404229af748f1b2fdee80e595df052d8c

RUN apk add --no-cache ca-certificates git

LABEL org.opencontainers.image.source="https://github.com/compatibility-fyi/compatibility-gate" \
      org.opencontainers.image.description="Gate Renovate updates with source-backed compatibility.fyi metadata" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /opt/compatibility-gate
COPY dist/cli.js ./cli.js
