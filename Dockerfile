FROM node:26.13.0-alpine3.23@sha256:44a3247313f9bc069a4ec25d01b66254ed7dc4d0408727d8720dc827f0753423

RUN apk add --no-cache ca-certificates git

LABEL org.opencontainers.image.source="https://github.com/compatibility-fyi/compatibility-gate" \
      org.opencontainers.image.description="Gate Renovate updates with source-backed compatibility.fyi metadata" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /opt/compatibility-gate
COPY dist/cli.js ./cli.js
