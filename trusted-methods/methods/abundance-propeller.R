# Trusted method: differential cell-type abundance between conditions.
# Upstream: speckle vignette "speckle: statistical methods for analysing
# single cell data", section "Finding significant differences in cell type
# proportions using propeller":
#   propeller(clusters = obj$clusters, sample = obj$sample, group = obj$group)
#   plotCellTypeProps(clusters = obj$clusters, sample = obj$sample)
# Phipson B et al. 2022, Bioinformatics. The unit of replication is the
# biological sample, never the cell.
if (!requireNamespace("speckle", quietly = TRUE) || !requireNamespace("limma", quietly = TRUE)) {
  stop("speckle is not installed in this R runtime. See trusted-methods/README.md.")
}
analysis <- inputs$analysis
meta <- analysis[[]]
columns <- c(params[["cluster-column"]], params[["sample-column"]], params[["condition-column"]])
if (any(!columns %in% colnames(meta))) stop("A cluster, sample or condition column is not in the cell metadata.")
clusters <- as.character(meta[[columns[[1]]]])
samples <- as.character(meta[[columns[[2]]]])
groups <- as.character(meta[[columns[[3]]]])

# Each sample must belong to exactly one condition.
per_sample <- unique(data.frame(sample = samples, group = groups))
if (anyDuplicated(per_sample$sample)) stop("A sample appears under more than one condition.")
replicates <- table(per_sample$group)
if (length(replicates) < 2) stop("At least two conditions are needed.")
if (min(replicates) < params[["min-replicates"]]) {
  stop(sprintf("Each condition needs at least %d samples; found %s.", params[["min-replicates"]],
               paste(names(replicates), replicates, sep = "=", collapse = ", ")))
}

# --- vignette: propeller -------------------------------------------------
result <- speckle::propeller(clusters = clusters, sample = samples, group = groups,
                             transform = params[["transform"]])
# -------------------------------------------------------------------------
result <- data.frame(cluster = rownames(result), result, check.names = FALSE, row.names = NULL)
numeric_columns <- vapply(result, is.numeric, TRUE)
result[numeric_columns] <- lapply(result[numeric_columns], function(x) signif(x, 6))
result <- result[order(result$FDR), ]

proportions <- as.data.frame(prop.table(table(sample = samples, cluster = clusters), margin = 1), stringsAsFactors = FALSE)
names(proportions)[3] <- "proportion"
proportions$condition <- per_sample$group[match(proportions$sample, per_sample$sample)]
proportions$proportion <- round(proportions$proportion, 6)

alpha <- params[["fdr"]]
write_output("summary", list(
  n_clusters = length(unique(clusters)),
  n_samples = nrow(per_sample),
  n_conditions = length(replicates),
  min_replicates = as.integer(min(replicates)),
  n_significant = sum(result$FDR < alpha, na.rm = TRUE),
  test = if (length(replicates) == 2) "t-test (two groups)" else "ANOVA (more than two groups)",
  transform = params[["transform"]]
))
write_output("results", result)
write_output("proportions", proportions)
write_output("figure", ggplot2::ggplot(proportions, ggplot2::aes(x = condition, y = proportion, colour = condition)) +
  ggplot2::geom_boxplot(outlier.shape = NA) + ggplot2::geom_jitter(width = 0.15, height = 0) +
  ggplot2::facet_wrap(~cluster, scales = "free_y") + ggplot2::theme_minimal() +
  ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1)),
  width = 12, height = 9)
