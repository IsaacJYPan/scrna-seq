FROM rocker/r-ver:4.3.1

# Install system dependencies required for Seurat, Plumber, and other R packages
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    libcurl4-openssl-dev \
    libssl-dev \
    libxml2-dev \
    libhdf5-dev \
    libfontconfig1-dev \
    libharfbuzz-dev \
    libfribidi-dev \
    libpng-dev \
    libtiff5-dev \
    libjpeg-dev \
    && rm -rf /var/lib/apt/lists/*

# Install remotes to install specific package versions if needed
RUN Rscript -e "install.packages('remotes', repos='https://cloud.r-project.org/')"

# Install CRAN dependencies
RUN Rscript -e "install.packages(c('plumber', 'jsonlite', 'Seurat', 'ggplot2', 'base64enc'), repos='https://cloud.r-project.org/')"

# Install Bioconductor dependencies
RUN Rscript -e "if (!require('BiocManager', quietly = TRUE)) install.packages('BiocManager', repos='https://cloud.r-project.org/'); BiocManager::install(c('ComplexHeatmap', 'BiocGenerics'))"

# Install CellChat (requires NMF, igraph, etc., often installed via remotes or CRAN)
RUN Rscript -e "install.packages('NMF', repos='https://cloud.r-project.org/')"
RUN Rscript -e "remotes::install_github('sqjin/CellChat')"

# Install SeuratDisk for H5AD support
RUN Rscript -e "remotes::install_github('mojaveazure/seurat-disk')"

# Copy the backend code into the container
WORKDIR /app
COPY . /app/

# Expose the Plumber port
EXPOSE 8000

# Run the Plumber API
ENTRYPOINT ["Rscript", "run.R"]
