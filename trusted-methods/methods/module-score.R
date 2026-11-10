# Trusted method: gene-signature (module) scores per cell.
# Upstream: Seurat reference for AddModuleScore and its use in the
# cell-cycle vignette; method of Tirosh et al. 2016:
#   obj <- AddModuleScore(obj, features = list(c("CD3E", "CD3D", ...)),
#                         name = "Tcell_score")
#   FeaturePlot(obj, features = "Tcell_score1"); VlnPlot(obj, "Tcell_score1")
# Gene sets are data written as "Name:GENE1,GENE2;Other:GENE3,GENE4".
analysis <- inputs$analysis
sets <- strsplit(strsplit(params[["gene-sets"]], ";", fixed = TRUE)[[1]], ":", fixed = TRUE)
if (!length(sets) || any(lengths(sets) != 2)) stop("Write gene sets as Name:GENE1,GENE2 separated by semicolons.")
set_names <- trimws(vapply(sets, `[[`, "", 1))
if (anyDuplicated(set_names)) stop("Gene set names must be unique.")
features <- lapply(sets, function(set) unique(trimws(strsplit(set[[2]], ",", fixed = TRUE)[[1]])))
present <- lapply(features, intersect, rownames(analysis))
coverage <- data.frame(
  gene_set = set_names,
  genes_listed = lengths(features),
  genes_found = lengths(present),
  missing = vapply(seq_along(features), function(i) paste(head(setdiff(features[[i]], present[[i]]), 20), collapse = ","), "")
)
if (any(lengths(present) < params[["min-genes"]])) {
  stop(sprintf("Gene set(s) with fewer than %d genes present: %s", params[["min-genes"]],
               paste(set_names[lengths(present) < params[["min-genes"]]], collapse = ", ")))
}

set.seed(seed)
before <- colnames(analysis[[]])
analysis <- AddModuleScore(analysis, features = present, name = paste0(set_names, "_score"),
                           ctrl = params[["control-genes"]], nbin = params[["bins"]], seed = seed)
# AddModuleScore appends an index (Name_score1, Other_score2); store the
# plain names the researcher gave.
added <- setdiff(colnames(analysis[[]]), before)
score_columns <- paste0(set_names, "_score")
for (i in seq_along(added)) {
  analysis[[score_columns[[i]]]] <- analysis[[added[[i]], drop = TRUE]]
  analysis[[added[[i]]]] <- NULL
}

group_column <- params[["group-column"]]
if (!group_column %in% colnames(analysis[[]])) stop("The group column is not in the cell metadata.")
groups <- as.character(analysis[[group_column, drop = TRUE]])
means <- do.call(rbind, lapply(score_columns, function(column) {
  values <- analysis[[column, drop = TRUE]]
  data.frame(gene_set = sub("_score$", "", column), group = sort(unique(groups)),
             mean_score = vapply(sort(unique(groups)), function(g) round(mean(values[groups == g]), 5), 0))
}))
best <- means[order(-means$mean_score), ][!duplicated(means[order(-means$mean_score), "gene_set"]), ]

write_output("analysis", analysis)
summary <- list(n_gene_sets = length(set_names), n_cells = ncol(analysis), min_genes_found = min(lengths(present)))
for (i in seq_len(min(nrow(best), 10))) summary[[paste0("top_group_", best$gene_set[[i]])]] <- best$group[[i]]
write_output("summary", summary)
write_output("scores-by-group", means)
write_output("coverage", coverage)
write_output("violin", VlnPlot(analysis, features = score_columns, group.by = group_column, pt.size = 0, ncol = min(3, length(score_columns))),
             width = min(16, 4 + 4 * min(3, length(score_columns))), height = min(16, 4 * ceiling(length(score_columns) / 3)))
