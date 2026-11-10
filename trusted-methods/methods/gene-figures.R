# Trusted method: standard expression figures for a gene list.
# Upstream: Seurat pbmc3k tutorial, "Finding differentially expressed
# features" and the Seurat "Data visualization methods" vignette:
#   VlnPlot(pbmc, features = c("MS4A1", "CD79A"))
#   FeaturePlot(pbmc, features = c("MS4A1", "GNLY", "CD3E", ...))
#   DotPlot(pbmc, features = features) + RotatedAxis()
#   DimPlot(pbmc, reduction = "umap", label = TRUE)
# Display only: the analysis is not changed and no new object is produced.
analysis <- inputs$analysis
genes <- unique(trimws(strsplit(params[["genes"]], ",", fixed = TRUE)[[1]]))
found <- intersect(genes, rownames(analysis))
if (!length(found)) stop("None of the listed genes are present.")
group_column <- params[["group-column"]]
if (!group_column %in% colnames(analysis[[]])) stop("The group column is not in the cell metadata.")
Idents(analysis) <- analysis[[group_column, drop = TRUE]]
plot_genes <- head(found, params[["max-panels"]])
point_size <- params[["point-size"]]

dot <- DotPlot(analysis, features = found, group.by = group_column) + RotatedAxis()
dot_data <- dot$data
table_out <- data.frame(
  gene = as.character(dot_data$features.plot),
  group = as.character(dot_data$id),
  avg_exp_scaled = round(as.numeric(dot_data$avg.exp.scaled), 4),
  pct_exp = round(as.numeric(dot_data$pct.exp), 2)
)
columns <- min(4, length(plot_genes))
rows <- ceiling(length(plot_genes) / columns)

write_output("summary", list(genes_listed = length(genes), genes_found = length(found),
                             n_groups = length(unique(Idents(analysis))), group_column = group_column))
write_output("dotplot-data", table_out)
write_output("dotplot", dot, width = min(16, 3 + 0.4 * length(found)), height = min(16, 2 + 0.35 * length(unique(Idents(analysis)))))
write_output("violin", VlnPlot(analysis, features = plot_genes, pt.size = 0, ncol = columns),
             width = min(16, 4 * columns), height = min(16, 3.5 * rows))
if ("umap" %in% Reductions(analysis)) {
  write_output("feature", FeaturePlot(analysis, features = plot_genes, pt.size = point_size, ncol = columns, order = TRUE),
               width = min(16, 4 * columns), height = min(16, 3.5 * rows))
  write_output("groups", DimPlot(analysis, reduction = "umap", label = TRUE, pt.size = point_size, repel = TRUE) + NoLegend())
} else {
  stop("Feature and group plots need a UMAP; run a clustering method first.")
}
