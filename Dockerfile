FROM node:24-alpine3.22 AS client-build
WORKDIR /app
COPY client/package*.json ./client/
RUN npm ci --prefix client --ignore-scripts
COPY client/ ./client/
RUN node client/build.mjs

FROM rust:1.90-alpine3.22 AS server-build
RUN apk add --no-cache build-base
WORKDIR /app
COPY eya-server/Cargo.toml eya-server/Cargo.lock ./eya-server/
COPY eya-server/src ./eya-server/src
COPY client/generator.html ./client/generator.html
COPY --from=client-build /app/client.html ./client.html
RUN cargo build --manifest-path eya-server/Cargo.toml --release --locked

FROM alpine:3.22
RUN apk add --no-cache ca-certificates util-linux
COPY --from=server-build /app/eya-server/target/release/eya-server /usr/local/bin/eya-server
WORKDIR /app
ENV EYA_BIND=0.0.0.0:8080 EYA_HOST_PID=1 EYA_NSENTER=/usr/bin/nsenter EYA_HOST_SU=/bin/su
EXPOSE 8080
CMD ["eya-server"]
