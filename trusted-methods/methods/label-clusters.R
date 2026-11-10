# Trusted method: name clusters from a researcher-supplied mapping.
# Upstream: Seurat pbmc3k tutorial, "Assigning cell type identity to clusters":
#   new.cluster.ids <- c("Naive CD4 T", "CD14+ Mono", ...)
#   names(new.cluster.ids) <- levels(pbmc)
#   pbmc <- RenameIdents(pbmc, new.cluster.ids)
#   DimPlot(pbmc, reduction = "umap", label = TRUE, pt.size = 0.5) + NoLegend()
# The mapping is data ("0=Naive CD4 T;1=CD14+ Mono"), fixed by a person.
analysis <- inputs$analysis
source_column <- params[["cluster-column"]]
target_column <- params[["label-column"]]
if (!source_column %in% colnames(analysis[[]])) stop("The cluster column is not in the cell metadata.")

pairs <- strsplit(strsplit(params[["mapping"]], ";", fixed = TRUE)[[1]], "=", fixed = TRUE)
if (!length(pairs) || any(lengths(pairs) != 2)) stop("Write the mapping as cluster=label pairs separated by semicolons.")
new_ids <- setNames(trimws(vapply(pairs, `[[`, "", 2)), trimws(vapply(pairs, `[[`, "", 1)))
if (anyDuplicated(names(new_ids))) stop("A cluster appears twice in the mapping.")

clusters <- as.character(analysis[[source_column, drop = TRUE]])
unknown <- setdiff(names(new_ids), unique(clusters))
if (length(unknown)) stop(sprintf("Mapping names clusters that do not exist: %s", paste(head(unknown, 5), collapse = ", ")))
labels <- unname(new_ids[clusters])
unmapped <- is.na(labels)
labels[unmapped] <- if (identical(params[["unmapped"]], "keep-cluster")) clusters[unmapped] else "Unassigned"

analysis[[target_column]] <- labels
Idents(analysis) <- factor(labels, levels = unique(c(unname(new_ids), labels)))

counts <- as.data.frame(table(cluster = clusters, label = labels), stringsAsFactors = FALSE)
counts <- counts[counts$Freq > 0, ]
names(counts)[3] <- "cells"
write_output("analysis", analysis)
write_output("summary", list(
  n_labels = length(unique(labels)),
  clusters_mapped = length(new_ids),
  clusters_unmapped = length(unique(clusters[unmapped])),
  cells_unmapped = sum(unmapped),
  label_column = target_column
))
write_output("assignments", counts)
if ("umap" %in% Reductions(analysis)) {
  write_output("umap", DimPlot(analysis, reduction = "umap", label = TRUE, pt.size = 0.5, repel = TRUE) + NoLegend())
} else {
  write_output("umap", ggplot2::ggplot(counts, ggplot2::aes(x = label, y = cells)) + ggplot2::geom_col() +
    ggplot2::coord_flip() + ggplot2::theme_minimal())
}
