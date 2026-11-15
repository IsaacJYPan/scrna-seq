#!/usr/bin/env Rscript
# Replay a figure-history script exported from the app on the original data and
# compare the result, cell by cell, with Seurat run directly
# (scripts/pbmc3k_tutorial_reference.R).
#
#   Rscript scripts/compare-pbmc3k-tutorial.R <bundle.R> <10x mtx dir> <reference.json> [out.json]

suppressPackageStartupMessages({ library(Seurat); library(jsonlite) })
args <- commandArgs(trailingOnly = TRUE)
bundle <- readLines(args[[1]])
data_dir <- normalizePath(args[[2]])
reference <- fromJSON(args[[3]])
out <- if (length(args) >= 4) args[[4]] else NULL

# Point the server-managed input placeholder at the local copy of the data.
bundle <- gsub("'<[^>]*PBMC[^>]*>'", sprintf("'%s'", data_dir), bundle)
work <- tempfile("bundle-"); dir.create(work)
old <- setwd(work)
env <- new.env()
eval(parse(text = bundle), envir = env)
setwd(old)
obj <- env$obj

same_cells <- identical(sort(colnames(obj)), sort(names(reference$cellClusters)))
app_clusters <- as.character(obj$seurat_clusters)[match(names(reference$cellClusters), colnames(obj))]
ref_clusters <- unlist(reference$cellClusters)
agree <- mean(app_clusters == ref_clusters)
ari <- if (requireNamespace("mclust", quietly = TRUE)) mclust::adjustedRandIndex(app_clusters, ref_clusters) else NA
umap <- Embeddings(obj, "umap")[reference$umap$cells, , drop = FALSE]
umap_max_diff <- max(abs(umap[, 1] - reference$umap$x), abs(umap[, 2] - reference$umap$y))
pca_diff <- max(abs(Stdev(obj, "pca")[1:10] - reference$pcaStdev))
vf_same <- identical(head(VariableFeatures(obj), 2000), reference$variableFeatures)
figure_files <- list.files(file.path(work, "figures"))

result <- list(
  cells = ncol(obj), referenceCells = reference$qc$cells, sameCells = same_cells,
  variableFeaturesIdentical = vf_same, pcaStdevMaxAbsDiff = pca_diff,
  clusterSizes = as.list(table(obj$seurat_clusters)), referenceClusterSizes = reference$clusters$sizes,
  clusterAgreement = agree, adjustedRandIndex = ari, umapMaxAbsDiff = umap_max_diff,
  figuresWritten = figure_files,
  exactMatch = same_cells && vf_same && pca_diff < 1e-6 && agree == 1 && umap_max_diff < 1e-3
)
cat(toJSON(result, auto_unbox = TRUE, pretty = TRUE, digits = NA), "\n")
if (!is.null(out)) write_json(result, out, auto_unbox = TRUE, pretty = TRUE, digits = NA)
if (!isTRUE(result$exactMatch)) quit(status = 1)
