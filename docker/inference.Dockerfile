# Build a pinned upstream revision for both ARM64 Macs and x86 Linux.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake build-essential libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init && git remote add origin https://github.com/ggml-org/llama.cpp.git && git fetch --depth 1 origin 2d973636e292ee6f75fadcf08d29cb33511f509f && git checkout FETCH_HEAD
RUN cmake -B build -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=ON -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF && cmake --build build --target llama-server -j 4
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home inference && mkdir /models && chown inference:inference /models
COPY --from=build /src/build/bin/llama-server /usr/local/bin/llama-server
USER inference
ENV LLAMA_CACHE=/models
ENTRYPOINT ["llama-server"]
