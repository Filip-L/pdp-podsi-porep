ARG RUST_TOOLCHAIN_IMAGE=docker.io/library/rust:1.86.0-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944
ARG GO_BUILDER_IMAGE=docker.io/library/golang:1.26-trixie@sha256:6427f09fc28b78d6ccac20bbc2011794126b49f2f43c424aa5a197c642a8be36
ARG NODE_RUNTIME_IMAGE=docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd
ARG UBUNTU_RUNTIME_IMAGE=docker.io/library/ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

FROM ${RUST_TOOLCHAIN_IMAGE} AS rust-toolchain

FROM ${GO_BUILDER_IMAGE} AS blst-builder

WORKDIR /opt/blst
COPY --from=blst-source /build.sh ./build.sh
COPY --from=blst-source /build/ ./build/
COPY --from=blst-source /src/ ./src/
COPY --from=blst-source /bindings/ ./bindings/
COPY --from=blst-source /LICENSE ./LICENSE
RUN ./build.sh \
    && test -s libblst.a

FROM ${GO_BUILDER_IMAGE} AS curio-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      git \
      jq \
      libhwloc-dev \
      make \
      ocl-icd-libopencl1 \
      ocl-icd-opencl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH} \
    XDG_CACHE_HOME=/tmp

WORKDIR /opt/curio
COPY go.mod go.sum ./
COPY extern/filecoin-ffi/go.mod extern/filecoin-ffi/go.sum ./extern/filecoin-ffi/

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .
COPY --from=harness-overlay patches/curio/0001-sptool-mk20-notification-flags.patch /tmp/sptool-mk20-notification-flags.patch
RUN git apply --check /tmp/sptool-mk20-notification-flags.patch \
    && git apply /tmp/sptool-mk20-notification-flags.patch
COPY --from=harness-overlay patches/curio/0002-sptool-mk20-aggregate-raw-subpieces.patch /tmp/sptool-mk20-aggregate-raw-subpieces.patch
RUN git apply --check /tmp/sptool-mk20-aggregate-raw-subpieces.patch \
    && git apply /tmp/sptool-mk20-aggregate-raw-subpieces.patch
COPY --from=blst-builder /opt/blst /opt/curio/extern/supraseal/deps/blst

ARG CURIO_COMMIT
ARG CURIO_FFI_COMMIT
ARG CURIO_TAGS="cunative debug nosupraseal"

RUN mkdir -p build \
    && touch build/.update-modules build/.blst-install \
    && FFI_BUILD_FROM_SOURCE=1 \
       FFI_GIT_COMMIT="${CURIO_FFI_COMMIT}" \
       FFI_USE_OPENCL=1 \
       DISABLE_SUPRASEAL=1 \
       CARGO_BUILD_JOBS=2 \
       GOMAXPROCS=2 \
       make build \
         CURIO_BUILD_COMMIT="${CURIO_COMMIT}" \
         CURIO_TAGS="${CURIO_TAGS}"

FROM ${GO_BUILDER_IMAGE} AS lotus-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      git \
      jq \
      libhwloc-dev \
      make \
      ocl-icd-libopencl1 \
      ocl-icd-opencl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH} \
    XDG_CACHE_HOME=/tmp

WORKDIR /opt/lotus
COPY --from=lotus-source / ./

# No prebuilt lotus-vX-devnet image exists past v1.36.1, so build the debug
# (2k + insecure PoSt) DevNet binaries from the verified managed source.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    mkdir -p build \
    && touch build/.update-modules \
    && FFI_BUILD_FROM_SOURCE=1 \
       FFI_USE_OPENCL=1 \
       CARGO_BUILD_JOBS=2 \
       GOMAXPROCS=2 \
       make debug-lotus debug-lotus-miner debug-lotus-seed debug-lotus-shed

FROM ${GO_BUILDER_IMAGE} AS service-tool-builder

ARG GO_CAR_COMMIT
ARG PIECE_SERVER_COMMIT
ARG STORETHEINDEX_COMMIT
ARG GO_ETHEREUM_COMMIT

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOMAXPROCS=2 go install "github.com/ipld/go-car/cmd/car@${GO_CAR_COMMIT}"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOMAXPROCS=2 go install "github.com/LexLuthr/piece-server@${PIECE_SERVER_COMMIT}"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOMAXPROCS=2 go install "github.com/ipni/storetheindex@${STORETHEINDEX_COMMIT}"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOMAXPROCS=2 go install "github.com/ethereum/go-ethereum/cmd/geth@${GO_ETHEREUM_COMMIT}"

# filecoin-services v1.5+ assembles the ERC-8167 dispatcher with wjmelements/evm at the
# revision pinned in service_contracts/Makefile (EVM_REVISION).
FROM ${UBUNTU_RUNTIME_IMAGE} AS evm-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      autoconf \
      automake \
      build-essential \
      ca-certificates \
      libcurl4-openssl-dev \
      libtool \
      perl \
    && rm -rf /var/lib/apt/lists/*

ADD https://github.com/wjmelements/evm.git#98409233b4ed9fb79efa013fe17ad42b155adf03 /opt/evm
WORKDIR /opt/evm
RUN make bin/evm \
    && test -x bin/evm

FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

FROM ${FOUNDRY_IMAGE} AS foundry

FROM ${UBUNTU_RUNTIME_IMAGE} AS curio-all-in-one

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      aria2 \
      ca-certificates \
      curl \
      dnsutils \
      git \
      jq \
      libhwloc15 \
      libltdl7 \
      libnuma1 \
      make \
      ocl-icd-libopencl1 \
      vim \
      wget \
      xxd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=foundry /usr/local/bin/chisel /usr/local/bin/chisel
COPY --from=evm-builder /opt/evm/bin/evm /usr/local/bin/evm

COPY --from=lotus-builder /opt/lotus/lotus /usr/local/bin/lotus
COPY --from=lotus-builder /opt/lotus/lotus-seed /usr/local/bin/lotus-seed
COPY --from=lotus-builder /opt/lotus/lotus-shed /usr/local/bin/lotus-shed
COPY --from=lotus-builder /opt/lotus/lotus-miner /usr/local/bin/lotus-miner
COPY --from=curio-builder /opt/curio/curio /usr/local/bin/curio
COPY --from=curio-builder /opt/curio/sptool /usr/local/bin/sptool
COPY --from=service-tool-builder /go/bin/car /usr/local/bin/car
COPY --from=service-tool-builder /go/bin/piece-server /usr/local/bin/piece-server
COPY --from=service-tool-builder /go/bin/storetheindex /usr/local/bin/storetheindex
COPY --from=service-tool-builder /go/bin/geth /usr/local/bin/geth

RUN useradd -r -u 532 -U fc \
    && mkdir -p \
      /etc/OpenCL/vendors \
      /var/lib/curio \
      /var/lib/curio-client \
      /var/lib/indexer \
      /var/lib/lotus \
      /var/lib/lotus-miner \
      /var/tmp/filecoin-proof-parameters \
    && printf '%s\n' 'libnvidia-opencl.so.1' > /etc/OpenCL/vendors/nvidia.icd \
    && chown fc: \
      /var/lib/curio \
      /var/lib/curio-client \
      /var/lib/indexer \
      /var/lib/lotus \
      /var/lib/lotus-miner \
      /var/tmp/filecoin-proof-parameters

ARG CURIO_COMMIT
ARG LOTUS_COMMIT
ARG BLST_COMMIT
ARG DOCKERFILE_SHA256

LABEL org.opencontainers.image.revision="${CURIO_COMMIT}" \
      io.porep-market.curio.commit="${CURIO_COMMIT}" \
      io.porep-market.lotus.commit="${LOTUS_COMMIT}" \
      io.porep-market.blst.commit="${BLST_COMMIT}" \
      io.porep-market.dockerfile.sha256="${DOCKERFILE_SHA256}"

ENV CURIO_MK12_CLIENT_REPO=/var/lib/curio-client \
    CURIO_REPO_PATH=/var/lib/curio \
    FIL_PROOFS_PARAMETER_CACHE=/var/tmp/filecoin-proof-parameters \
    LOTUS_MINER_PATH=/var/lib/lotus-miner \
    LOTUS_PATH=/var/lib/lotus \
    STORETHEINDEX_PATH=/var/lib/indexer

EXPOSE 1234 2345 12300 4701 32100 12310 12320 3000 3001 3002 3003
CMD ["/bin/bash"]
