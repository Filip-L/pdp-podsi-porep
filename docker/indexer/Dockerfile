ARG CURIO_TEST_IMAGE=porep-market-curio-devnet/curio-all-in-one:409a2ab3510d
#############################################################################
FROM ${CURIO_TEST_IMAGE}

ARG BUILD_VERSION=0.1

LABEL org.opencontainers.image.version=$BUILD_VERSION \
      org.opencontainers.image.authors="Curio Dev Team" \
      name="indexer-dev" \
      maintainer="Curio Dev Team" \
      vendor="Curio Dev Team" \
      version=$BUILD_VERSION \
      release=$BUILD_VERSION \
      summary="This image is used to host the curio dev service" \
      description="This image is used to host the curio dev service"

EXPOSE 12320


WORKDIR /app
RUN mkdir -p /app

COPY entrypoint.sh /app

USER root

ENTRYPOINT ["./entrypoint.sh"]
