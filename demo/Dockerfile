# syntax=docker/dockerfile:1
# Go helpers: podsicheck (independent PoDSI verification) and aggplan (aggregate CID from child CIDs).
FROM golang:1.26-trixie AS go
WORKDIR /src
COPY --from=podsicheck . podsicheck/
COPY aggplan/ aggplan/
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    cd podsicheck && go build -o /out/podsicheck . && cd ../aggplan && go build -o /out/aggplan .

FROM node:24-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
COPY --from=go /out/ /usr/local/bin/
ENV PORT=8787 DATA_DIR=/data WEB_DIR=dist
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
