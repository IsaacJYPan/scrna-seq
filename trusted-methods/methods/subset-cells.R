# Trusted method: keep or drop cells by one metadata column.
# Upstream: Seurat "Seurat - Guided Clustering Tutorial" (pbmc3k), QC section:
# `pbmc <- subset(pbmc, subset = nFeature_RNA > 200 & ...)`, and the
# subclustering pattern `subset(obj, idents = c(...))` used throughout the
# Seurat vignettes. Used to remove doublets, drop low-quality clusters, or
# select one lineage before re-clustering (recluster-integrate).
analysis <- inputs$analysis
column <- params[["column"]]
if (!column %in% colnames(analysis[[]])) stop("The selected column is not in the cell metadata.")
values <- trimws(strsplit(params[["values"]], ",", fixed = TRUE)[[1]])
values <- values[nzchar(values)]
if (!length(values)) stop("List at least one value.")

labels <- as.character(analysis[[column, drop = TRUE]])
missing <- setdiff(values, unique(labels))
if (length(missing) == length(values)) stop("None of the listed values occur in that column.")
selected <- labels %in% values
keep <- if (identical(params[["mode"]], "keep")) selected else !selected
if (sum(keep) < params[["min-cells"]]) stop("Fewer cells would remain than the minimum you set.")

before <- ncol(analysis)
analysis <- subset(analysis, cells = colnames(analysis)[keep])
# Factor levels of removed groups would otherwise persist in plots and tests.
for (field in colnames(analysis[[]])) {
  if (is.factor(analysis[[field, drop = TRUE]])) analysis[[field]] <- droplevels(analysis[[field, drop = TRUE]])
}
Idents(analysis) <- droplevels(Idents(analysis))

kept <- as.data.frame(table(value = as.character(analysis[[column, drop = TRUE]])), stringsAsFactors = FALSE)
names(kept) <- c("value", "cells")
write_output("analysis", analysis)
write_output("summary", list(
  cells_before = before,
  cells_after = ncol(analysis),
  cells_removed = before - ncol(analysis),
  fraction_kept = round(ncol(analysis) / before, 4),
  values_not_found = length(missing)
))
write_output("kept", kept)
