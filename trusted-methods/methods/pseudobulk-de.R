# Trusted method: pseudobulk differential expression within each cell type.
# Upstream: "Orchestrating Single-Cell Analysis with Bioconductor" (OSCA),
# Multi-sample comparisons, chapter "Differential expression between
# conditions", whose pseudoBulkDGE() runs, per label:
#   summed <- aggregateAcrossCells(sce, id = DataFrame(label, sample))
#   summed <- summed[, summed$ncells >= 10]
#   y <- DGEList(counts(summed)); keep <- filterByExpr(y, group = condition)
#   y <- calcNormFactors(y[keep, ]); y <- estimateDisp(y, design)
#   fit <- glmQLFit(y, design, robust = TRUE); res <- glmQLFTest(fit, coef = ...)
# These are the edgeR quasi-likelihood steps of the edgeR User's Guide.
# Samples, not cells, are the replicates.
if (!requireNamespace("edgeR", quietly = TRUE)) stop("edgeR is not installed in this R runtime.")
analysis <- inputs$analysis
meta <- analysis[[]]
need <- c(params[["cell-type-column"]], params[["sample-column"]], params[["condition-column"]])
paired <- nzchar(params[["donor-column"]])
if (paired) need <- c(need, params[["donor-column"]])
if (any(!need %in% colnames(meta))) stop("A cell type, sample, condition or donor column is not in the cell metadata.")
cell_type <- as.character(meta[[need[[1]]]])
sample <- as.character(meta[[need[[2]]]])
condition <- as.character(meta[[need[[3]]]])
reference <- params[["reference"]]
test <- params[["test"]]
if (!all(c(reference, test) %in% condition)) stop("The reference and test conditions must both occur in the condition column.")
sample_info <- unique(data.frame(sample = sample, condition = condition, donor = if (paired) as.character(meta[[need[[4]]]]) else NA))
if (anyDuplicated(sample_info$sample)) stop("A sample appears under more than one condition or donor.")

assay <- intersect(c("RNA", "Spatial", "Xenium"), Assays(analysis))[1]
counts <- SeuratObject::LayerData(JoinLayers(analysis[[assay]]), layer = "counts")
keep_cells <- condition %in% c(reference, test)

results <- list(); tested <- list()
for (type in sort(unique(cell_type[keep_cells]))) {
  cells <- which(keep_cells & cell_type == type)
  # aggregateAcrossCells: sum counts per sample within this cell type.
  groups <- factor(sample[cells])
  indicator <- Matrix::sparse.model.matrix(~ 0 + groups)
  colnames(indicator) <- levels(groups)
  summed <- as.matrix(counts[, cells, drop = FALSE] %*% indicator)
  n_cells <- as.vector(table(groups))
  summed <- summed[, n_cells >= params[["min-cells"]], drop = FALSE]
  info <- sample_info[match(colnames(summed), sample_info$sample), ]
  n_ref <- sum(info$condition == reference); n_test <- sum(info$condition == test)
  status <- "tested"
  if (n_ref < params[["min-samples"]] || n_test < params[["min-samples"]]) status <- "too few samples"
  if (status == "tested") {
    group <- factor(info$condition, levels = c(reference, test))
    design <- if (paired) model.matrix(~ factor(info$donor) + group) else model.matrix(~ group)
    if (qr(design)$rank < ncol(design) || nrow(design) <= ncol(design)) status <- "design not estimable"
  }
  if (status == "tested") {
    y <- edgeR::DGEList(summed)
    keep <- edgeR::filterByExpr(y, group = group)
    y <- edgeR::calcNormFactors(y[keep, , keep.lib.sizes = FALSE])
    y <- edgeR::estimateDisp(y, design)
    fit <- edgeR::glmQLFit(y, design, robust = TRUE)
    res <- edgeR::topTags(edgeR::glmQLFTest(fit, coef = ncol(design)), n = Inf)$table
    results[[type]] <- data.frame(cell_type = type, gene = rownames(res), logFC = signif(res$logFC, 5),
                                  logCPM = signif(res$logCPM, 5), F = signif(res$F, 5),
                                  PValue = signif(res$PValue, 5), FDR = signif(res$FDR, 5), row.names = NULL)
  }
  tested[[type]] <- data.frame(cell_type = type, status = status, samples_reference = n_ref, samples_test = n_test,
                               genes_tested = if (status == "tested") nrow(results[[type]]) else 0L,
                               significant = if (status == "tested") sum(results[[type]]$FDR < params[["fdr"]]) else 0L)
}
overview <- do.call(rbind, tested)
full <- if (length(results)) do.call(rbind, results) else data.frame()
top <- if (nrow(full)) do.call(rbind, lapply(split(full, full$cell_type), function(x) head(x[order(x$FDR), ], params[["rows-per-type"]]))) else full

write_output("summary", list(
  cell_types_tested = sum(overview$status == "tested"),
  cell_types_skipped = sum(overview$status != "tested"),
  total_significant = sum(overview$significant),
  reference = reference, test = test, paired = paired,
  fdr = params[["fdr"]]
))
write_output("overview", overview)
write_output("top-genes", head(top, 50000))
write_output("full-results", full)
if (nrow(full)) {
  write_output("volcano", ggplot2::ggplot(full, ggplot2::aes(x = logFC, y = -log10(PValue), colour = FDR < params[["fdr"]])) +
    ggplot2::geom_point(size = 0.4) + ggplot2::facet_wrap(~cell_type) + ggplot2::theme_minimal() +
    ggplot2::scale_colour_manual(values = c(`FALSE` = "#bdbdbd", `TRUE` = "#d7301f"), name = "Significant"), width = 12, height = 9)
} else {
  write_output("volcano", ggplot2::ggplot() + ggplot2::annotate("text", x = 0, y = 0, label = "No cell type had enough samples to test.") + ggplot2::theme_void())
}
