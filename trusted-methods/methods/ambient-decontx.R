# Trusted method: ambient RNA estimation and removal with decontX.
# Upstream: celda vignette "Decontamination of ambient RNA in single-cell
# genomic data with DecontX", sections "Running DecontX" and "Working with
# Seurat":
#   sce <- decontX(sce)            # or decontX(x = counts, z = clusters)
#   plotDecontXContamination(sce)
#   seuratObject <- CreateSeuratObject(round(decontXcounts(sce)))
# Yang S et al. 2020, Genome Biology. Without empty droplets decontX
# estimates the ambient profile from the cells themselves, as here.
if (!requireNamespace("celda", quietly = TRUE)) stop("celda (decontX) is not installed in this R runtime. See trusted-methods/README.md.")
analysis <- inputs$analysis
assay <- intersect(c("RNA", "Spatial"), Assays(analysis))[1]
if (is.na(assay)) stop("No RNA or Spatial count assay is present.")
joined <- JoinLayers(analysis[[assay]])
counts <- SeuratObject::LayerData(joined, layer = "counts")

cluster_column <- params[["cluster-column"]]
z <- NULL
if (nzchar(cluster_column)) {
  if (!cluster_column %in% colnames(analysis[[]])) stop("The cluster column is not in the cell metadata.")
  z <- as.character(analysis[[cluster_column, drop = TRUE]])
}
batch_column <- params[["batch-column"]]
batch <- NULL
if (nzchar(batch_column)) {
  if (!batch_column %in% colnames(analysis[[]])) stop("The batch column is not in the cell metadata.")
  batch <- as.character(analysis[[batch_column, drop = TRUE]])
}

# --- vignette: Running DecontX -------------------------------------------
set.seed(seed)
result <- celda::decontX(x = counts, z = z, batch = batch, maxIter = params[["max-iterations"]],
                         seed = seed, verbose = FALSE)
# -------------------------------------------------------------------------
corrected <- round(result$decontXcounts)
analysis$decontX_contamination <- as.numeric(result$contamination)

if (identical(params[["apply"]], "replace-counts")) {
  # Keep the original counts as their own assay so the change is reversible.
  analysis[[paste0(assay, "_original")]] <- CreateAssay5Object(counts = counts)
  analysis[[assay]] <- CreateAssay5Object(counts = corrected)
  DefaultAssay(analysis) <- assay
  analysis <- NormalizeData(analysis, assay = assay, verbose = FALSE)
} else {
  analysis[["decontX"]] <- CreateAssay5Object(counts = corrected)
  analysis <- NormalizeData(analysis, assay = "decontX", verbose = FALSE)
}

contamination <- analysis$decontX_contamination
groups <- if (is.null(z)) rep("all", ncol(analysis)) else z
by_group <- aggregate(contamination, by = list(group = groups), FUN = function(x) c(median = median(x), mean = mean(x)))
by_group <- data.frame(group = by_group$group, median = round(by_group$x[, "median"], 4), mean = round(by_group$x[, "mean"], 4))
write_output("analysis", analysis)
write_output("summary", list(
  n_cells = ncol(analysis),
  median_contamination = round(median(contamination), 4),
  mean_contamination = round(mean(contamination), 4),
  cells_over_0_5 = sum(contamination > 0.5),
  counts_removed_fraction = round(1 - sum(corrected) / sum(counts), 4),
  applied = params[["apply"]]
))
write_output("by-group", by_group)
figure <- if ("umap" %in% Reductions(analysis)) FeaturePlot(analysis, features = "decontX_contamination") else
  ggplot2::ggplot(data.frame(contamination = contamination), ggplot2::aes(x = contamination)) + ggplot2::geom_histogram(bins = 50) + ggplot2::theme_minimal()
write_output("figure", figure)
