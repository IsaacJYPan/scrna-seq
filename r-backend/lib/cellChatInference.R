# -- Durable CellChat v1 helpers ------------------------------------------------------
#
# This is deliberately a fixed single-context CellChat workflow. It receives only a
# narrow server-validated grouping choice and bounded compute controls; it never accepts
# arbitrary metadata columns, code, paths, or a condition/comparison definition. Group
# labels are converted to opaque presentation labels before CellChat sees them and before
# anything is written to a durable result, so raw metadata labels do not escape through
# the artifact summary or the private result table.
CELLCHAT_INFERENCE_MAX_RESULT_ROWS <- 50000L
# CellChat's current reviewed human/mouse databases expose roughly 1,500 genes.
# Keep a small amount of headroom for a reviewed database update, but fail closed
# before a changed resource can silently turn the singleton R service into an
# unbounded feature-matrix worker.
CELLCHAT_INFERENCE_MAX_SIGNALING_FEATURES <- 2000L
# CellChat can densify parts of the selected expression matrix internally. This
# is an *estimated dense* allocation budget, not a claim that the Seurat layer
# itself is dense: 128 MiB accommodates every current reviewed database at the
# supported 10,000-cell cap while reserving room for the source object and R.
CELLCHAT_INFERENCE_MAX_DENSE_INPUT_BYTES <- 128 * 1024^2
# Owner-local group mapping reads one selected metadata/identity vector and
# returns at most 32 aggregate rows. It does not duplicate the expression
# matrix, so it has a separate, metadata-only admission ceiling instead of the
# generic synchronous full-object compute limit.
CELLCHAT_INFERENCE_MAX_GROUP_MAP_CELLS <- 250000L

cellchat_inference_safe_string <- function(value, max_chars = 160L) {
  if (is.null(value) || length(value) != 1L || is.na(value)) return("")
  clean <- gsub("[[:cntrl:]]", " ", enc2utf8(as.character(value)), perl = TRUE)
  clean <- gsub("[^A-Za-z0-9 ._:+-]", " ", clean, perl = TRUE)
  clean <- gsub("[[:space:]]+", " ", clean, perl = TRUE)
  substr(trimws(clean), 1L, max_chars)
}

cellchat_inference_input_error <- function(message, code = "CELLCHAT_INPUT_INVALID") {
  stop(structure(
    list(message = message, call = NULL, code = code),
    class = c("cellchat_inference_input_error", "error", "condition")
  ))
}

normalize_cellchat_inference_params <- function(p) {
  allowed <- c(
    "groupBy", "assay", "species", "databaseCategory", "analysisIntent",
    "minCellsPerGroup", "maxCellsPerGroup", "maxTotalCells", "pValueCutoff",
    "topInteractions", "topPathways", "randomSeed"
  )
  if (!is.list(p) || is.null(names(p)) || anyDuplicated(names(p)) ||
      !setequal(names(p), allowed) || length(names(p)) != length(allowed)) {
    cellchat_inference_input_error("Invalid cell communication parameters.")
  }

  scalar_choice <- function(value, choices) {
    is.character(value) && length(value) == 1L && !is.na(value) && value %in% choices
  }
  scalar_number <- function(value, lower, upper, integer = FALSE) {
    if (!is.numeric(value) || length(value) != 1L || is.na(value) || !is.finite(value) ||
        value < lower || value > upper || (integer && value != floor(value))) {
      cellchat_inference_input_error("Invalid cell communication parameters.")
    }
    if (integer) as.integer(value) else as.numeric(value)
  }

  if (!scalar_choice(p$groupBy, c("seurat_clusters", "ident")) ||
      !scalar_choice(p$assay, c("RNA")) ||
      !scalar_choice(p$species, c("human", "mouse")) ||
      !scalar_choice(p$databaseCategory, c(
        "all", "secreted_signaling", "ecm_receptor", "cell_cell_contact"
      )) ||
      !scalar_choice(p$analysisIntent, c("single_context"))) {
    cellchat_inference_input_error("Invalid cell communication parameters.")
  }

  min_cells_per_group <- scalar_number(p$minCellsPerGroup, 5, 200, integer = TRUE)
  max_cells_per_group <- scalar_number(p$maxCellsPerGroup, 100, 10000, integer = TRUE)
  max_total_cells <- scalar_number(p$maxTotalCells, 1000, 10000, integer = TRUE)
  if (max_cells_per_group < min_cells_per_group || max_total_cells < (2L * min_cells_per_group)) {
    cellchat_inference_input_error("Invalid cell communication parameters.")
  }

  list(
    group_by = p$groupBy,
    assay = p$assay,
    species = p$species,
    database_category = p$databaseCategory,
    analysis_intent = p$analysisIntent,
    min_cells_per_group = min_cells_per_group,
    max_cells_per_group = max_cells_per_group,
    max_total_cells = max_total_cells,
    p_value_cutoff = scalar_number(p$pValueCutoff, 0.000001, 0.1),
    top_interactions = scalar_number(p$topInteractions, 5, 100, integer = TRUE),
    top_pathways = scalar_number(p$topPathways, 5, 100, integer = TRUE),
    random_seed = scalar_number(p$randomSeed, 0, 2147483647, integer = TRUE)
  )
}

# A result artifact intentionally contains only opaque `Group N` identifiers so
# project-visible metadata never republishes an owner's raw live-R labels. The
# owner UI can request this short-lived key from its already-attached private R
# object to interpret the result. It accepts no arbitrary metadata column.
cellchat_inference_owner_group_key <- function(input_obj, group_by) {
  if (!inherits(input_obj, "Seurat")) {
    cellchat_inference_input_error("Loaded object is not a Seurat object.")
  }
  if (!(group_by %in% c("seurat_clusters", "ident"))) {
    cellchat_inference_input_error("Invalid cell communication grouping.")
  }
  values <- if (identical(group_by, "seurat_clusters")) {
    if (!("seurat_clusters" %in% colnames(input_obj@meta.data))) {
      cellchat_inference_input_error("Clustering results are required for cell communication inference.")
    }
    as.character(input_obj@meta.data$seurat_clusters)
  } else {
    as.character(Idents(input_obj))
  }
  populated <- !is.na(values) & nzchar(trimws(values))
  groups <- sort(unique(values[populated]))
  if (length(groups) < 2L || length(groups) > 32L) {
    cellchat_inference_input_error("CellChat requires from two to 32 populated groups.")
  }
  list(
    group_by = group_by,
    groups = lapply(seq_along(groups), function(index) list(
      group = sprintf("Group %d", index),
      # This label is returned only from the owner-scoped, attached live R
      # session. It is never copied to an artifact, receipt, job log, or CSV.
      label = bounded_public_labels(groups[[index]], 160L),
      input_cells = as.integer(sum(populated & values == groups[[index]]))
    ))
  )
}

cellchat_inference_group_map_admission <- function(input_obj) {
  n_cells <- suppressWarnings(as.numeric(ncol(input_obj)))
  if (length(n_cells) != 1L || !is.finite(n_cells) || n_cells < 1L ||
      n_cells != floor(n_cells)) {
    cellchat_inference_input_error("CellChat group mapping is unavailable.")
  }
  if (n_cells > CELLCHAT_INFERENCE_MAX_GROUP_MAP_CELLS) {
    cellchat_inference_input_error("CellChat group mapping exceeds the supported metadata capacity.")
  }
  list(n_cells = as.integer(n_cells))
}

cellchat_inference_database_category_label <- function(category) {
  switch(
    category,
    all = NULL,
    secreted_signaling = "Secreted Signaling",
    ecm_receptor = "ECM-Receptor",
    cell_cell_contact = "Cell-Cell Contact",
    NULL
  )
}

cellchat_inference_database <- function(p) {
  db <- if (identical(p$species, "human")) {
    CellChat::CellChatDB.human
  } else {
    CellChat::CellChatDB.mouse
  }
  category_label <- cellchat_inference_database_category_label(p$database_category)
  if (!is.null(category_label)) {
    db <- CellChat::subsetDB(db, search = category_label)
  }
  if (!is.list(db) || is.null(db$interaction) || !is.data.frame(db$interaction) ||
      nrow(db$interaction) < 1L) {
    stop("The selected CellChat database category is unavailable.")
  }
  db
}

empty_cellchat_inference_table <- function() {
  data.frame(
    source_group = character(),
    target_group = character(),
    interaction_name = character(),
    pathway_name = character(),
    ligand = character(),
    receptor = character(),
    probability = numeric(),
    p_value = numeric(),
    database_annotation = character(),
    requested_database_category = character(),
    stringsAsFactors = FALSE
  )
}

cellchat_inference_frame_column <- function(frame, candidates) {
  selected <- candidates[candidates %in% colnames(frame)]
  if (length(selected) == 0L) return(rep(NA_character_, nrow(frame)))
  frame[[selected[[1]]]]
}

cellchat_inference_display_groups <- function(internal_labels, display_by_internal) {
  values <- unname(display_by_internal[as.character(internal_labels)])
  values[is.na(values) | !nzchar(values)] <- "Group unavailable"
  vapply(values, cellchat_inference_safe_string, character(1), max_chars = 80L)
}

# Keep cell IDs attached to the inferred groups while constructing the minimal
# metadata frame so CellChat never receives a positionally shifted grouping.
cellchat_inference_group_metadata <- function(selected_cells, group_values,
                                               raw_to_internal, internal_levels) {
  if (anyDuplicated(selected_cells) ||
      !all(selected_cells %in% names(group_values))) {
    cellchat_inference_input_error("The requested grouping could not be prepared safely.")
  }
  selected_internal_by_cell <- stats::setNames(
    unname(raw_to_internal[group_values[selected_cells]]),
    selected_cells
  )
  if (any(is.na(selected_internal_by_cell)) ||
      anyDuplicated(names(selected_internal_by_cell))) {
    cellchat_inference_input_error("The requested grouping could not be prepared safely.")
  }
  selected_internal_groups <- unname(selected_internal_by_cell[selected_cells])
  if (length(selected_internal_groups) != length(selected_cells) || any(is.na(selected_internal_groups))) {
    cellchat_inference_input_error("The requested grouping could not be prepared safely.")
  }
  data.frame(
    .traceomics_cellchat_group = factor(selected_internal_groups, levels = internal_levels),
    row.names = selected_cells,
    stringsAsFactors = FALSE
  )
}

cellchat_inference_signaling_features <- function(input_obj, assay, database) {
  available_features <- tryCatch(rownames(input_obj[[assay]]), error = function(e) NULL)
  database_features <- tryCatch(
    unique(as.character(CellChat::extractGene(database))),
    error = function(e) character()
  )
  database_features <- database_features[
    !is.na(database_features) & nzchar(database_features)
  ]
  if (is.null(available_features) || length(available_features) == 0L) {
    cellchat_inference_input_error("The normalized RNA assay is not suitable for cell communication inference.", "CELLCHAT_NORMALIZED_DATA_REQUIRED")
  }
  selected <- database_features[database_features %in% available_features]
  if (length(selected) < 5L) {
    cellchat_inference_input_error("Too few signaling genes overlap the selected CellChat database.", "CELLCHAT_DATABASE_OVERLAP_LOW")
  }
  if (length(selected) > CELLCHAT_INFERENCE_MAX_SIGNALING_FEATURES) {
    cellchat_inference_input_error("The selected CellChat database exceeds the supported signaling-feature capacity.")
  }
  selected
}

cellchat_inference_input_matrix_admission <- function(n_features, n_cells) {
  if (length(n_features) != 1L || length(n_cells) != 1L ||
      !is.finite(n_features) || !is.finite(n_cells) ||
      n_features < 1L || n_cells < 1L ||
      n_features != floor(n_features) || n_cells != floor(n_cells)) {
    cellchat_inference_input_error("The selected CellChat input is invalid.")
  }
  if (n_features > CELLCHAT_INFERENCE_MAX_SIGNALING_FEATURES) {
    cellchat_inference_input_error("The selected CellChat database exceeds the supported signaling-feature capacity.")
  }
  estimated_dense_bytes <- as.numeric(n_features) * as.numeric(n_cells) * 8
  if (!is.finite(estimated_dense_bytes) ||
      estimated_dense_bytes > CELLCHAT_INFERENCE_MAX_DENSE_INPUT_BYTES) {
    cellchat_inference_input_error("The selected CellChat expression matrix exceeds the supported compute capacity.")
  }
  list(
    signaling_features = as.integer(n_features),
    selected_cells = as.integer(n_cells),
    estimated_dense_bytes = estimated_dense_bytes
  )
}

# Never call Seurat::subset() here. A cell-only subset can clone every assay,
# reduction, and feature in a multiomic source object before CellChat has a
# chance to narrow to its signaling genes. Build only the minimal group metadata
# plus selected RNA signaling-gene layer that CellChat needs.
cellchat_inference_prepare_input <- function(input_obj, assay, selected_cells,
                                             group_values, raw_to_internal,
                                             internal_levels, database) {
  metadata <- cellchat_inference_group_metadata(
    selected_cells, group_values, raw_to_internal, internal_levels
  )
  signaling_features <- cellchat_inference_signaling_features(input_obj, assay, database)
  admission <- cellchat_inference_input_matrix_admission(
    length(signaling_features), length(selected_cells)
  )
  data_input <- tryCatch({
    layer <- Seurat::GetAssayData(input_obj, assay = assay, layer = "data")
    layer[signaling_features, selected_cells, drop = FALSE]
  }, error = function(e) {
    cellchat_inference_input_error("Normalized RNA data is required for cell communication inference.", "CELLCHAT_NORMALIZED_DATA_REQUIRED")
  })
  if (is.null(data_input) || nrow(data_input) < 5L ||
      ncol(data_input) != length(selected_cells) ||
      !identical(colnames(data_input), rownames(metadata))) {
    cellchat_inference_input_error("The normalized RNA assay is not suitable for cell communication inference.", "CELLCHAT_NORMALIZED_DATA_REQUIRED")
  }
  list(data = data_input, metadata = metadata, admission = admission)
}

cellchat_inference_interaction_table <- function(frame, display_by_internal, p) {
  if (!is.data.frame(frame) || nrow(frame) == 0L) return(empty_cellchat_inference_table())

  probability <- suppressWarnings(as.numeric(cellchat_inference_frame_column(frame, c("prob", "probability"))))
  p_value <- suppressWarnings(as.numeric(cellchat_inference_frame_column(frame, c("pval", "p_value"))))
  table_out <- data.frame(
    source_group = cellchat_inference_display_groups(
      cellchat_inference_frame_column(frame, c("source")), display_by_internal
    ),
    target_group = cellchat_inference_display_groups(
      cellchat_inference_frame_column(frame, c("target")), display_by_internal
    ),
    interaction_name = vapply(
      cellchat_inference_frame_column(frame, c("interaction_name", "interaction")),
      cellchat_inference_safe_string, character(1), max_chars = 160L
    ),
    pathway_name = vapply(
      cellchat_inference_frame_column(frame, c("pathway_name", "pathway")),
      cellchat_inference_safe_string, character(1), max_chars = 120L
    ),
    ligand = vapply(
      cellchat_inference_frame_column(frame, c("ligand")),
      cellchat_inference_safe_string, character(1), max_chars = 120L
    ),
    receptor = vapply(
      cellchat_inference_frame_column(frame, c("receptor")),
      cellchat_inference_safe_string, character(1), max_chars = 120L
    ),
    probability = probability,
    p_value = p_value,
    database_annotation = vapply(
      cellchat_inference_frame_column(frame, c("annotation", "category")),
      cellchat_inference_safe_string, character(1), max_chars = 80L
    ),
    requested_database_category = rep(
      cellchat_inference_safe_string(p$database_category, 80L),
      nrow(frame)
    ),
    stringsAsFactors = FALSE
  )
  table_out$database_annotation[!nzchar(table_out$database_annotation)] <- "unavailable"
  keep <- is.finite(table_out$probability) & table_out$probability > 0 &
    is.finite(table_out$p_value) & table_out$p_value >= 0 &
    table_out$p_value <= p$p_value_cutoff
  table_out <- table_out[keep, , drop = FALSE]
  if (nrow(table_out) > 0L) {
    table_out <- table_out[order(
      -table_out$probability, table_out$p_value, table_out$source_group,
      table_out$target_group, table_out$interaction_name
    ), , drop = FALSE]
    rownames(table_out) <- NULL
  }
  table_out
}

cellchat_inference_pathway_table <- function(frame, display_by_internal, p) {
  if (!is.data.frame(frame) || nrow(frame) == 0L) {
    return(data.frame(
      source = character(), target = character(), pathway = character(),
      probability = numeric(), p_value = numeric(), stringsAsFactors = FALSE
    ))
  }
  probability <- suppressWarnings(as.numeric(cellchat_inference_frame_column(frame, c("prob", "probability"))))
  p_value <- suppressWarnings(as.numeric(cellchat_inference_frame_column(frame, c("pval", "p_value"))))
  table_out <- data.frame(
    source = cellchat_inference_display_groups(
      cellchat_inference_frame_column(frame, c("source")), display_by_internal
    ),
    target = cellchat_inference_display_groups(
      cellchat_inference_frame_column(frame, c("target")), display_by_internal
    ),
    pathway = vapply(
      cellchat_inference_frame_column(frame, c("pathway_name", "pathway", "signaling")),
      cellchat_inference_safe_string, character(1), max_chars = 120L
    ),
    probability = probability,
    p_value = p_value,
    stringsAsFactors = FALSE
  )
  keep <- is.finite(table_out$probability) & table_out$probability > 0 &
    is.finite(table_out$p_value) & table_out$p_value >= 0 &
    table_out$p_value <= p$p_value_cutoff
  table_out <- table_out[keep, , drop = FALSE]
  if (nrow(table_out) > 0L) {
    table_out <- table_out[order(
      -table_out$probability, table_out$p_value, table_out$source,
      table_out$target, table_out$pathway
    ), , drop = FALSE]
    rownames(table_out) <- NULL
  }
  table_out
}

# `subsetCommunication()` reshapes the complete source x target x ligand/receptor
# array before it can apply the durable CSV cap. The reviewed CellChat v2.1.2
# object keeps that same information in `@net$prob`, `@net$pval`, and
# `@LR$LRsig`. Validate those documented shapes and extract fixed-size slices so
# a highly connected result never first becomes a multi-million-row data frame.
CELLCHAT_INFERENCE_EXTRACTION_BLOCK_PAIRS <- 32L

empty_cellchat_inference_raw_interaction_frame <- function() {
  data.frame(
    source = character(),
    target = character(),
    interaction_name = character(),
    pathway_name = character(),
    ligand = character(),
    receptor = character(),
    annotation = character(),
    prob = numeric(),
    pval = numeric(),
    .source_index = integer(),
    .target_index = integer(),
    .pair_index = integer(),
    .source_rank = integer(),
    .target_rank = integer(),
    .interaction_rank = integer(),
    stringsAsFactors = FALSE
  )
}

empty_cellchat_inference_raw_pathway_frame <- function() {
  data.frame(
    source = character(),
    target = character(),
    pathway_name = character(),
    prob = numeric(),
    pval = numeric(),
    .source_index = integer(),
    .target_index = integer(),
    .pathway_index = integer(),
    .source_rank = integer(),
    .target_rank = integer(),
    .pathway_rank = integer(),
    stringsAsFactors = FALSE
  )
}

cellchat_inference_net_arrays <- function(net) {
  if (!is.list(net) || is.null(net$prob) || is.null(net$pval) ||
      !is.array(net$prob) || !is.array(net$pval) ||
      !is.numeric(net$prob) || !is.numeric(net$pval)) {
    stop("CellChat returned an invalid communication network.")
  }
  dimensions <- dim(net$prob)
  if (length(dimensions) != 3L || any(dimensions < 1L) ||
      !identical(dimensions, dim(net$pval))) {
    stop("CellChat returned an invalid communication network.")
  }
  labels <- dimnames(net$prob)
  if (is.null(labels) || length(labels) != 3L ||
      any(vapply(labels, is.null, logical(1)))) {
    stop("CellChat returned an invalid communication network.")
  }
  source_labels <- as.character(labels[[1]])
  target_labels <- as.character(labels[[2]])
  pair_labels <- as.character(labels[[3]])
  labels_are_valid <- function(values, expected_length) {
    length(values) == expected_length &&
      !any(is.na(values) | !nzchar(values)) &&
      !anyDuplicated(values)
  }
  if (!labels_are_valid(source_labels, dimensions[[1]]) ||
      !labels_are_valid(target_labels, dimensions[[2]]) ||
      !labels_are_valid(pair_labels, dimensions[[3]])) {
    stop("CellChat returned an invalid communication network.")
  }
  list(
    prob = net$prob,
    pval = net$pval,
    source_labels = source_labels,
    target_labels = target_labels,
    pair_labels = pair_labels,
    dimensions = dimensions
  )
}

cellchat_inference_pair_metadata <- function(lr, pair_labels) {
  result <- data.frame(
    pathway_name = rep(NA_character_, length(pair_labels)),
    ligand = rep(NA_character_, length(pair_labels)),
    receptor = rep(NA_character_, length(pair_labels)),
    annotation = rep(NA_character_, length(pair_labels)),
    stringsAsFactors = FALSE
  )
  if (!is.data.frame(lr) || nrow(lr) == 0L) return(result)

  lr <- as.data.frame(lr, stringsAsFactors = FALSE)
  rows <- match(pair_labels, rownames(lr))
  if ("interaction_name" %in% colnames(lr)) {
    missing_rows <- is.na(rows)
    rows[missing_rows] <- match(
      pair_labels[missing_rows], as.character(lr$interaction_name)
    )
  }
  copy_column <- function(destination, candidates) {
    selected <- candidates[candidates %in% colnames(lr)]
    if (length(selected) > 0L) {
      result[[destination]] <<- as.character(lr[[selected[[1]]]][rows])
    }
  }
  copy_column("pathway_name", c("pathway_name", "pathway"))
  copy_column("ligand", c("ligand"))
  copy_column("receptor", c("receptor"))
  copy_column("annotation", c("annotation", "category"))
  result
}

cellchat_inference_string_ranks <- function(values, max_chars) {
  safe_values <- vapply(
    values, cellchat_inference_safe_string, character(1), max_chars = max_chars
  )
  match(safe_values, sort(unique(safe_values)))
}

cellchat_inference_group_ranks <- function(internal_labels, display_by_internal) {
  display_values <- unname(display_by_internal[as.character(internal_labels)])
  display_values[is.na(display_values) | !nzchar(display_values)] <- "Group unavailable"
  cellchat_inference_string_ranks(display_values, 80L)
}

cellchat_inference_interaction_rank_order <- function(frame, display_by_internal) {
  if (nrow(frame) == 0L) return(integer())
  order(
    -as.numeric(frame$prob), as.numeric(frame$pval),
    as.integer(frame$.source_rank), as.integer(frame$.target_rank),
    as.integer(frame$.interaction_rank),
    as.integer(frame$.source_index), as.integer(frame$.target_index),
    as.integer(frame$.pair_index),
    method = "radix", na.last = TRUE
  )
}

cellchat_inference_pathway_rank_order <- function(frame, display_by_internal) {
  if (nrow(frame) == 0L) return(integer())
  order(
    -as.numeric(frame$prob), as.numeric(frame$pval),
    as.integer(frame$.source_rank), as.integer(frame$.target_rank),
    as.integer(frame$.pathway_rank),
    as.integer(frame$.source_index), as.integer(frame$.target_index),
    as.integer(frame$.pathway_index),
    method = "radix", na.last = TRUE
  )
}

cellchat_inference_keep_ranked_rows <- function(frame, limit, rank_order) {
  ranked <- rank_order(frame)
  frame[ranked[seq_len(min(nrow(frame), limit))], , drop = FALSE]
}

cellchat_inference_rows_strictly_before <- function(frame, worst_row, columns, directions) {
  if (nrow(frame) == 0L) return(logical())
  better <- rep(FALSE, nrow(frame))
  tied <- rep(TRUE, nrow(frame))
  for (index in seq_along(columns)) {
    values <- frame[[columns[[index]]]]
    threshold <- worst_row[[columns[[index]]]][[1L]]
    comparison <- if (identical(directions[[index]], "descending")) {
      values > threshold
    } else {
      values < threshold
    }
    better <- better | (tied & comparison)
    tied <- tied & (values == threshold)
  }
  better
}

# This is the `subsetCommunication(slot.name = "net")` filter expressed over
# fixed pair blocks. The strict p-value comparison intentionally matches
# CellChat's `prob[pval >= thresh] <- 0` behavior, rather than broadening the
# configured cutoff by one boundary value.
cellchat_inference_bounded_interaction_rows <- function(net_arrays, pair_metadata, p,
                                                        display_by_internal,
                                                        limit = CELLCHAT_INFERENCE_MAX_RESULT_ROWS) {
  if (!is.list(net_arrays) || !is.data.frame(pair_metadata) ||
      nrow(pair_metadata) != length(net_arrays$pair_labels) ||
      length(limit) != 1L || !is.finite(limit) || limit < 1L || limit != floor(limit)) {
    stop("CellChat result extraction is unavailable.")
  }
  accumulator <- empty_cellchat_inference_raw_interaction_frame()
  candidate_count <- 0L
  pair_count <- length(net_arrays$pair_labels)
  source_ranks <- cellchat_inference_group_ranks(
    net_arrays$source_labels, display_by_internal
  )
  target_ranks <- cellchat_inference_group_ranks(
    net_arrays$target_labels, display_by_internal
  )
  interaction_ranks <- cellchat_inference_string_ranks(
    net_arrays$pair_labels, 160L
  )
  accumulator_is_ranked <- FALSE
  block_starts <- seq.int(1L, pair_count, by = CELLCHAT_INFERENCE_EXTRACTION_BLOCK_PAIRS)
  for (block_start in block_starts) {
    block_end <- min(pair_count, block_start + CELLCHAT_INFERENCE_EXTRACTION_BLOCK_PAIRS - 1L)
    pair_indices <- seq.int(block_start, block_end)
    probability_block <- net_arrays$prob[, , pair_indices, drop = FALSE]
    p_value_block <- net_arrays$pval[, , pair_indices, drop = FALSE]
    eligible <- is.finite(probability_block) & probability_block > 0 &
      is.finite(p_value_block) & p_value_block >= 0 &
      p_value_block < p$p_value_cutoff
    candidate_count <- candidate_count + as.integer(sum(eligible))
    coordinates <- which(eligible, arr.ind = TRUE)
    if (nrow(coordinates) == 0L) next

    selected_pair_indices <- pair_indices[coordinates[, 3L]]
    metadata <- pair_metadata[selected_pair_indices, , drop = FALSE]
    block <- data.frame(
      source = net_arrays$source_labels[coordinates[, 1L]],
      target = net_arrays$target_labels[coordinates[, 2L]],
      interaction_name = net_arrays$pair_labels[selected_pair_indices],
      pathway_name = as.character(metadata$pathway_name),
      ligand = as.character(metadata$ligand),
      receptor = as.character(metadata$receptor),
      annotation = as.character(metadata$annotation),
      prob = as.numeric(probability_block[coordinates]),
      pval = as.numeric(p_value_block[coordinates]),
      .source_index = as.integer(coordinates[, 1L]),
      .target_index = as.integer(coordinates[, 2L]),
      .pair_index = as.integer(selected_pair_indices),
      .source_rank = as.integer(source_ranks[coordinates[, 1L]]),
      .target_rank = as.integer(target_ranks[coordinates[, 2L]]),
      .interaction_rank = as.integer(interaction_ranks[selected_pair_indices]),
      stringsAsFactors = FALSE
    )
    if (accumulator_is_ranked) {
      better <- cellchat_inference_rows_strictly_before(
        block,
        accumulator[nrow(accumulator), , drop = FALSE],
        c("prob", "pval", ".source_rank", ".target_rank", ".interaction_rank",
          ".source_index", ".target_index", ".pair_index"),
        c("descending", rep("ascending", 7L))
      )
      block <- block[better, , drop = FALSE]
      if (nrow(block) == 0L) next
    }
    accumulator <- rbind(accumulator, block)
    if (nrow(accumulator) >= limit) {
      accumulator <- cellchat_inference_keep_ranked_rows(
        accumulator,
        as.integer(limit),
        function(value) cellchat_inference_interaction_rank_order(value, display_by_internal)
      )
      accumulator_is_ranked <- nrow(accumulator) == limit
    }
  }
  rownames(accumulator) <- NULL
  list(rows = accumulator, candidate_count = candidate_count)
}

# This reproduces the pathway aggregation that `subsetCommunication(slot.name =
# "netP")` performs: sum surviving interaction probabilities and mean their
# p-values for each source/target/pathway combination. It keeps only the bounded
# preview rows because pathway details are not a durable CSV artifact.
cellchat_inference_bounded_pathway_rows <- function(net_arrays, pair_metadata, p,
                                                    display_by_internal,
                                                    limit = p$top_pathways) {
  if (!is.list(net_arrays) || !is.data.frame(pair_metadata) ||
      nrow(pair_metadata) != length(net_arrays$pair_labels) ||
      length(limit) != 1L || !is.finite(limit) || limit < 1L || limit != floor(limit)) {
    stop("CellChat pathway extraction is unavailable.")
  }
  pathway_by_pair <- as.character(pair_metadata$pathway_name)
  pathway_by_pair[is.na(pathway_by_pair) | !nzchar(pathway_by_pair)] <- NA_character_
  pathways <- unique(pathway_by_pair[!is.na(pathway_by_pair)])
  if (length(pathways) == 0L) {
    return(list(rows = empty_cellchat_inference_raw_pathway_frame(), candidate_count = 0))
  }
  pathway_indices <- match(pathway_by_pair, pathways)
  source_count <- net_arrays$dimensions[[1L]]
  target_count <- net_arrays$dimensions[[2L]]
  pathway_count <- length(pathways)
  probability_sum <- array(0, dim = c(source_count, target_count, pathway_count))
  p_value_sum <- array(0, dim = c(source_count, target_count, pathway_count))
  interaction_count <- array(0L, dim = c(source_count, target_count, pathway_count))

  for (pair_index in seq_along(net_arrays$pair_labels)) {
    pathway_index <- pathway_indices[[pair_index]]
    if (is.na(pathway_index)) next
    probability <- matrix(
      net_arrays$prob[, , pair_index], nrow = source_count, ncol = target_count
    )
    p_value <- matrix(
      net_arrays$pval[, , pair_index], nrow = source_count, ncol = target_count
    )
    eligible <- is.finite(probability) & probability > 0 &
      is.finite(p_value) & p_value >= 0 & p_value < p$p_value_cutoff
    if (!any(eligible)) next
    probability[!eligible] <- 0
    p_value[!eligible] <- 0
    probability_sum[, , pathway_index] <-
      probability_sum[, , pathway_index] + probability
    p_value_sum[, , pathway_index] <- p_value_sum[, , pathway_index] + p_value
    interaction_count[, , pathway_index] <-
      interaction_count[, , pathway_index] + eligible
  }

  accumulator <- empty_cellchat_inference_raw_pathway_frame()
  candidate_count <- 0L
  source_ranks <- cellchat_inference_group_ranks(
    net_arrays$source_labels, display_by_internal
  )
  target_ranks <- cellchat_inference_group_ranks(
    net_arrays$target_labels, display_by_internal
  )
  pathway_ranks <- cellchat_inference_string_ranks(pathways, 120L)
  accumulator_is_ranked <- FALSE
  for (pathway_index in seq_along(pathways)) {
    counts <- matrix(
      interaction_count[, , pathway_index], nrow = source_count, ncol = target_count
    )
    probability <- matrix(
      probability_sum[, , pathway_index], nrow = source_count, ncol = target_count
    )
    p_value <- matrix(
      p_value_sum[, , pathway_index], nrow = source_count, ncol = target_count
    )
    eligible <- counts > 0L & is.finite(probability) & probability > 0
    if (!any(eligible)) next
    p_value[eligible] <- p_value[eligible] / counts[eligible]
    eligible <- eligible & is.finite(p_value) & p_value >= 0 & p_value <= p$p_value_cutoff
    coordinates <- which(eligible, arr.ind = TRUE)
    candidate_count <- candidate_count + as.integer(nrow(coordinates))
    if (nrow(coordinates) == 0L) next
    block <- data.frame(
      source = net_arrays$source_labels[coordinates[, 1L]],
      target = net_arrays$target_labels[coordinates[, 2L]],
      pathway_name = rep(pathways[[pathway_index]], nrow(coordinates)),
      prob = as.numeric(probability[coordinates]),
      pval = as.numeric(p_value[coordinates]),
      .source_index = as.integer(coordinates[, 1L]),
      .target_index = as.integer(coordinates[, 2L]),
      .pathway_index = rep(as.integer(pathway_index), nrow(coordinates)),
      .source_rank = as.integer(source_ranks[coordinates[, 1L]]),
      .target_rank = as.integer(target_ranks[coordinates[, 2L]]),
      .pathway_rank = rep(as.integer(pathway_ranks[[pathway_index]]), nrow(coordinates)),
      stringsAsFactors = FALSE
    )
    if (accumulator_is_ranked) {
      better <- cellchat_inference_rows_strictly_before(
        block,
        accumulator[nrow(accumulator), , drop = FALSE],
        c("prob", "pval", ".source_rank", ".target_rank", ".pathway_rank",
          ".source_index", ".target_index", ".pathway_index"),
        c("descending", rep("ascending", 7L))
      )
      block <- block[better, , drop = FALSE]
      if (nrow(block) == 0L) next
    }
    accumulator <- rbind(accumulator, block)
    if (nrow(accumulator) >= limit) {
      accumulator <- cellchat_inference_keep_ranked_rows(
        accumulator,
        as.integer(limit),
        function(value) cellchat_inference_pathway_rank_order(value, display_by_internal)
      )
      accumulator_is_ranked <- nrow(accumulator) == limit
    }
  }
  rownames(accumulator) <- NULL
  list(rows = accumulator, candidate_count = candidate_count)
}

cellchat_inference_integer_count <- function(value) {
  as.integer(min(as.numeric(value), as.numeric(.Machine$integer.max)))
}

cellchat_inference_top_interactions <- function(table_out, limit, database_category) {
  if (nrow(table_out) == 0L) return(list())
  lapply(seq_len(min(nrow(table_out), limit)), function(i) {
    list(
      source = cellchat_inference_safe_string(table_out$source_group[i], 80L),
      target = cellchat_inference_safe_string(table_out$target_group[i], 80L),
      interaction = cellchat_inference_safe_string(table_out$interaction_name[i], 160L),
      pathway = cellchat_inference_safe_string(table_out$pathway_name[i], 120L),
      probability = round(as.numeric(table_out$probability[i]), 8),
      p_value = round(as.numeric(table_out$p_value[i]), 8),
      category = cellchat_inference_safe_string(database_category, 80L)
    )
  })
}

cellchat_inference_top_pathways <- function(table_out, limit) {
  if (nrow(table_out) == 0L) return(list())
  lapply(seq_len(min(nrow(table_out), limit)), function(i) {
    list(
      source = cellchat_inference_safe_string(table_out$source[i], 80L),
      target = cellchat_inference_safe_string(table_out$target[i], 80L),
      pathway = cellchat_inference_safe_string(table_out$pathway[i], 120L),
      probability = round(as.numeric(table_out$probability[i]), 8),
      p_value = round(as.numeric(table_out$p_value[i]), 8)
    )
  })
}

run_cellchat_inference_analysis <- function(input_obj, p) {
  required_packages <- c("CellChat", "NMF")
  missing_packages <- required_packages[
    !vapply(required_packages, requireNamespace, logical(1), quietly = TRUE)
  ]
  if (length(missing_packages) > 0L) {
    cellchat_inference_input_error(
      "CellChat runtime dependencies are unavailable.",
      "CELLCHAT_PACKAGES_UNAVAILABLE"
    )
  }
  if (!inherits(input_obj, "Seurat")) {
    cellchat_inference_input_error("Loaded object is not a Seurat object.")
  }
  if (!(p$assay %in% Assays(input_obj))) {
    cellchat_inference_input_error("The RNA assay is required for cell communication inference.", "CELLCHAT_ASSAY_UNAVAILABLE")
  }
  input_cells <- colnames(input_obj)
  if (length(input_cells) < 1L) {
    cellchat_inference_input_error("The input object has no cells.")
  }

  group_values <- if (identical(p$group_by, "seurat_clusters")) {
    if (!("seurat_clusters" %in% colnames(input_obj@meta.data))) {
      cellchat_inference_input_error("Clustering results are required for cell communication inference.", "CELLCHAT_GROUPING_UNAVAILABLE")
    }
    as.character(input_obj@meta.data$seurat_clusters)
  } else {
    as.character(Idents(input_obj))
  }
  if (length(group_values) != length(input_cells)) {
    cellchat_inference_input_error("The requested grouping is not aligned with the input object.")
  }
  names(group_values) <- input_cells
  grouped <- !is.na(group_values) & nzchar(trimws(group_values))
  all_groups <- sort(unique(group_values[grouped]))
  # CellChat's pairwise graph grows quadratically in group count. Reject rather than
  # silently dropping groups, and keep every returned summary array safely bounded.
  if (length(all_groups) > 32L) {
    cellchat_inference_input_error("CellChat v1 supports at most 32 populated groups per run.", "CELLCHAT_GROUP_COUNT_INVALID")
  }
  if (length(all_groups) < 2L) {
    cellchat_inference_input_error("At least two populated groups are required for cell communication inference.", "CELLCHAT_GROUP_COUNT_INVALID")
  }
  input_counts <- vapply(all_groups, function(group) {
    as.integer(sum(grouped & group_values == group))
  }, integer(1))
  # `which()` inherits raw group names from input_counts. Drop them before any
  # list construction so they cannot become JSON object keys in a receipt.
  eligible_indices <- unname(which(input_counts >= p$min_cells_per_group))
  excluded_indices <- unname(which(input_counts < p$min_cells_per_group))
  if (length(eligible_indices) < 2L) {
    cellchat_inference_input_error("At least two groups must meet the minimum cell count.", "CELLCHAT_MIN_GROUP_CELLS")
  }

  per_group_cap <- min(
    p$max_cells_per_group,
    floor(p$max_total_cells / length(eligible_indices))
  )
  if (per_group_cap < p$min_cells_per_group) {
    cellchat_inference_input_error("The total cell cap cannot retain the requested minimum for every eligible group.")
  }

  # Sampling is deterministic and must not perturb the shared R process's RNG state.
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

  eligible_groups <- all_groups[eligible_indices]
  selected_cells_by_group <- lapply(eligible_groups, function(group) {
    group_cells <- sort(names(group_values)[grouped & group_values == group])
    selected_count <- min(length(group_cells), per_group_cap)
    if (length(group_cells) > selected_count) sample(group_cells, selected_count) else group_cells
  })
  selected_cells <- sort(unique(unlist(selected_cells_by_group, use.names = FALSE)))
  if (length(selected_cells) < 2L * p$min_cells_per_group) {
    cellchat_inference_input_error("Too few cells remain after bounded sampling.")
  }
  analyzed_counts <- vapply(eligible_groups, function(group) {
    as.integer(sum(group_values[selected_cells] == group))
  }, integer(1))

  # Opaque labels avoid raw metadata exposure and also meet CellChat v2's group-label
  # constraints for numeric/default Seurat clusters.
  internal_labels <- sprintf("Group_%03d", seq_along(all_groups))
  display_labels <- sprintf("Group %d", seq_along(all_groups))
  raw_to_internal <- stats::setNames(internal_labels, all_groups)
  display_by_internal <- stats::setNames(display_labels, internal_labels)

  # Do not clone a cell-subset Seurat object: prepare only the bounded RNA
  # signaling-gene layer and minimal synthetic group metadata that CellChat uses.
  cellchat_database <- cellchat_inference_database(p)
  prepared_input <- cellchat_inference_prepare_input(
    input_obj,
    p$assay,
    selected_cells,
    group_values,
    raw_to_internal,
    unname(raw_to_internal[eligible_groups]),
    cellchat_database
  )
  data_input <- prepared_input$data

  warning_state <- new.env(parent = emptyenv())
  warning_state$seen <- FALSE
  with_cellchat_warnings <- function(expr) {
    withCallingHandlers(
      expr,
      warning = function(w) {
        warning_state$seen <- TRUE
        invokeRestart("muffleWarning")
      }
    )
  }
  cellchat <- with_cellchat_warnings(CellChat::createCellChat(
    object = data_input,
    meta = prepared_input$metadata,
    group.by = ".traceomics_cellchat_group",
    datatype = "RNA"
  ))
  cellchat@DB <- cellchat_database
  cellchat <- with_cellchat_warnings(CellChat::subsetData(cellchat))
  if (is.null(cellchat@data.signaling) || nrow(cellchat@data.signaling) < 5L) {
    cellchat_inference_input_error("Too few signaling genes overlap the selected CellChat database.", "CELLCHAT_DATABASE_OVERLAP_LOW")
  }
  cellchat <- with_cellchat_warnings(CellChat::identifyOverExpressedGenes(
    cellchat,
    thresh.p = p$p_value_cutoff,
    do.fast = FALSE,
    min.cells = p$min_cells_per_group
  ))
  cellchat <- with_cellchat_warnings(CellChat::identifyOverExpressedInteractions(cellchat))
  # CellChat 2.1.2 indexes a missing probability dimension when no complete
  # ligand-receptor pairs survive selection. Reject this input before compute
  # or any result write; a deterministic input rejection must not become an
  # indeterminate server failure that keeps a durable job in recovery.
  if (is.null(cellchat@LR$LRsig) || nrow(cellchat@LR$LRsig) == 0L) {
    cellchat_inference_input_error(
      "No eligible ligand receptor pairs remain in the selected database and input.",
      "CELLCHAT_NO_ELIGIBLE_INTERACTIONS"
    )
  }
  cellchat <- with_cellchat_warnings(CellChat::computeCommunProb(
    cellchat,
    # `data_input` is the normalized Seurat RNA layer. `raw.use = TRUE` tells
    # CellChat to use its populated signaling matrix; the FALSE branch requires
    # an additional smoothing step and otherwise has no data to aggregate.
    # Groups are independently capped for bounded compute, so population-size
    # weighting would incorrectly treat sampled/capped group counts as their
    # original abundance. Keep this a per-group expression prediction instead.
    raw.use = TRUE,
    population.size = FALSE,
    seed.use = p$random_seed
  ))
  cellchat <- with_cellchat_warnings(CellChat::filterCommunication(
    cellchat,
    min.cells = p$min_cells_per_group
  ))

  # `subsetCommunication()` would first reshape every source x target x
  # ligand/receptor combination. Extract the same thresholded network in fixed
  # blocks instead, retaining only the globally ranked private CSV cap.
  net_arrays <- cellchat_inference_net_arrays(cellchat@net)
  pair_metadata <- cellchat_inference_pair_metadata(
    cellchat@LR$LRsig, net_arrays$pair_labels
  )
  interaction_result <- cellchat_inference_bounded_interaction_rows(
    net_arrays, pair_metadata, p, display_by_internal
  )
  candidate_interaction_count <- cellchat_inference_integer_count(
    interaction_result$candidate_count
  )
  interaction_table <- cellchat_inference_interaction_table(
    interaction_result$rows, display_by_internal, p
  )
  warnings_out <- character()
  if (isTRUE(warning_state$seen)) {
    warnings_out <- c(warnings_out, "CellChat reported one or more non fatal analysis warnings.")
  }
  if (any(!grouped)) {
    warnings_out <- c(warnings_out, "Cells without a populated selected group were excluded.")
  }
  if (any(input_counts[eligible_indices] > analyzed_counts)) {
    warnings_out <- c(warnings_out, "Eligible groups were deterministically capped for bounded CellChat inference.")
  }
  warnings_out <- c(
    warnings_out,
    "Communication probabilities use capped per group expression and do not encode original population abundance."
  )
  if (interaction_result$candidate_count > nrow(interaction_table)) {
    warnings_out <- c(warnings_out, "The private interaction table was limited to 50000 retained rows.")
  }
  if (nrow(interaction_table) == 0L) {
    warnings_out <- c(warnings_out, "No predicted ligand receptor candidates passed the requested p value cutoff.")
  }

  pathway_table <- data.frame(
    source = character(), target = character(), pathway = character(),
    probability = numeric(), p_value = numeric(), stringsAsFactors = FALSE
  )
  retained_pathway_count <- 0L
  if (interaction_result$candidate_count > 0L) {
    pathway_result <- tryCatch(
      cellchat_inference_bounded_pathway_rows(
        net_arrays, pair_metadata, p, display_by_internal
      ),
      error = function(e) NULL
    )
    if (is.null(pathway_result)) {
      warnings_out <- c(warnings_out, "Pathway level summaries were unavailable for this CellChat result.")
    } else {
      pathway_table <- cellchat_inference_pathway_table(
        pathway_result$rows, display_by_internal, p
      )
      retained_pathway_count <- cellchat_inference_integer_count(
        pathway_result$candidate_count
      )
    }
  }
  if (nrow(pathway_table) == 0L) {
    warnings_out <- c(warnings_out, "No predicted signaling pathways passed the requested p value cutoff.")
  }

  group_summary <- lapply(eligible_indices, function(index) {
    list(
      group = cellchat_inference_safe_string(display_labels[index], 80L),
      input_cells = as.integer(input_counts[index]),
      analyzed_cells = as.integer(analyzed_counts[match(all_groups[index], eligible_groups)])
    )
  })
  excluded_group_summary <- lapply(excluded_indices, function(index) {
    list(
      group = cellchat_inference_safe_string(display_labels[index], 80L),
      input_cells = as.integer(input_counts[index]),
      reason = "below_min_cells"
    )
  })
  safe_warnings <- unique(vapply(
    warnings_out, cellchat_inference_safe_string, character(1), max_chars = 200L
  ))
  safe_warnings <- as.list(safe_warnings[nzchar(safe_warnings)])
  safe_warnings <- safe_warnings[seq_len(min(length(safe_warnings), 32L))]

  list(
    table = interaction_table,
    summary = list(
      method = "cellchat_v2_predicted_signaling",
      analysis_intent = p$analysis_intent,
      group_by = p$group_by,
      assay = p$assay,
      species = p$species,
      database_category = p$database_category,
      p_value_cutoff = p$p_value_cutoff,
      input_cell_count = as.integer(length(input_cells)),
      analyzed_cell_count = as.integer(length(selected_cells)),
      input_group_count = as.integer(length(all_groups)),
      analyzed_group_count = as.integer(length(eligible_indices)),
      excluded_group_count = as.integer(length(excluded_indices)),
      candidate_interaction_count = candidate_interaction_count,
      retained_interaction_count = cellchat_inference_integer_count(nrow(interaction_table)),
      retained_pathway_count = retained_pathway_count,
      groups = group_summary,
      excluded_groups = excluded_group_summary,
      package_versions = list(
        r = cellchat_inference_safe_string(as.character(getRversion()), 80L),
        seurat = cellchat_inference_safe_string(as.character(utils::packageVersion("Seurat")), 80L),
        cellchat = cellchat_inference_safe_string(as.character(utils::packageVersion("CellChat")), 80L),
        cellchat_db = cellchat_inference_safe_string(
          paste0("CellChatDB.", p$species, " ", as.character(utils::packageVersion("CellChat"))),
          120L
        )
      ),
      top_interactions = cellchat_inference_top_interactions(
        interaction_table, p$top_interactions, p$database_category
      ),
      top_pathways = cellchat_inference_top_pathways(pathway_table, p$top_pathways),
      warnings = safe_warnings
    )
  )
}
