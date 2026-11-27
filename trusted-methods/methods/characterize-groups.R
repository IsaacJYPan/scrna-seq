# Trusted method: unbiased characterization of every group (and, optionally,
# of a condition contrast within every group) against full gene-set
# collections, so interpretation starts from what the data enriches rather
# than from gene sets someone thought to write.
# Upstream: fgsea vignette (preranked GSEA) on Seurat FindAllMarkers / FindMarkers
# statistics, with MSigDB collections from msigdbr:
#   m <- FindAllMarkers(obj, logfc.threshold = 0, min.pct = 0.05, max.cells.per.ident = 500)
#   ranks <- setNames(m$avg_log2FC * -log10(m$p_val + 1e-300), m$gene)
#   pathways <- split(msigdbr(species = "Homo sapiens", category = "H")$gene_symbol, ...)
#   fgsea(pathways, ranks, minSize = 15, maxSize = 500)
# The `signals` output lists the strongest markers and pathways per group in
# a fixed shape (source, group, contrast, kind, name, score, padj); the
# analysis ledger audit flags strong signals that no ledger entry interprets.
suppressPackageStartupMessages({ library(fgsea); library(msigdbr) })
analysis <- inputs$analysis
group_column <- params[["group-column"]]
if (!group_column %in% colnames(analysis[[]])) stop("The group column is not in the cell metadata.")
species <- c(human = "Homo sapiens", mouse = "Mus musculus")[[params[["species"]]]]
collection_keys <- strsplit(params[["collections"]], ",", fixed = TRUE)[[1]]
collection_spec <- list(
  hallmark = c("H", ""), "go-bp" = c("C5", "GO:BP"), reactome = c("C2", "CP:REACTOME"),
  kegg = c("C2", "CP:KEGG"), immunologic = c("C7", "IMMUNESIGDB")
)
unknown <- setdiff(collection_keys, names(collection_spec))
if (length(unknown)) stop("Unknown collections: ", paste(unknown, collapse = ", "))
pathways <- list()
for (key in collection_keys) {
  spec <- collection_spec[[key]]
  sets <- if (nzchar(spec[[2]])) msigdbr(species = species, category = spec[[1]], subcategory = spec[[2]])
          else msigdbr(species = species, category = spec[[1]])
  split_sets <- split(sets$gene_symbol, sets$gs_name)
  names(split_sets) <- paste0(key, ":", names(split_sets))
  pathways <- c(pathways, split_sets)
}

set.seed(seed)
DefaultAssay(analysis) <- if ("RNA" %in% names(analysis@assays)) "RNA" else DefaultAssay(analysis)
analysis <- tryCatch(JoinLayers(analysis), error = function(e) analysis)
groups <- as.character(analysis[[group_column, drop = TRUE]])
counts <- table(groups)
kept <- names(counts)[counts >= params[["min-cells"]]]
if (length(kept) < 2) stop("Fewer than two groups have enough cells.")
analysis <- analysis[, groups %in% kept]
Idents(analysis) <- factor(as.character(analysis[[group_column, drop = TRUE]]))
max_cells <- params[["max-cells-per-group"]]

rank_stat <- function(table) {
  table <- table[is.finite(table$avg_log2FC) & !is.na(table$p_val), ]
  stat <- sign(table$avg_log2FC) * -log10(pmax(table$p_val, 1e-300))
  stat <- stat + table$avg_log2FC * 1e-6  # break ties
  sort(setNames(stat, table$gene), decreasing = TRUE)
}

run_gsea <- function(ranks, group, contrast) {
  ranks <- ranks[!duplicated(names(ranks))]
  result <- suppressWarnings(fgsea(pathways, ranks, minSize = params[["min-set-size"]], maxSize = 500, eps = 0))
  if (!nrow(result)) return(NULL)
  data.frame(group = group, contrast = contrast, collection = sub(":.*$", "", result$pathway),
             pathway = sub("^[^:]*:", "", result$pathway), NES = round(result$NES, 4), padj = signif(result$padj, 4),
             size = result$size, leading_edge = vapply(result$leadingEdge, function(g) paste(head(g, 12), collapse = ","), ""))
}

markers <- FindAllMarkers(analysis, logfc.threshold = 0, min.pct = 0.05, max.cells.per.ident = max_cells,
                          random.seed = seed, verbose = FALSE)
markers$group <- as.character(markers$cluster)
enrichment <- do.call(rbind, lapply(kept, function(g) run_gsea(rank_stat(markers[markers$group == g, ]), g, "group_vs_rest")))

contrast_column <- params[["condition-column"]]
if (nzchar(contrast_column)) {
  if (!contrast_column %in% colnames(analysis[[]])) stop("The condition column is not in the cell metadata.")
  reference <- params[["reference"]]
  conditions <- as.character(analysis[[contrast_column, drop = TRUE]])
  if (!reference %in% conditions) stop("The reference condition is not in the condition column.")
  for (g in kept) {
    in_group <- as.character(Idents(analysis)) == g
    for (test in setdiff(unique(conditions[in_group]), reference)) {
      a <- colnames(analysis)[in_group & conditions == test]
      b <- colnames(analysis)[in_group & conditions == reference]
      if (length(a) < params[["min-cells"]] || length(b) < params[["min-cells"]]) next
      a <- if (length(a) > max_cells) sample(a, max_cells) else a
      b <- if (length(b) > max_cells) sample(b, max_cells) else b
      de <- FindMarkers(analysis, ident.1 = a, ident.2 = b, logfc.threshold = 0, min.pct = 0.05, verbose = FALSE)
      de$gene <- rownames(de)
      contrast <- paste0(test, "_vs_", reference)
      de$group <- g
      de$contrast <- contrast
      markers <- rbind(markers[, intersect(colnames(markers), colnames(de))], de[, intersect(colnames(markers), colnames(de))])
      enrichment <- rbind(enrichment, run_gsea(rank_stat(de), g, contrast))
    }
  }
}
if (!"contrast" %in% colnames(markers)) markers$contrast <- "group_vs_rest"
markers$contrast[is.na(markers$contrast)] <- "group_vs_rest"

# The strongest signals per group and contrast, in the shape the ledger audit reads.
top_n <- params[["top-signals"]]
signal_rows <- list()
for (key in unique(paste(markers$group, markers$contrast, sep = "\r"))) {
  parts <- strsplit(key, "\r", fixed = TRUE)[[1]]
  m <- markers[markers$group == parts[[1]] & markers$contrast == parts[[2]] & markers$p_val_adj < 0.05, ]
  up <- head(m[order(-m$avg_log2FC), ][m[order(-m$avg_log2FC), "avg_log2FC"] > 0, ], top_n)
  down <- if (parts[[2]] == "group_vs_rest") m[0, ] else head(m[order(m$avg_log2FC), ][m[order(m$avg_log2FC), "avg_log2FC"] < 0, ], top_n)
  both <- rbind(up, down)
  if (nrow(both)) signal_rows[[length(signal_rows) + 1]] <- data.frame(
    source = "characterize-groups", group = parts[[1]], contrast = parts[[2]], kind = "gene", name = both$gene,
    score = round(both$avg_log2FC, 4), padj = signif(both$p_val_adj, 4))
  e <- enrichment[enrichment$group == parts[[1]] & enrichment$contrast == parts[[2]] & enrichment$padj < 0.05, ]
  e <- rbind(head(e[order(-e$NES), ][e[order(-e$NES), "NES"] > 0, ], top_n), head(e[order(e$NES), ][e[order(e$NES), "NES"] < 0, ], top_n))
  if (nrow(e)) signal_rows[[length(signal_rows) + 1]] <- data.frame(
    source = "characterize-groups", group = parts[[1]], contrast = parts[[2]], kind = "pathway",
    name = e$pathway, score = e$NES, padj = e$padj)
}
# A contrast effect that points the same way in every group can be real even
# when no single group reaches significance (few cells per group): report
# pathways whose NES has the same sign in all groups as one "all groups" signal.
for (contrast in setdiff(unique(enrichment$contrast), "group_vs_rest")) {
  e <- enrichment[enrichment$contrast == contrast, ]
  n_groups <- length(unique(e$group))
  if (n_groups < 2) next
  by_path <- split(e, e$pathway)
  consistent <- do.call(rbind, lapply(by_path, function(d) {
    if (nrow(d) < n_groups || length(unique(sign(d$NES))) != 1 || median(abs(d$NES)) < params[["consistent-nes"]]) return(NULL)
    data.frame(pathway = d$pathway[[1]], score = round(median(d$NES), 4), padj = min(d$padj))
  }))
  if (!is.null(consistent) && nrow(consistent)) {
    consistent <- head(consistent[order(-abs(consistent$score)), ], top_n * 2)
    signal_rows[[length(signal_rows) + 1]] <- data.frame(
      source = "characterize-groups", group = "all groups", contrast = contrast, kind = "pathway",
      name = consistent$pathway, score = consistent$score, padj = consistent$padj)
  }
}
signals <- if (length(signal_rows)) do.call(rbind, signal_rows) else
  data.frame(source = character(), group = character(), contrast = character(), kind = character(), name = character(), score = numeric(), padj = numeric())

top_paths <- enrichment[enrichment$contrast == "group_vs_rest" & enrichment$padj < 0.05, ]
top_paths <- do.call(rbind, lapply(split(top_paths, top_paths$group), function(d) head(d[order(-d$NES), ], 3)))
plot_data <- enrichment[enrichment$contrast == "group_vs_rest" & enrichment$pathway %in% unique(top_paths$pathway), ]
figure <- ggplot2::ggplot(plot_data, ggplot2::aes(x = group, y = pathway, fill = NES)) +
  ggplot2::geom_tile() + ggplot2::scale_fill_gradient2(low = "#2166ac", mid = "white", high = "#b2182b") +
  ggplot2::theme_minimal(base_size = 9) + ggplot2::theme(axis.text.x = ggplot2::element_text(angle = 45, hjust = 1)) +
  ggplot2::labs(x = group_column, y = NULL, title = "Top enriched pathways per group (NES)")

write_output("signals", signals)
write_output("enrichment", enrichment[order(enrichment$group, enrichment$contrast, enrichment$padj), ])
write_output("markers", markers[order(markers$group, markers$contrast, markers$p_val_adj), c("group", "contrast", "gene", "avg_log2FC", "pct.1", "pct.2", "p_val", "p_val_adj")])
write_output("pathway-heatmap", figure, width = 10, height = max(4, 0.18 * length(unique(plot_data$pathway)) + 2))
write_output("summary", list(
  n_groups = length(kept), n_contrasts = length(unique(markers$contrast)) - 1L, n_pathways_tested = length(pathways),
  n_significant_pathways = sum(enrichment$padj < 0.05, na.rm = TRUE), n_signals = nrow(signals)))
