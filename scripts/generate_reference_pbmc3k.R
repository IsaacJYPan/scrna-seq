#!/usr/bin/env Rscript
# generate_reference_pbmc3k.R
# This script runs the canonical Seurat + clusterProfiler + CellChat
# pipeline on the PBMC3k dataset to establish ground truth metrics.
# Results are saved to reference_metrics.json.

suppressPackageStartupMessages({
  library(Seurat)
  library(dplyr)
  library(Matrix)
  library(jsonlite)
  library(clusterProfiler)
  library(org.Hs.eg.db)
  library(CellChat)
})

out_file <- "reference_metrics.json"

cat("============================================================\n")
cat(" Generating PBMC3k Reference Metrics \n")
cat("============================================================\n")

# Determine paths
script_dir <- getwd()
workspace_dir <- dirname(script_dir)
data_path <- file.path(workspace_dir, "data", "pbmc3k", "filtered_gene_bc_matrices", "hg19")

if (!dir.exists(data_path)) {
  stop("Data path not found: ", data_path)
}

metrics <- list()

# 1. Load Data
cat("[1/8] Loading dataset...\n")
mat <- Read10X(data.dir = data_path)
obj <- CreateSeuratObject(counts = mat, min.cells = 3, min.features = 200)
metrics$load_data <- list(
  cells = ncol(obj),
  features = nrow(obj)
)

# 2. QC
cat("[2/8] QC and filtering...\n")
obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^[Mm][Tt]-")
obj <- subset(obj, subset = nFeature_RNA > 200 & nFeature_RNA < 2500 & percent.mt < 5 & nCount_RNA > 0)
metrics$qc <- list(
  post_filter_cells = ncol(obj)
)

# 3. Normalize
cat("[3/8] Normalizing...\n")
obj <- NormalizeData(obj, normalization.method = "LogNormalize", scale.factor = 10000)
obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 2000)
metrics$normalize <- list(
  n_variable_features = length(VariableFeatures(obj))
)

# 4. Scale & PCA
cat("[4/8] Scaling and PCA...\n")
obj <- ScaleData(obj, features = rownames(obj))
obj <- RunPCA(obj, features = VariableFeatures(obj), npcs = 50, verbose = FALSE)

# 5. Cluster
cat("[5/8] Clustering...\n")
# Using the exact same seed mechanism as plumber.R
used_seed <- 42
set.seed(used_seed)
obj <- FindNeighbors(obj, reduction = "pca", dims = 1:10)
obj <- FindClusters(obj, algorithm = 1, resolution = 0.5, random.seed = used_seed)
metrics$cluster <- list(
  n_clusters = length(unique(obj$seurat_clusters))
)

# 6. Pathway Enrichment
cat("[6/8] Pathway Enrichment (GO_BP)...\n")
markers <- FindAllMarkers(obj, only.pos = TRUE, min.pct = 0.1, logfc.threshold = 0.25, verbose = FALSE)
markers <- markers[!grepl("^(MT-|RPL|RPS)", markers$gene, ignore.case = TRUE), ]
markers_sorted <- markers[order(-markers$avg_log2FC), ]
gene_symbols <- unique(markers_sorted$gene)

entrez_map <- suppressMessages(bitr(gene_symbols, fromType = "SYMBOL", toType = "ENTREZID", OrgDb = org.Hs.eg.db))
entrez_ids <- unique(entrez_map$ENTREZID)

universe_map <- suppressMessages(bitr(rownames(obj), fromType = "SYMBOL", toType = "ENTREZID", OrgDb = org.Hs.eg.db))
entrez_universe <- unique(universe_map$ENTREZID)

ora_result <- suppressMessages(
  enrichGO(
    gene = entrez_ids,
    universe = entrez_universe,
    OrgDb = org.Hs.eg.db,
    ont = "BP",
    pvalueCutoff = 0.05,
    pAdjustMethod = "BH",
    readable = TRUE,
    minGSSize = 5,
    maxGSSize = 500
  )
)
df <- as.data.frame(ora_result)
df <- df[order(df$p.adjust), ]
if (nrow(df) > 20) df <- df[1:20, ] # top 20 limit as in plumber.R

metrics$enrichment <- list(
  n_pathways = nrow(df)
)

# 7. CellChat Inference
cat("[7/8] CellChat Inference...\n")
data.input <- GetAssayData(obj, assay = "RNA", layer = "data") # Seurat v5
meta <- obj@meta.data

orig_labels <- as.character(meta$seurat_clusters)
unique_orig <- sort(unique(orig_labels))
label_needs_remap <- any(grepl("^0$|^[0-9]+$", unique_orig))
if (label_needs_remap) {
  label_map <- setNames(paste0("Cluster", seq_along(unique_orig)), unique_orig)
  meta$seurat_clusters <- factor(label_map[orig_labels], levels = label_map)
} else {
  meta$seurat_clusters <- as.factor(meta$seurat_clusters)
}

cellchat <- createCellChat(object = data.input, meta = meta, group.by = "seurat_clusters")
cellchat@DB <- CellChatDB.human
cellchat <- subsetData(cellchat)
cellchat <- identifyOverExpressedGenes(cellchat)
cellchat <- identifyOverExpressedInteractions(cellchat)
cellchat <- computeCommunProb(cellchat, raw.use = TRUE, population.size = TRUE)
cellchat <- filterCommunication(cellchat, min.cells = 10)
cellchat <- computeCommunProbPathway(cellchat)
cellchat <- aggregateNet(cellchat)

net_weight <- cellchat@net$weight
nodes_count <- if (is.null(net_weight) || length(net_weight) == 0) 0 else length(rownames(net_weight))
edges_count <- 0
if (nodes_count > 0) {
  for (i in 1:nodes_count) {
    for (j in 1:nodes_count) {
      if (net_weight[i, j] > 0) edges_count <- edges_count + 1
    }
  }
}

metrics$cellchat <- list(
  n_nodes = nodes_count,
  n_edges = edges_count
)

# 8. Save Metrics
cat("[8/8] Saving metrics to", out_file, "...\n")
write_json(metrics, out_file, pretty = TRUE, auto_unbox = TRUE)
cat("Done.\n")
