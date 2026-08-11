FROM rocker/r-ver:4.5.3

ARG APP_UID=10001
ARG APP_GID=10001

# Install system dependencies required for Seurat, Plumber, and other R packages
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libhdf5-dev \
    libsodium-dev \
    libuv1-dev \
    libfontconfig1-dev \
    libharfbuzz-dev \
    libfribidi-dev \
    libpng-dev \
    libtiff5-dev \
    libjpeg-dev \
    patch \
    && rm -rf /var/lib/apt/lists/*

# RcppEigen emits thousands of harmless GCC attribute warnings on the hosted
# Linux runner. Keep useful compiler errors visible while suppressing that one
# warning class for build-time source compilation only.
RUN install -d -m 0755 /root/.R \
    && printf '%s\n' \
      'CXXFLAGS += -Wno-ignored-attributes' \
      'CXX11FLAGS += -Wno-ignored-attributes' \
      'CXX14FLAGS += -Wno-ignored-attributes' \
      'CXX17FLAGS += -Wno-ignored-attributes' \
      'CXX20FLAGS += -Wno-ignored-attributes' \
      > /root/.R/Makevars

COPY --chmod=0755 install-r-packages.sh /usr/local/bin/install-r-packages

# Install remotes to install specific package versions if needed.
RUN install-r-packages remotes \
    -e "install.packages('remotes', repos='https://cloud.r-project.org/')"

# Compile the heaviest Seurat prerequisite in its own cacheable, single-core
# layer. The installer emits one heartbeat per minute, suppresses successful
# compiler noise, and exposes a bounded diagnostic tail on failure.
RUN install-r-packages RcppEigen \
    -e "install.packages('RcppEigen', repos='https://cloud.r-project.org/')"

# Install CRAN dependencies. hdf5r is REQUIRED for Read10X_h5 (the tenx_h5 Seurat
# pipeline input): it is only a Seurat *Suggests*, so it must be installed explicitly
# or the seurat.pipeline.v1 endpoint fails. libhdf5-dev (above) provides its system lib.
RUN install-r-packages seurat-cran-dependencies \
    -e "install.packages(c('plumber', 'jsonlite', 'digest', 'Seurat', 'hdf5r', 'ggplot2', 'base64enc'), repos='https://cloud.r-project.org/')"

# Install Bioconductor dependencies pinned to the R 4.5-compatible release.
# Ranked pathway enrichment is a production worker operation, so its local GO
# databases and execution packages are mandatory image dependencies rather than
# optional packages fetched at request time.
RUN install-r-packages bioconductor-dependencies \
    -e "if (!require('BiocManager', quietly = TRUE)) install.packages('BiocManager', repos='https://cloud.r-project.org/'); BiocManager::install(version='3.22', ask=FALSE); BiocManager::install(c('ComplexHeatmap', 'BiocGenerics', 'BiocNeighbors', 'clusterProfiler', 'fgsea', 'AnnotationDbi', 'org.Hs.eg.db', 'org.Mm.eg.db', 'GO.db', 'edgeR', 'limma'), ask=FALSE)"

# BiocManager may update Matrix after SeuratObject was first compiled as a
# Seurat dependency. Rebuild SeuratObject against the final Matrix ABI so the
# production image does not start with a potentially incompatible native-code
# warning.
RUN install-r-packages seurat-object-abi-rebuild \
    -e "install.packages('SeuratObject', repos='https://cloud.r-project.org/'); stopifnot(requireNamespace('SeuratObject', quietly=TRUE))"

# CellChat inference is a durable worker operation. Keep its numerical backend and
# exact reviewed CellChat source revision in the default image rather than fetching
# packages at request time or relying on the old optional legacy build path.
RUN install-r-packages cellchat-nmf \
    -e "install.packages('NMF', repos='https://cloud.r-project.org/')"

# CellChat 2.1.2 imports `presto`, which is no longer available from the
# configured CRAN repository. Install the upstream R package from an immutable
# reviewed commit before CellChat so image builds never fall back to an
# unresolvable package name.
RUN install-r-packages cellchat-presto \
    -e "remotes::install_github('immunogenomics/presto@a24772a135c7895a8183b007376050556c60a05b', upgrade='never')"

RUN install-r-packages cellchat-v2.1.2 \
    -e "remotes::install_github('jinworks/CellChat@a0d3b2d231d46c8787177fffeac908270c253747', upgrade='never')"

# install.packages() reports individual source-package failures as warnings and
# can otherwise leave a successfully built but unusable image. Fail the image
# build unless every runtime dependency is actually loadable.
RUN Rscript -e "required <- c('plumber', 'jsonlite', 'digest', 'Seurat', 'hdf5r', 'ggplot2', 'base64enc', 'ComplexHeatmap', 'BiocGenerics', 'BiocNeighbors', 'clusterProfiler', 'fgsea', 'AnnotationDbi', 'org.Hs.eg.db', 'org.Mm.eg.db', 'GO.db', 'edgeR', 'limma', 'NMF', 'presto', 'CellChat'); missing <- required[!vapply(required, requireNamespace, logical(1), quietly=TRUE)]; if (length(missing)) stop('Missing required R packages: ', paste(missing, collapse=', ')); if (!identical(as.character(utils::packageVersion('CellChat')), '2.1.2')) stop('Unexpected CellChat version: ', as.character(utils::packageVersion('CellChat')))"

# Optional legacy/prototype dependency. SeuratDisk-backed H5AD/H5Seurat import remains
# outside the supported durable input contract, so a trusted local build must opt in.
ARG INSTALL_OPTIONAL_R_PACKAGES=false
RUN if [ "$INSTALL_OPTIONAL_R_PACKAGES" = "true" ]; then \
      install-r-packages optional-seurat-disk -e "remotes::install_github('mojaveazure/seurat-disk')"; \
    else \
      echo "Skipping optional SeuratDisk package. Set INSTALL_OPTIONAL_R_PACKAGES=true to include it."; \
    fi

# Copy only the runtime files admitted by r-backend/.dockerignore. Application
# code remains root-owned; the unprivileged runtime may write only to the
# explicitly created storage roots (which are replaced by persistent volumes in
# the supported deployment topology).
WORKDIR /app
COPY . /app/

RUN rm -f /usr/local/bin/install-r-packages /root/.R/Makevars /app/install-r-packages.sh \
    && groupadd --gid "${APP_GID}" appuser \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
      --shell /usr/sbin/nologin appuser \
    && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0750 \
      /app/storage-volume /app/storage-volume/data \
      /app/vault-volume /app/vault-volume/vault \
    && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0755 \
      /work /work/input /work/output

ENV HOME=/home/appuser
USER appuser

# Expose the Plumber port
EXPOSE 8000

# Run the Plumber API
ENTRYPOINT ["Rscript", "run.R"]
