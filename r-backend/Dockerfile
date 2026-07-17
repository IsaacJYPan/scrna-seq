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

# Install remotes to install specific package versions if needed
RUN Rscript -e "install.packages('remotes', repos='https://cloud.r-project.org/')"

# Install CRAN dependencies. hdf5r is REQUIRED for Read10X_h5 (the tenx_h5 Seurat
# pipeline input): it is only a Seurat *Suggests*, so it must be installed explicitly
# or the seurat.pipeline.v1 endpoint fails. libhdf5-dev (above) provides its system lib.
RUN Rscript -e "install.packages(c('plumber', 'jsonlite', 'digest', 'Seurat', 'hdf5r', 'ggplot2', 'base64enc'), repos='https://cloud.r-project.org/')"

# Install Bioconductor dependencies pinned to the R 4.5-compatible release.
RUN Rscript -e "if (!require('BiocManager', quietly = TRUE)) install.packages('BiocManager', repos='https://cloud.r-project.org/'); BiocManager::install(version='3.22', ask=FALSE); BiocManager::install(c('ComplexHeatmap', 'BiocGenerics'), ask=FALSE)"

# BiocManager may update Matrix after SeuratObject was first compiled as a
# Seurat dependency. Rebuild SeuratObject against the final Matrix ABI so the
# production image does not start with a potentially incompatible native-code
# warning.
RUN Rscript -e "install.packages('SeuratObject', repos='https://cloud.r-project.org/'); stopifnot(requireNamespace('SeuratObject', quietly=TRUE))"

# install.packages() reports individual source-package failures as warnings and
# can otherwise leave a successfully built but unusable image. Fail the image
# build unless every runtime dependency is actually loadable.
RUN Rscript -e "required <- c('plumber', 'jsonlite', 'digest', 'Seurat', 'hdf5r', 'ggplot2', 'base64enc', 'ComplexHeatmap', 'BiocGenerics'); missing <- required[!vapply(required, requireNamespace, logical(1), quietly=TRUE)]; if (length(missing)) stop('Missing required R packages: ', paste(missing, collapse=', '))"

# Optional legacy/prototype dependencies. CellChat is not a production-integrated
# workflow in the app, and SeuratDisk-backed H5AD/H5Seurat import remains optional;
# keep them out of the default image unless a trusted local build explicitly asks.
ARG INSTALL_OPTIONAL_R_PACKAGES=false
RUN if [ "$INSTALL_OPTIONAL_R_PACKAGES" = "true" ]; then \
      Rscript -e "install.packages('NMF', repos='https://cloud.r-project.org/')" && \
      Rscript -e "remotes::install_github('sqjin/CellChat')" && \
      Rscript -e "remotes::install_github('mojaveazure/seurat-disk')"; \
    else \
      echo "Skipping optional legacy R packages (CellChat, SeuratDisk). Set INSTALL_OPTIONAL_R_PACKAGES=true to include them."; \
    fi

# Copy only the runtime files admitted by r-backend/.dockerignore. Application
# code remains root-owned; the unprivileged runtime may write only to the
# explicitly created storage roots (which are replaced by persistent volumes in
# the supported deployment topology).
WORKDIR /app
COPY . /app/

RUN groupadd --gid "${APP_GID}" appuser \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
      --shell /usr/sbin/nologin appuser \
    && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0750 \
      /app/storage-volume /app/storage-volume/data \
      /app/vault-volume /app/vault-volume/vault

ENV HOME=/home/appuser
USER appuser

# Expose the Plumber port
EXPOSE 8000

# Run the Plumber API
ENTRYPOINT ["Rscript", "run.R"]
