# Gradescope autograder image (DESIGN.md §8; BACKEND.md task B10).
#
# Multi-stage: build the musl-static `csim` in a Rust toolchain image,
# then copy the single dependency-free binary into a tiny runtime image.
# The build stage runs the full test suite; the final stage runs a
# fixture sanity self-test so a broken image never reaches Gradescope.
#
#   docker build -t csim-autograder -f gradescope/Dockerfile .
#
# The 2 GB container / 10 s acceptance (task B10, M1) is exercised by
# `csim run` on tests/fixtures/pipeline5.csx (task B11).

FROM rust:1-bookworm AS build
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /src
# Dependency layer first for cache friendliness. The workspace includes
# crates/app (Tauri desktop shell); its manifest must parse, but nothing
# here compiles it (no webview system deps in this image).
COPY Cargo.toml Cargo.lock ./
COPY crates/core/Cargo.toml crates/core/Cargo.toml
COPY crates/cli/Cargo.toml crates/cli/Cargo.toml
COPY crates/app/Cargo.toml crates/app/Cargo.toml
RUN mkdir -p crates/core/src crates/cli/src crates/app/src \
    && echo "pub fn stub() {}" > crates/core/src/lib.rs \
    && echo "fn main() {}" > crates/cli/src/main.rs \
    && echo "fn main() {}" > crates/app/src/main.rs \
    && cargo build --release -p csim --target x86_64-unknown-linux-musl \
    && rm -rf crates
# Real sources + the backend test suite, then the release binary.
# NOTE: `touch` defeats the cargo+Docker mtime gotcha — COPY can give
# sources mtimes older than the dependency layer's artifacts, making
# cargo skip the real rebuild and ship the stub binary.
COPY crates crates
COPY docs docs
COPY tests tests
RUN find crates -name '*.rs' -exec touch {} + \
    && cargo test -p csim-core -p csim --release \
    && cargo build --release -p csim --target x86_64-unknown-linux-musl \
    && strip target/x86_64-unknown-linux-musl/release/csim \
    && ./target/x86_64-unknown-linux-musl/release/csim --version

FROM alpine:3.20 AS runtime
RUN adduser -D grader
COPY --from=build /src/target/x86_64-unknown-linux-musl/release/csim /usr/local/bin/csim
COPY tests/fixtures /fixtures

USER grader
ENTRYPOINT ["csim"]

# Sanity self-test (separate stage so `runtime` stays inspectable): the
# shipped binary must validate and grade a fixture end-to-end inside the
# runtime image (no toolchain, no deps). `docker build` (default target =
# last stage) runs it; a failure fails the build.
FROM runtime AS selftest
USER root
RUN csim validate /fixtures/sanity.csx \
    && csim run /fixtures/sanity.csx --cycles 3 \
       --assert "probe('r1') == 1" \
       --assert "violations == 0" \
       --json /tmp/report.json \
    && grep -q '"t_obs": 39' /tmp/report.json \
    && rm /tmp/report.json
USER grader
