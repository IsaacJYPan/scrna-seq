# -- Ranked pathway enrichment helpers ------------------------------------------------
#
# These helpers are deliberately narrow and are shared by the worker-only endpoint and
# its R unit tests. They accept no function names, code, paths, metadata columns, or gene
# set sources from the browser. The only supported v1 collection is local Gene Ontology
# Biological Process data shipped in the mandatory Bioconductor packages.
enrichment_gsea_safe_summary_string <- function(value, max_chars = 240L) {
  if (!is.character(value) || length(value) != 1L || is.na(value)) return("")
  clean <- gsub("[[:cntrl:]]", " ", enc2utf8(value), perl = TRUE)
  clean <- gsub("[^A-Za-z0-9 ._:+-]", " ", clean, perl = TRUE)
  clean <- gsub("[[:space:]]+", " ", clean, perl = TRUE)
  substr(trimws(clean), 1L, max_chars)
}

enrichment_gsea_input_error <- function(message) {
  stop(structure(
    list(message = message, call = NULL),
    class = c("enrichment_gsea_input_error", "error", "condition")
  ))
}

normalize_enrichment_gsea_params <- function(p) {
  allowed <- c(
    "groupBy", "assay", "targetGroup", "species", "geneSetCollection",
    "minGeneSetSize", "maxGeneSetSize", "adjustedPValueCutoff", "topPathways",
    "maxCellsPerIdent", "randomSeed"
  )
  if (!is.list(p) || is.null(names(p)) || anyDuplicated(names(p)) ||
      !setequal(names(p), allowed) || length(names(p)) != length(allowed)) {
    enrichment_gsea_input_error("Invalid ranked enrichment parameters.")
  }

  scalar_choice <- function(value, choices) {
    is.character(value) && length(value) == 1L && !is.na(value) && value %in% choices
  }
  scalar_number <- function(value, lower, upper, integer = FALSE) {
    if (!is.numeric(value) || length(value) != 1L || is.na(value) || !is.finite(value) ||
        value < lower || value > upper || (integer && value != floor(value))) {
      enrichment_gsea_input_error("Invalid ranked enrichment parameters.")
    }
    if (integer) as.integer(value) else as.numeric(value)
  }

  if (!scalar_choice(p$groupBy, c("seurat_clusters", "ident")) ||
      !scalar_choice(p$assay, c("RNA", "SCT")) ||
      !scalar_choice(p$species, c("human", "mouse")) ||
      !scalar_choice(p$geneSetCollection, c("GO_BP"))) {
    enrichment_gsea_input_error("Invalid ranked enrichment parameters.")
  }
  if (!is.character(p$targetGroup) || length(p$targetGroup) != 1L ||
      is.na(p$targetGroup) || !identical(p$targetGroup, trimws(p$targetGroup)) ||
      nchar(p$targetGroup, type = "bytes") < 1L ||
      nchar(p$targetGroup, type = "bytes") > 80L ||
      grepl("[[:cntrl:]]", p$targetGroup, perl = TRUE) ||
      !grepl("^[A-Za-z0-9 ._+()\\-]+$", p$targetGroup, perl = TRUE) ||
      p$targetGroup %in% c(".", "..") ||
      grepl("^(www\\.|https?:|file:)", p$targetGroup, ignore.case = TRUE, perl = TRUE)) {
    enrichment_gsea_input_error("Invalid ranked enrichment parameters.")
  }

  min_gene_set_size <- scalar_number(p$minGeneSetSize, 10, 200, integer = TRUE)
  max_gene_set_size <- scalar_number(p$maxGeneSetSize, 50, 2000, integer = TRUE)
  if (max_gene_set_size <= min_gene_set_size) {
    enrichment_gsea_input_error("Invalid ranked enrichment parameters.")
  }
  max_cells <- scalar_number(p$maxCellsPerIdent, 10, 100000, integer = TRUE)

  list(
    group_by = p$groupBy,
    assay = p$assay,
    target_group = p$targetGroup,
    species = p$species,
    gene_set_collection = p$geneSetCollection,
    min_gene_set_size = min_gene_set_size,
    max_gene_set_size = max_gene_set_size,
    adjusted_p_value_cutoff = scalar_number(p$adjustedPValueCutoff, 0.000001, 1),
    top_pathways = scalar_number(p$topPathways, 5, 25, integer = TRUE),
    max_cells_per_ident = max_cells,
    random_seed = scalar_number(p$randomSeed, 0, 2147483647, integer = TRUE)
  )
}

empty_enrichment_gsea_table <- function() {
  data.frame(
    pathway_id = character(),
    pathway_name = character(),
    normalized_enrichment_score = numeric(),
    p_value = numeric(),
    adjusted_p_value = numeric(),
    set_size = integer(),
    core_gene_entrez_ids = character(),
    core_gene_symbols = character(),
    stringsAsFactors = FALSE
  )
}

run_enrichment_gsea_analysis <- function(input_obj, p) {
  required_packages <- c(
    "clusterProfiler", "fgsea", "AnnotationDbi",
    "org.Hs.eg.db", "org.Mm.eg.db", "GO.db"
  )
  missing_packages <- required_packages[
    !vapply(required_packages, requireNamespace, logical(1), quietly = TRUE)
  ]
  if (length(missing_packages) > 0L) {
    stop("Ranked enrichment runtime dependencies are unavailable.")
  }
  if (!inherits(input_obj, "Seurat")) {
    enrichment_gsea_input_error("Loaded object is not a Seurat object.")
  }

  # Work on a local copy only. Restore its assay and identities as an additional
  # safeguard even though this function never assigns the copy back to global_obj.
  obj <- input_obj
  original_assay <- DefaultAssay(obj)
  original_idents <- Idents(obj)
  on.exit({
    try(DefaultAssay(obj) <- original_assay, silent = TRUE)
    try(Idents(obj) <- original_idents, silent = TRUE)
  }, add = TRUE)

  if (!(p$assay %in% Assays(obj))) {
    enrichment_gsea_input_error("The selected assay is not available on this object.")
  }
  DefaultAssay(obj) <- p$assay
  if (identical(p$group_by, "seurat_clusters")) {
    if (!("seurat_clusters" %in% colnames(obj@meta.data))) {
      enrichment_gsea_input_error("Clustering results are required before enrichment.")
    }
    Idents(obj) <- obj$seurat_clusters
  }

  identities <- as.character(Idents(obj))
  observed_groups <- unique(identities[!is.na(identities)])
  if (length(observed_groups) < 2L || !(p$target_group %in% observed_groups)) {
    enrichment_gsea_input_error("The selected comparison group is not available.")
  }
  target_count <- sum(identities == p$target_group, na.rm = TRUE)
  reference_count <- sum(identities != p$target_group & !is.na(identities))
  if (target_count < 3L || reference_count < 3L) {
    enrichment_gsea_input_error("Both sides of the comparison require at least three cells.")
  }

  # This operation is read-only not only with respect to the Seurat object but also
  # with respect to the shared process's random-number stream. Save and restore the
  # caller's RNG state around deterministic sampling and tie ordering.
  rng_state_existed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  rng_state_before <- if (rng_state_existed) {
    get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  } else {
    NULL
  }
  on.exit({
    if (rng_state_existed) {
      assign(".Random.seed", rng_state_before, envir = .GlobalEnv)
    } else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) {
      rm(".Random.seed", envir = .GlobalEnv)
    }
  }, add = TRUE)
  set.seed(p$random_seed)
  marker_warned <- FALSE
  markers <- withCallingHandlers(
    Seurat::FindMarkers(
      obj,
      ident.1 = p$target_group,
      ident.2 = NULL,
      assay = p$assay,
      only.pos = FALSE,
      min.pct = 0,
      logfc.threshold = 0,
      test.use = "wilcox",
      max.cells.per.ident = p$max_cells_per_ident,
      random.seed = p$random_seed,
      verbose = FALSE
    ),
    warning = function(w) {
      marker_warned <<- TRUE
      invokeRestart("muffleWarning")
    }
  )
  markers <- as.data.frame(markers)
  if (!("gene" %in% colnames(markers))) markers$gene <- rownames(markers)
  score_column <- if ("avg_log2FC" %in% colnames(markers)) {
    "avg_log2FC"
  } else if ("avg_logFC" %in% colnames(markers)) {
    "avg_logFC"
  } else {
    stop("The marker ranking did not contain a supported fold-change column.")
  }

  gene_symbols <- unique(as.character(markers$gene))
  gene_symbols <- gene_symbols[!is.na(gene_symbols) & nzchar(gene_symbols)]
  input_gene_count <- length(gene_symbols)
  org_db <- if (identical(p$species, "human")) {
    org.Hs.eg.db::org.Hs.eg.db
  } else {
    org.Mm.eg.db::org.Mm.eg.db
  }
  organism_package <- if (identical(p$species, "human")) "org.Hs.eg.db" else "org.Mm.eg.db"

  mapped_ids <- if (length(gene_symbols) == 0L) {
    stats::setNames(character(), character())
  } else {
    suppressMessages(AnnotationDbi::mapIds(
      org_db,
      keys = gene_symbols,
      keytype = "SYMBOL",
      column = "ENTREZID",
      multiVals = "first"
    ))
  }
  rank_frame <- data.frame(
    symbol = as.character(markers$gene),
    entrez_id = unname(as.character(mapped_ids[as.character(markers$gene)])),
    score = suppressWarnings(as.numeric(markers[[score_column]])),
    stringsAsFactors = FALSE
  )
  rank_frame <- rank_frame[
    !is.na(rank_frame$entrez_id) & nzchar(rank_frame$entrez_id) &
      is.finite(rank_frame$score),
    , drop = FALSE
  ]
  if (nrow(rank_frame) > 0L) {
    # SYMBOL-to-ENTREZ mapping can be many-to-one. Keep one deterministic score per
    # ENTREZ id: greatest absolute effect, then positive effect, then symbol name.
    rank_frame <- rank_frame[order(
      rank_frame$entrez_id, -abs(rank_frame$score), -rank_frame$score, rank_frame$symbol
    ), , drop = FALSE]
    rank_frame <- rank_frame[!duplicated(rank_frame$entrez_id), , drop = FALSE]
  }
  # GSEA requires a total ordering. Fold-change ties are common in sparse data, so
  # use the recorded seed for a deterministic tie order instead of inheriting an
  # arbitrary identifier or input-row order.
  if (nrow(rank_frame) > 0L) {
    set.seed(p$random_seed)
    rank_frame$tie_break <- stats::runif(nrow(rank_frame))
    rank_frame <- rank_frame[order(
      -rank_frame$score, rank_frame$tie_break, rank_frame$entrez_id
    ), , drop = FALSE]
  }
  gene_list <- stats::setNames(rank_frame$score, rank_frame$entrez_id)
  mapped_gene_count <- length(gene_list)
  mapping_rate <- if (input_gene_count > 0L) mapped_gene_count / input_gene_count else 0

  safe_warnings <- character()
  if (isTRUE(marker_warned)) {
    safe_warnings <- c(safe_warnings, "Some genes could not be included in the marker ranking.")
  }
  if (mapped_gene_count < input_gene_count) {
    safe_warnings <- c(safe_warnings, "Some ranked genes could not be mapped to Entrez identifiers.")
  }
  if (length(gene_list) > 1L && anyDuplicated(unname(gene_list)) > 0L) {
    safe_warnings <- c(safe_warnings, "The ranking contains tied scores; the recorded random seed was used.")
  }

  result_table <- empty_enrichment_gsea_table()
  if (length(gene_list) >= p$min_gene_set_size) {
    gsea_warned <- FALSE
    gsea_error <- NULL
    gsea_result <- tryCatch(
      withCallingHandlers(
        clusterProfiler::gseGO(
          geneList = gene_list,
          ont = "BP",
          OrgDb = org_db,
          keyType = "ENTREZID",
          exponent = 1,
          minGSSize = p$min_gene_set_size,
          maxGSSize = p$max_gene_set_size,
          eps = 1e-10,
          pvalueCutoff = 1,
          pAdjustMethod = "BH",
          verbose = FALSE,
          seed = TRUE,
          by = "fgsea"
        ),
        warning = function(w) {
          gsea_warned <<- TRUE
          invokeRestart("muffleWarning")
        }
      ),
      error = function(e) {
        gsea_error <<- e
        NULL
      }
    )
    if (!is.null(gsea_error)) {
      no_sets <- grepl(
        "no gene|no term|no pathway|gene set.*size|not enough",
        conditionMessage(gsea_error), ignore.case = TRUE, perl = TRUE
      )
      if (!no_sets) stop(gsea_error)
      safe_warnings <- c(safe_warnings, "No pathways could be tested with this ranking and size range.")
    }
    if (isTRUE(gsea_warned)) {
      safe_warnings <- c(
        safe_warnings,
        "The enrichment library reported that some ranked genes or pathways could not be tested."
      )
    }

    gsea_frame <- if (is.null(gsea_result)) data.frame() else as.data.frame(gsea_result)
    expected_columns <- c(
      "ID", "Description", "NES", "pvalue", "p.adjust", "setSize", "core_enrichment"
    )
    if (nrow(gsea_frame) > 0L && !all(expected_columns %in% colnames(gsea_frame))) {
      stop("The enrichment result did not contain the expected columns.")
    }
    if (nrow(gsea_frame) > 0L) {
      all_core_ids <- unique(unlist(strsplit(
        as.character(gsea_frame$core_enrichment), "/", fixed = TRUE
      )))
      all_core_ids <- all_core_ids[!is.na(all_core_ids) & nzchar(all_core_ids)]
      core_symbols <- if (length(all_core_ids) == 0L) {
        stats::setNames(character(), character())
      } else {
        suppressMessages(AnnotationDbi::mapIds(
          org_db,
          keys = all_core_ids,
          keytype = "ENTREZID",
          column = "SYMBOL",
          multiVals = "first"
        ))
      }
      core_symbol_strings <- vapply(as.character(gsea_frame$core_enrichment), function(value) {
        ids <- strsplit(value, "/", fixed = TRUE)[[1]]
        symbols <- unique(unname(as.character(core_symbols[ids])))
        symbols <- symbols[!is.na(symbols) & nzchar(symbols)]
        paste(symbols, collapse = "/")
      }, character(1))
      result_table <- data.frame(
        pathway_id = as.character(gsea_frame$ID),
        pathway_name = as.character(gsea_frame$Description),
        normalized_enrichment_score = as.numeric(gsea_frame$NES),
        p_value = as.numeric(gsea_frame$pvalue),
        adjusted_p_value = as.numeric(gsea_frame$p.adjust),
        set_size = as.integer(gsea_frame$setSize),
        core_gene_entrez_ids = as.character(gsea_frame$core_enrichment),
        core_gene_symbols = core_symbol_strings,
        stringsAsFactors = FALSE
      )
      result_table <- result_table[order(
        ifelse(is.finite(result_table$adjusted_p_value), result_table$adjusted_p_value, Inf),
        -abs(result_table$normalized_enrichment_score),
        result_table$pathway_id
      ), , drop = FALSE]
      rownames(result_table) <- NULL
    }
  } else {
    safe_warnings <- c(safe_warnings, "Too few genes mapped to test pathways in the selected size range.")
  }

  significant <- is.finite(result_table$adjusted_p_value) &
    result_table$adjusted_p_value <= p$adjusted_p_value_cutoff
  if (nrow(result_table) == 0L) {
    safe_warnings <- c(safe_warnings, "No pathways were returned for this comparison.")
  } else if (!any(significant)) {
    safe_warnings <- c(safe_warnings, "No pathways passed the adjusted p-value cutoff.")
  }
  safe_warnings <- unique(vapply(
    safe_warnings, enrichment_gsea_safe_summary_string, character(1), max_chars = 200L
  ))
  safe_warnings <- as.list(safe_warnings[nzchar(safe_warnings)])

  top_count <- min(nrow(result_table), p$top_pathways)
  top_pathways <- if (top_count == 0L) list() else lapply(seq_len(top_count), function(i) {
    nes <- as.numeric(result_table$normalized_enrichment_score[i])
    list(
      pathway_id = enrichment_gsea_safe_summary_string(result_table$pathway_id[i], 80L),
      pathway_name = enrichment_gsea_safe_summary_string(result_table$pathway_name[i], 240L),
      normalized_enrichment_score = if (is.finite(nes)) round(nes, 6) else NULL,
      p_value = if (is.finite(result_table$p_value[i])) as.numeric(result_table$p_value[i]) else NULL,
      adjusted_p_value = if (is.finite(result_table$adjusted_p_value[i])) {
        as.numeric(result_table$adjusted_p_value[i])
      } else NULL,
      set_size = as.integer(result_table$set_size[i]),
      significant = isTRUE(significant[i]),
      direction = if (!is.finite(nes) || nes == 0) {
        "neutral"
      } else if (nes > 0) {
        "positive"
      } else {
        "negative"
      }
    )
  })

  list(
    table = result_table,
    summary = list(
      method = "gsea",
      comparison = list(
        target_group = enrichment_gsea_safe_summary_string(p$target_group, 128L),
        reference = "rest"
      ),
      group_by = p$group_by,
      assay = p$assay,
      species = p$species,
      gene_set_collection = p$gene_set_collection,
      rank_metric = score_column,
      input_gene_count = as.integer(input_gene_count),
      mapped_gene_count = as.integer(mapped_gene_count),
      mapping_rate = round(as.numeric(mapping_rate), 6),
      tested_pathway_count = as.integer(nrow(result_table)),
      significant_pathway_count = as.integer(sum(significant)),
      package_versions = list(
        r = as.character(getRversion()),
        seurat = as.character(utils::packageVersion("Seurat")),
        annotation_dbi = as.character(utils::packageVersion("AnnotationDbi")),
        go_db = as.character(utils::packageVersion("GO.db")),
        cluster_profiler = as.character(utils::packageVersion("clusterProfiler")),
        fgsea = as.character(utils::packageVersion("fgsea")),
        organism_db = paste0(organism_package, " ", as.character(utils::packageVersion(organism_package)))
      ),
      top_pathways = top_pathways,
      warnings = safe_warnings
    )
  )
}
