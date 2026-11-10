# Reviewed, data-only multi-condition investigations. No caller-supplied R code.
study_group_map <- function(obj, value = NULL) {
  if (is.null(value) || identical(value, "")) return(obj)
  if (!is.character(value) || length(value) != 1L || nchar(value) > 3000L) stop("Invalid group map")
  pairs <- strsplit(value, ";", fixed = TRUE)[[1]]
  if (
    length(pairs) > 64L ||
      any(!grepl("^[A-Za-z0-9_.-]{1,80}=[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$", pairs))
  ) stop("Invalid group map")
  keys <- sub("=.*$", "", pairs)
  values <- sub("^[^=]*=", "", pairs)
  groups <- as.character(obj$seurat_clusters)
  if (anyDuplicated(keys) || !setequal(unique(groups), keys)) stop("Map must cover every original cluster exactly once")
  obj$seurat_clusters <- unname(setNames(values, keys)[groups])
  Idents(obj) <- obj$seurat_clusters
  obj
}

study_frame <- function(frame, limit = 3000L) {
  frame <- head(frame, limit)
  list(
    columns = as.list(colnames(frame)),
    rows = lapply(seq_len(nrow(frame)), function(i) unname(as.list(frame[i, , drop = FALSE])))
  )
}

# Contrast recipes test a person-registered contrast. The server resolves its
# pinned sample snapshot; labels in cell metadata never define the design.
study_contrast_design <- function(design, contrast_labels) {
  if (is.null(design)) stop("A registered condition contrast is required for this recipe")
  labels <- if (is.list(contrast_labels)) contrast_labels else list()
  label <- function(value, fallback) {
    if (is_scalar_string(value) && grepl("^[A-Za-z0-9 ._+()-]{1,80}$", value)) value else fallback
  }
  list(
    design = normalize_condition_pseudobulk_design(design),
    numerator = label(labels$numerator, "numerator"),
    denominator = label(labels$denominator, "denominator")
  )
}

condition_study_analysis <- function(input_obj, params, design = NULL, contrast_labels = NULL) {
  obj <- study_group_map(input_obj, params$groupMap)
  if (!all(c("sample_id", "condition") %in% colnames(obj[[]]))) stop("Multi-sample metadata required")
  if (!is.null(params$conditionName) && params$conditionName != "all") {
    keep <- colnames(obj)[obj$condition == params$conditionName]
    if (length(keep) < 20L) stop("Condition has insufficient cells")
    obj <- subset(obj, cells = keep)
  }
  meta <- obj[[]]
  meta$group <- as.character(obj$seurat_clusters)
  features <- if (is.null(params$featureNames) || params$featureNames == "") character() else
    strsplit(params$featureNames, ",", fixed = TRUE)[[1]]
  if (length(features) > 12L || any(!grepl("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", features))) stop("Invalid gene list")
  missing_features <- setdiff(features, rownames(obj))
  features <- intersect(features, rownames(obj))
  recipe <- params$recipe
  tables <- list()
  warnings <- character()
  if (length(missing_features)) warnings <- c(
    warnings,
    paste("Absent requested genes:", paste(missing_features, collapse = ","))
  )
  if (recipe == "study_composition") {
    frame <- as.data.frame(table(sample = meta$sample_id, group = meta$group), stringsAsFactors = FALSE)
    names(frame)[3] <- "cells"
    sample_condition <- unique(meta[, c("sample_id", "condition")])
    frame$condition <- sample_condition$condition[match(frame$sample, sample_condition$sample_id)]
    frame$fraction <- frame$cells / as.numeric(table(meta$sample_id)[frame$sample])
    tables$composition <- study_frame(frame)
    p <- ggplot(frame, aes(x = sample, y = fraction, fill = group)) +
      geom_col() +
      facet_grid(~condition, scales = "free_x", space = "free_x") +
      theme_classic(11) +
      theme(axis.text.x = element_text(angle = 90, hjust = 1)) +
      labs(x = "Independent donor sample", y = "Fraction of retained cells", fill = "Population")
  } else if (recipe == "study_qc") {
    rows <- do.call(rbind, lapply(split(meta, meta$sample_id), function(m) data.frame(
      sample = m$sample_id[1],
      condition = m$condition[1],
      cells = nrow(m),
      median_counts = median(m$nCount_RNA),
      median_genes = median(m$nFeature_RNA),
      median_mt = median(m$percent.mt)
    )))
    tables$sample_qc <- study_frame(rows)
    p <- VlnPlot(
      obj,
      features = c("nFeature_RNA", "nCount_RNA", "percent.mt"), group.by = "sample_id", pt.size = 0, ncol = 1
    ) &
      theme_classic(11) &
      theme(legend.position = "none", axis.text.x = element_text(angle = 90, hjust = 1))
  } else if (recipe == "study_expression") {
    if (!length(features)) stop("Supply featureNames for a hypothesis-driven panel")
    counts <- LayerData(obj, assay = "RNA", layer = "counts")[features, , drop = FALSE]
    expression <- LayerData(obj, assay = "RNA", layer = "data")[features, , drop = FALSE]
    strata <- split(seq_len(ncol(obj)), paste(meta$sample_id, meta$group, sep = "::"))
    frame <- do.call(rbind, lapply(strata, function(idx) data.frame(
      sample = meta$sample_id[idx[1]],
      condition = meta$condition[idx[1]],
      group = meta$group[idx[1]],
      gene = features,
      mean_log_expression = as.numeric(Matrix::rowMeans(expression[, idx, drop = FALSE])),
      pct_detected = as.numeric(Matrix::rowMeans(counts[, idx, drop = FALSE] > 0) * 100),
      cells = length(idx)
    )))
    if (nrow(frame) > 3000L) stop("Expression table exceeds budget; request fewer genes")
    tables$expression <- study_frame(frame)
    # Each point is one donor-population aggregate, not an independent cell.
    p <- ggplot(frame, aes(x = condition, y = mean_log_expression, color = group)) +
      geom_point(position = position_jitter(width = .12, height = 0, seed = 42), size = 1.4) +
      facet_wrap(~gene, scales = "free_y", ncol = 4) +
      theme_classic(11) +
      theme(axis.text.x = element_text(angle = 45, hjust = 1)) +
      labs(x = "Condition", y = "Mean log-normalized expression per donor", color = "Population")
  } else if (recipe %in% c("study_de", "study_pathways")) {
    contrast <- study_contrast_design(design, contrast_labels)
    design <- contrast$design
    analysis <- run_condition_pseudobulk_de(obj, design)
    frame <- analysis$table
    if (!nrow(frame)) stop("No populations have sufficient replication and counts")
    tables$de_summary <- study_frame(data.frame(
      group = unique(frame$cell_type),
      tested = vapply(unique(frame$cell_type), function(g) sum(frame$cell_type == g), integer(1)),
      significant = vapply(unique(frame$cell_type), function(g) sum(frame$cell_type == g & frame$fdr <= .05), integer(1))
    ))
    # Retain top hits for EVERY population plus every explicitly requested gene.
    top <- do.call(rbind, lapply(split(frame, frame$cell_type), function(f) head(f[order(f$fdr, f$p_value), ], 30)))
    selected <- frame[frame$gene %in% features, , drop = FALSE]
    tables$de_hits <- study_frame(unique(rbind(top, selected)))
    tables$design <- study_frame(do.call(rbind, lapply(design$samples, as.data.frame)))
    if (recipe == "study_de") {
      frame$significant <- frame$fdr <= .05
      frame$minus_log10_fdr <- pmin(100, -log10(pmax(frame$fdr, 1e-100)))
      p <- ggplot(frame, aes(x = log_fc, y = minus_log10_fdr, color = significant)) +
        scattermore::geom_scattermore(pointsize = 2, pixels = c(768, 768), alpha = .5) +
        facet_wrap(~cell_type, scales = "free_x", ncol = 4) +
        scale_color_manual(values = c("grey70", "#B22222"), labels = c("FDR > 0.05", "FDR <= 0.05")) +
        theme_classic(11) +
        labs(
          x = paste0("Log2 fold change: ", contrast$numerator, " / ", contrast$denominator),
          y = "-log10 FDR (capped at 100)",
          color = "Within-population FDR"
        )
    } else {
      if (is.null(params$targetGroup) || !params$targetGroup %in% frame$cell_type) stop(
        "Choose targetGroup for condition pathway analysis"
      )
      f <- frame[frame$cell_type == params$targetGroup, ]
      mapped <- suppressMessages(AnnotationDbi::select(
        org.Hs.eg.db::org.Hs.eg.db,
        keys = unique(f$gene), keytype = "SYMBOL", columns = "ENTREZID"
      ))
      mapped <- mapped[!is.na(mapped$ENTREZID), ]
      mapped <- mapped[!duplicated(mapped$SYMBOL), ]
      f <- f[match(mapped$SYMBOL, f$gene), ]
      f$entrez <- mapped$ENTREZID
      f <- f[order(f$p_value, -abs(f$log_fc)), ]
      f <- f[!duplicated(f$entrez), ]
      ranks <- sort(setNames(sign(f$log_fc) * sqrt(f$f_statistic), f$entrez), decreasing = TRUE)
      set.seed(42)
      gsea <- suppressMessages(clusterProfiler::gseGO(
        geneList = ranks, OrgDb = org.Hs.eg.db::org.Hs.eg.db, keyType = "ENTREZID", ont = "BP",
        minGSSize = 15, maxGSSize = 500, pvalueCutoff = 1, verbose = FALSE, eps = 1e-10
      ))
      g <- as.data.frame(gsea)
      if (!nrow(g)) stop("No testable GO pathways")
      g <- g[order(g$p.adjust), ]
      tables$pathways <- study_frame(head(g[, intersect(
        c("ID", "Description", "setSize", "NES", "pvalue", "p.adjust", "core_enrichment"),
        names(g)
      ), drop = FALSE], 100))
      tables$mapping <- study_frame(data.frame(
        input_genes = nrow(frame[frame$cell_type == params$targetGroup, ]),
        mapped_genes = length(ranks),
        tested_pathways = nrow(g),
        significant_pathways = sum(g$p.adjust <= .05),
        rank_metric = "signed_sqrt_edgeR_QLF"
      ))
      display <- head(g, 15)
      display$Description <- stringr::str_wrap(display$Description, width = 48)
      display$Description <- factor(display$Description, levels = rev(display$Description))
      p <- ggplot(display, aes(x = NES, y = Description, color = p.adjust)) +
        geom_point(size = 3) +
        theme_classic(10) +
        labs(
          title = paste(params$targetGroup, contrast$numerator, "versus", contrast$denominator),
          y = NULL,
          color = "Adjusted P"
        )
    }
    warnings <- c(
      warnings,
      unlist(analysis$summary$warnings),
      "FDR is controlled within each population contrast; not jointly across all populations or contrasts."
    )
  } else if (recipe == "study_communication") {
    if (is.null(params$conditionName) || params$conditionName == "all") stop("Choose one condition; do not pool contexts")
    p0 <- normalize_cellchat_inference_params(list(
      groupBy = "seurat_clusters",
      assay = "RNA",
      species = "human",
      databaseCategory = "secreted_signaling",
      analysisIntent = "single_context",
      minCellsPerGroup = 20L,
      maxCellsPerGroup = 300L,
      maxTotalCells = 2000L,
      pValueCutoff = .05,
      topInteractions = 50L,
      topPathways = 25L,
      randomSeed = 42L
    ))
    analysis <- run_cellchat_inference_analysis(obj, p0)
    frame <- analysis$table
    if (!nrow(frame)) stop("No communication candidates")
    tables$interactions <- study_frame(head(frame, 100))
    tables$group_mapping <- study_frame(data.frame(
      native_group = paste("Group", seq_along(sort(unique(meta$group)))),
      population = sort(unique(meta$group))
    ))
    tables$communication_summary <- study_frame(data.frame(
      input_cells = ncol(obj),
      analyzed_cells = analysis$summary$analyzed_cell_count,
      retained_interactions = nrow(frame),
      distinct_pathways = length(unique(frame$pathway_name)),
      max_cells_per_group = 300L,
      max_total_cells = 2000L
    ))
    display <- head(frame, 25)
    display$edge <- paste(display$source_group, display$target_group, display$interaction_name, sep = " : ")
    display$edge <- factor(display$edge, levels = rev(unique(display$edge)))
    p <- ggplot(display, aes(x = probability, y = edge)) +
      geom_point(color = "#306998", size = 2) +
      theme_classic(9) +
      labs(title = paste("Candidate signaling:", params$conditionName), x = "CellChat model score", y = NULL)
    warnings <- c(
      warnings,
      unlist(analysis$summary$warnings),
      "Contexts are pooled within condition; differences are descriptive, not donor-replicated differential communication tests."
    )
  } else stop("Unapproved study recipe")
  summary <- list(
    recipe = recipe,
    condition = params$conditionName,
    contrastId = params$contrastId,
    nCells = ncol(obj),
    groupMap = params$groupMap,
    pointRendering = if (recipe == "study_de") "all_tested_genes_raster_points_vector_axes" else "recipe_native",
    warnings = as.list(c(
      warnings,
      "Investigation tables are bounded: DE hits show top 30 per population plus requested genes; pathways and interactions show top 100. These are not full result-table exports."
    )),
    tables = lapply(tables, function(t) list(rows = length(t$rows), columns = t$columns))
  )
  encode_study_figure(p, recipe, obj, features, summary, tables)
}
