# Trusted method: lineage and pseudotime inference with slingshot.
# Upstream: slingshot vignette "Slingshot: Trajectory Inference for
# Single-Cell Data", sections "Identifying global lineage structure" and
# "Using slingshot with clusters":
#   sce <- slingshot(sce, clusterLabels = 'GMM', reducedDim = 'PCA',
#                    start.clus = ...)
#   summary(sce$slingPseudotime_1)
# Street K et al. 2018, BMC Genomics. Lineages are fitted on the PCA (or
# integrated) embedding; UMAP is used only for display, as the vignette advises.
if (!requireNamespace("slingshot", quietly = TRUE)) stop("slingshot is not installed in this R runtime. See trusted-methods/README.md.")
analysis <- inputs$analysis
cluster_column <- params[["cluster-column"]]
if (!cluster_column %in% colnames(analysis[[]])) stop("The cluster column is not in the cell metadata.")
reduction <- params[["reduction"]]
if (!reduction %in% Reductions(analysis)) stop("The selected reduction is not present; run clustering or integration first.")
embedding <- Embeddings(analysis, reduction)[, seq_len(min(params[["dims"]], ncol(Embeddings(analysis, reduction)))), drop = FALSE]
clusters <- as.character(analysis[[cluster_column, drop = TRUE]])
start <- params[["start-cluster"]]
end <- params[["end-clusters"]]
if (nzchar(start) && !start %in% clusters) stop("The start cluster is not one of the clusters.")
end_clusters <- if (nzchar(end)) trimws(strsplit(end, ",", fixed = TRUE)[[1]]) else NULL
if (length(setdiff(end_clusters, clusters))) stop("An end cluster is not one of the clusters.")

# --- vignette: slingshot on a reduced dimension with cluster labels -------
fit <- slingshot::slingshot(embedding, clusterLabels = clusters,
                            start.clus = if (nzchar(start)) start else NULL,
                            end.clus = end_clusters)
pseudotime <- slingshot::slingPseudotime(fit)
weights <- slingshot::slingCurveWeights(fit)
# -------------------------------------------------------------------------

lineages <- slingshot::slingLineages(fit)
for (i in seq_len(ncol(pseudotime))) {
  analysis[[paste0("slingPseudotime_", i)]] <- pseudotime[, i]
  analysis[[paste0("slingWeight_", i)]] <- weights[, i]
}
# Average pseudotime across lineages weighted by curve assignment.
average <- rowSums(pseudotime * weights, na.rm = TRUE) / pmax(rowSums(weights * !is.na(pseudotime)), 1e-9)
analysis$slingPseudotime_mean <- average

lineage_table <- data.frame(
  lineage = names(lineages),
  clusters = vapply(lineages, paste, "", collapse = " > "),
  cells = vapply(seq_along(lineages), function(i) sum(!is.na(pseudotime[, i])), 0L)
)
write_output("analysis", analysis)
write_output("summary", list(
  n_lineages = length(lineages),
  n_cells = ncol(analysis),
  start_cluster = lineages[[1]][[1]],
  max_pseudotime = round(max(average, na.rm = TRUE), 4),
  reduction = reduction
))
write_output("lineages", lineage_table)
display <- if ("umap" %in% Reductions(analysis)) "umap" else reduction
write_output("figure", FeaturePlot(analysis, features = "slingPseudotime_mean", reduction = display) +
  ggplot2::ggtitle("Mean slingshot pseudotime"))
