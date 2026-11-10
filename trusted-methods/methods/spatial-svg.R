# Trusted method: spatially variable features (Moran's I).
# Upstream: Seurat vignette "Analysis, visualization, and integration of
# Visium HD and Visium spatial data", section "Identification of Spatially
# Variable Features":
#   brain <- FindSpatiallyVariableFeatures(brain, assay = "SCT",
#              features = VariableFeatures(brain)[1:1000], selection.method = "moransi")
#   top.features <- head(SpatiallyVariableFeatures(brain, method = "moransi"), 6)
#   SpatialFeaturePlot(brain, features = top.features, ncol = 3, alpha = c(0.1, 1))
analysis <- inputs$analysis
if (!length(Images(analysis))) stop("This analysis has no spatial image or field of view.")
assay <- if ("SCT" %in% Assays(analysis)) "SCT" else intersect(c("Spatial", "Xenium", "RNA"), Assays(analysis))[1]
DefaultAssay(analysis) <- assay
if (!length(VariableFeatures(analysis))) analysis <- FindVariableFeatures(analysis, nfeatures = params[["features"]], verbose = FALSE)
features <- head(VariableFeatures(analysis), params[["features"]])
image <- Images(analysis)[[1]]

analysis <- FindSpatiallyVariableFeatures(analysis, assay = assay, features = features,
                                          selection.method = "moransi", image = image, verbose = FALSE)
meta <- analysis[[assay]][[]]
observed <- grep("MoransI_observed$", colnames(meta), value = TRUE)[1]
p_column <- grep("MoransI_p.value$", colnames(meta), value = TRUE)[1]
if (is.na(observed) || is.na(p_column)) stop("Moran's I results were not recorded.")
scored <- meta[!is.na(meta[[observed]]), , drop = FALSE]
results <- data.frame(gene = rownames(scored), morans_i = signif(scored[[observed]], 6),
                      p_value = signif(scored[[p_column]], 6))
results$fdr <- signif(p.adjust(results$p_value, method = "BH"), 6)
results <- results[order(-results$morans_i), ]
top <- head(results$gene, params[["top"]])

write_output("analysis", analysis)
write_output("summary", list(
  features_tested = nrow(results),
  n_fdr_below_0_05 = sum(results$fdr < 0.05, na.rm = TRUE),
  top_feature = results$gene[[1]],
  top_morans_i = results$morans_i[[1]],
  assay = assay,
  image = image
))
write_output("results", results)
plot <- if (inherits(analysis[[image]], "FOV") && !inherits(analysis[[image]], c("VisiumV1", "VisiumV2"))) {
  ImageFeaturePlot(analysis, features = head(top, 6), fov = image)
} else {
  SpatialFeaturePlot(analysis, features = head(top, 6), ncol = 3, alpha = c(0.1, 1), images = image)
}
write_output("figure", plot, width = 12, height = 8)
