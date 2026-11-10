# Trusted method: doublet detection with scDblFinder.
# Upstream: scDblFinder vignette "scDblFinder" (Bioconductor 3.22), section
# "Usage": `sce <- scDblFinder(sce, samples = "sample_id")`, then
# `table(sce$scDblFinder.class)`. Germain et al. 2021, F1000Research.
#
# This method only annotates cells. Remove doublets with the subset-cells
# method (column scDblFinder.class, keep "singlet") so the decision is a
# separate, reviewable step.
if (!requireNamespace("scDblFinder", quietly = TRUE) || !requireNamespace("SingleCellExperiment", quietly = TRUE)) {
  stop("scDblFinder is not installed in this R runtime. See trusted-methods/README.md.")
}
analysis <- inputs$analysis
assay <- intersect(c("RNA", "Spatial", "Xenium"), Assays(analysis))[1]
if (is.na(assay)) stop("No count assay (RNA, Spatial or Xenium) is present.")

# scDblFinder works on raw counts. Seurat v5 may hold one counts layer per
# sample; join them on a copy so every cell is scored once.
joined <- JoinLayers(analysis[[assay]])
counts <- SeuratObject::LayerData(joined, layer = "counts")

sample_column <- params[["sample-column"]]
samples <- NULL
if (nzchar(sample_column)) {
  if (!sample_column %in% colnames(analysis[[]])) stop("The sample column is not in the cell metadata.")
  samples <- as.character(analysis[[sample_column, drop = TRUE]])
}
dbr <- params[["expected-doublet-rate"]]

# --- vignette: Usage -----------------------------------------------------
sce <- SingleCellExperiment::SingleCellExperiment(list(counts = counts))
set.seed(seed)
sce <- scDblFinder::scDblFinder(
  sce,
  samples = samples,
  clusters = identical(params[["artificial-doublets"]], "cluster-based"),
  dbr = if (dbr > 0) dbr else NULL
)
# -------------------------------------------------------------------------

analysis$scDblFinder.class <- as.character(sce$scDblFinder.class)
analysis$scDblFinder.score <- as.numeric(sce$scDblFinder.score)

calls <- table(factor(analysis$scDblFinder.class, levels = c("singlet", "doublet")))
by_sample <- if (is.null(samples)) rep("all", ncol(analysis)) else samples
per_sample <- as.data.frame(table(sample = by_sample, class = analysis$scDblFinder.class), stringsAsFactors = FALSE)
per_sample <- reshape(per_sample, idvar = "sample", timevar = "class", direction = "wide")
names(per_sample) <- sub("^Freq\\.", "", names(per_sample))
for (column in c("singlet", "doublet")) if (!column %in% names(per_sample)) per_sample[[column]] <- 0L
per_sample$doublet_rate <- round(per_sample$doublet / pmax(1, per_sample$doublet + per_sample$singlet), 4)

write_output("analysis", analysis)
write_output("summary", list(
  n_cells = ncol(analysis),
  n_doublets = as.integer(calls[["doublet"]]),
  n_singlets = as.integer(calls[["singlet"]]),
  doublet_rate = round(as.numeric(calls[["doublet"]]) / ncol(analysis), 4),
  n_samples = length(unique(by_sample))
))
write_output("per-sample", per_sample[, c("sample", "singlet", "doublet", "doublet_rate")])
figure <- if ("umap" %in% Reductions(analysis)) {
  DimPlot(analysis, reduction = "umap", group.by = "scDblFinder.class", cols = c(doublet = "#d7301f", singlet = "#bdbdbd"))
} else {
  ggplot2::ggplot(data.frame(score = analysis$scDblFinder.score), ggplot2::aes(x = score)) +
    ggplot2::geom_histogram(bins = 50) + ggplot2::theme_minimal()
}
write_output("figure", figure)
