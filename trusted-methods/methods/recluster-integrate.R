# Trusted method: normalize, (optionally) integrate batches, and re-cluster.
# Upstream: Seurat v5 vignette "Integrative analysis in Seurat v5"
# (satijalab.org/seurat/articles/seurat5_integration):
#   obj[["RNA"]] <- split(obj[["RNA"]], f = obj$Method)
#   obj <- NormalizeData(obj); obj <- FindVariableFeatures(obj)
#   obj <- ScaleData(obj); obj <- RunPCA(obj)
#   obj <- IntegrateLayers(object = obj, method = CCAIntegration,
#            orig.reduction = "pca", new.reduction = "integrated.cca")
#   obj[["RNA"]] <- JoinLayers(obj[["RNA"]])
#   obj <- FindNeighbors(obj, reduction = "integrated.cca", dims = 1:30)
#   obj <- FindClusters(obj, resolution = 1)
#   obj <- RunUMAP(obj, dims = 1:30, reduction = "integrated.cca")
# With integration "none" this is the unintegrated workflow of the same
# vignette, used to re-cluster after subsetting or doublet removal.
analysis <- inputs$analysis
assay <- intersect(c("RNA", "Spatial", "Xenium"), Assays(analysis))[1]
if (is.na(assay)) stop("No count assay (RNA, Spatial or Xenium) is present.")
DefaultAssay(analysis) <- assay
method <- params[["integration"]]
dims <- seq_len(params[["dims"]])

analysis[[assay]] <- JoinLayers(analysis[[assay]])
n_batches <- 1L
if (method != "none") {
  batch_column <- params[["batch-column"]]
  if (!batch_column %in% colnames(analysis[[]])) stop("The batch column is not in the cell metadata.")
  batches <- as.character(analysis[[batch_column, drop = TRUE]])
  n_batches <- length(unique(batches))
  if (n_batches < 2) stop("Integration needs at least two batches in the batch column.")
  if (method == "Harmony" && !requireNamespace("harmony", quietly = TRUE)) stop("harmony is not installed in this R runtime.")
  analysis[[assay]] <- split(analysis[[assay]], f = batches)
}

analysis <- NormalizeData(analysis, verbose = FALSE)
analysis <- FindVariableFeatures(analysis, nfeatures = params[["variable-features"]], verbose = FALSE)
analysis <- ScaleData(analysis, verbose = FALSE)
analysis <- RunPCA(analysis, npcs = max(dims, 30), seed.use = seed, verbose = FALSE)

reduction <- "pca"
if (method != "none") {
  integration <- switch(method, CCA = CCAIntegration, RPCA = RPCAIntegration, Harmony = HarmonyIntegration)
  reduction <- paste0("integrated.", tolower(method))
  analysis <- IntegrateLayers(object = analysis, method = integration, orig.reduction = "pca",
                              new.reduction = reduction, verbose = FALSE)
  analysis[[assay]] <- JoinLayers(analysis[[assay]])
}
analysis <- FindNeighbors(analysis, reduction = reduction, dims = dims, verbose = FALSE)
analysis <- FindClusters(analysis, resolution = params[["resolution"]], random.seed = seed, verbose = FALSE)
analysis <- RunUMAP(analysis, reduction = reduction, dims = dims, seed.use = seed, verbose = FALSE)

sizes <- table(analysis$seurat_clusters)
write_output("analysis", analysis)
write_output("summary", list(
  n_cells = ncol(analysis),
  n_clusters = length(sizes),
  smallest_cluster = as.integer(min(sizes)),
  largest_cluster = as.integer(max(sizes)),
  n_batches = n_batches,
  integration = method,
  reduction = reduction
))
write_output("clusters", data.frame(cluster = names(sizes), cells = as.integer(sizes)))
groups <- if (method != "none") c(params[["batch-column"]], "seurat_clusters") else "seurat_clusters"
write_output("umap", DimPlot(analysis, reduction = "umap", group.by = groups, label = FALSE), width = 6 * length(groups), height = 5)
