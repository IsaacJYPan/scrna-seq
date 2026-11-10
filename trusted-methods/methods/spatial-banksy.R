# Trusted method: spatial domains with BANKSY.
# Upstream: SeuratWrappers vignette "Running BANKSY with Seurat"
# (satijalab/seurat-wrappers docs/banksy.md):
#   ss <- RunBanksy(ss, lambda = 0.8, verbose = TRUE, assay = "Spatial",
#                   slot = "data", features = "variable", k_geom = 50)
#   ss <- RunPCA(ss, assay = "BANKSY", features = rownames(ss), npcs = 30)
#   ss <- FindNeighbors(ss, dims = 1:30)
#   ss <- FindClusters(ss, resolution = 0.5)
# Singhal V et al. 2024, Nat Genet. lambda near 0.2 favors cell types;
# near 0.8 favors tissue domains, as the authors recommend.
if (!requireNamespace("SeuratWrappers", quietly = TRUE) || !requireNamespace("Banksy", quietly = TRUE)) {
  stop("Banksy and SeuratWrappers are not installed in this R runtime. See trusted-methods/README.md.")
}
analysis <- inputs$analysis
if (!length(Images(analysis))) stop("This analysis has no spatial image or field of view.")
assay <- intersect(c("Spatial", "Xenium", "RNA"), Assays(analysis))[1]
DefaultAssay(analysis) <- assay
analysis[[assay]] <- JoinLayers(analysis[[assay]])
if (!"data" %in% SeuratObject::Layers(analysis[[assay]])) analysis <- NormalizeData(analysis, verbose = FALSE)
if (!length(VariableFeatures(analysis))) analysis <- FindVariableFeatures(analysis, nfeatures = 2000, verbose = FALSE)
dims <- seq_len(params[["dims"]])

# --- vignette: Running BANKSY with Seurat ---------------------------------
analysis <- SeuratWrappers::RunBanksy(analysis, lambda = params[["lambda"]], assay = assay, slot = "data",
                                      features = "variable", k_geom = params[["k-geom"]], verbose = FALSE)
analysis <- RunPCA(analysis, assay = "BANKSY", features = rownames(analysis), npcs = max(dims), seed.use = seed,
                   reduction.name = "pca.banksy", verbose = FALSE)
analysis <- FindNeighbors(analysis, reduction = "pca.banksy", dims = dims, graph.name = c("banksy_nn", "banksy_snn"), verbose = FALSE)
analysis <- FindClusters(analysis, graph.name = "banksy_snn", resolution = params[["resolution"]], random.seed = seed,
                         cluster.name = "banksy_cluster", verbose = FALSE)
# -------------------------------------------------------------------------
analysis$banksy_cluster <- as.character(analysis$banksy_cluster)
DefaultAssay(analysis) <- assay

sizes <- table(analysis$banksy_cluster)
image <- Images(analysis)[[1]]
write_output("analysis", analysis)
write_output("summary", list(n_domains = length(sizes), smallest_domain = as.integer(min(sizes)),
                             lambda = params[["lambda"]], image = image))
write_output("domains", data.frame(domain = names(sizes), cells = as.integer(sizes)))
plot <- if (inherits(analysis[[image]], c("VisiumV1", "VisiumV2"))) {
  SpatialDimPlot(analysis, group.by = "banksy_cluster", images = image, label = TRUE)
} else {
  ImageDimPlot(analysis, fov = image, group.by = "banksy_cluster", size = 1)
}
write_output("figure", plot, width = 9, height = 8)
