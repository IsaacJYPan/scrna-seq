#!/usr/bin/env Rscript
# Run the Seurat PBMC3k guided clustering tutorial directly in R and write the
# results an app run must reproduce: cell and feature counts after each step,
# variable features, PCA standard deviations, per-cell cluster labels, UMAP
# coordinates and cluster markers.
#
#   Rscript scripts/pbmc3k_tutorial_reference.R <10x mtx dir> <out.json> [seed] [cluster_seed]
#
# seed is used for PCA and UMAP; cluster_seed for FindClusters. The tutorial's
# defaults are 42 and 0. The app uses one seed for all three, so pass the same
# value twice to reproduce an app run exactly.

suppressPackageStartupMessages({ library(Seurat); library(Matrix); library(jsonlite) })
args <- commandArgs(trailingOnly = TRUE)
data_dir <- args[[1]]
out <- args[[2]]
seed <- if (length(args) >= 3) as.integer(args[[3]]) else 42L
cluster_seed <- if (length(args) >= 4) as.integer(args[[4]]) else 0L

pbmc.data <- Read10X(data.dir = data_dir)
pbmc <- CreateSeuratObject(counts = pbmc.data, project = "pbmc3k", min.cells = 3, min.features = 200)
loaded <- list(cells = ncol(pbmc), features = nrow(pbmc))
pbmc[["percent.mt"]] <- PercentageFeatureSet(pbmc, pattern = "^MT-")
pbmc <- subset(pbmc, subset = nFeature_RNA > 200 & nFeature_RNA < 2500 & percent.mt < 5)
qc <- list(cells = ncol(pbmc))
pbmc <- NormalizeData(pbmc, normalization.method = "LogNormalize", scale.factor = 10000, verbose = FALSE)
pbmc <- FindVariableFeatures(pbmc, selection.method = "vst", nfeatures = 2000, verbose = FALSE)
all.genes <- rownames(pbmc)
pbmc <- ScaleData(pbmc, features = all.genes, verbose = FALSE)
pbmc <- RunPCA(pbmc, features = VariableFeatures(object = pbmc), seed.use = seed, verbose = FALSE)
pbmc <- FindNeighbors(pbmc, dims = 1:10, verbose = FALSE)
pbmc <- FindClusters(pbmc, resolution = 0.5, random.seed = cluster_seed, verbose = FALSE)
pbmc <- RunUMAP(pbmc, dims = 1:10, seed.use = seed, verbose = FALSE)
markers <- FindAllMarkers(pbmc, only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25, verbose = FALSE)
top <- do.call(rbind, lapply(split(markers, markers$cluster), function(d) head(d[order(-d$avg_log2FC), ], 2)))

umap <- Embeddings(pbmc, "umap")
result <- list(
  seed = seed, clusterSeed = cluster_seed,
  loaded = loaded, qc = qc,
  variableFeatures = head(VariableFeatures(pbmc), 2000),
  pcaStdev = round(Stdev(pbmc, "pca")[1:10], 6),
  clusters = list(n = length(levels(pbmc$seurat_clusters)), sizes = as.list(table(pbmc$seurat_clusters))),
  cellClusters = setNames(as.list(as.character(pbmc$seurat_clusters)), colnames(pbmc)),
  umap = list(cells = rownames(umap), x = round(umap[, 1], 4), y = round(umap[, 2], 4)),
  topMarkers = lapply(split(top, top$cluster), function(d) d$gene),
  markerCount = nrow(markers)
)
write_json(result, out, auto_unbox = TRUE, digits = NA)
cat(sprintf("cells %d -> %d after QC; %d clusters; %d markers\n", loaded$cells, qc$cells, result$clusters$n, nrow(markers)))
