MAX_PLOT_FEATURES <- 50L
MAX_QC_DISTRIBUTION_VALUES <- 5000L
MAX_PLOT_PIXELS <- 8000000
MAX_PUBLIC_CELL_VALUES <- 20000L
MAX_PUBLIC_GENE_LIST <- 50000L
MAX_PUBLIC_CLUSTERS <- 200L
MAX_DOT_PLOT_GENES <- 50L
MAX_HEATMAP_GENES <- 200L
MAX_HEATMAP_CELLS <- 5000L
MAX_PUBLIC_GENE_NAME_CHARS <- 256L
MAX_PUBLIC_LABEL_CHARS <- 128L
MAX_PUBLIC_GENE_LIST_BYTES <- 2000000L
MAX_REGRESSION_VARIABLES <- 10L
MAX_PUBLIC_PARAMETER_NAME_CHARS <- 128L
MAX_NORMALIZE_SCALE_FACTOR <- 1000000L
MAX_VARIABLE_FEATURES <- 10000L
MAX_REDUCTION_DIMS <- 100L
MAX_CLUSTER_RESOLUTION <- 5
MAX_PUBLIC_PCA_FEATURES <- 10000L
MAX_PUBLIC_BATCHES <- 100L
MAX_PUBLIC_METADATA_COLUMNS <- 64L
MAX_PUBLIC_METADATA_VALUES <- 1000L
MAX_PUBLIC_MAPPING_ENTRIES <- 1000L
MAX_PUBLIC_OBJECT_BYTES <- 512 * 1024 * 1024
MAX_PUBLIC_DENSE_VALUES <- 50000000

# Public browser-driven R operations are synchronous and can duplicate large
# matrices or construct large neighbor graphs. Objects beyond this conservative
# live-compute ceiling must use a durable queued job/artifact path instead.
MAX_PUBLIC_SYNC_CELLS <- 100000L
MAX_PUBLIC_SYNC_FEATURES <- 100000L

bounded_plot_number <- function(value, default, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)) return(default)
  min(max(parsed, minimum), maximum)
}

bounded_plot_features <- function(value) {
  if (is.null(value) || length(value) == 0) return(NULL)
  head(as.character(unlist(value, use.names = FALSE)), MAX_PLOT_FEATURES)
}

bounded_sample_indices <- function(total, maximum = MAX_QC_DISTRIBUTION_VALUES) {
  total <- suppressWarnings(as.integer(total))
  maximum <- suppressWarnings(as.integer(maximum))
  if (length(total) != 1 || is.na(total) || total <= 0
      || length(maximum) != 1 || is.na(maximum) || maximum <= 0) return(integer())
  if (total <= maximum) return(seq_len(total))
  unique(as.integer(round(seq(1, total, length.out = maximum))))
}

plot_pixel_budget_ok <- function(width, height, resolution) {
  is.finite(width) && is.finite(height) && is.finite(resolution) &&
    (width * height * resolution * resolution) <= MAX_PLOT_PIXELS
}

public_bounded_integer <- function(value, name, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)
      || parsed != trunc(parsed) || parsed < minimum || parsed > maximum) {
    stop(paste0(name, " must be a whole number from ", minimum, " to ", maximum, "."))
  }
  as.integer(parsed)
}

public_bounded_number <- function(value, name, minimum, maximum) {
  parsed <- suppressWarnings(as.numeric(value))
  if (length(parsed) != 1 || is.na(parsed) || !is.finite(parsed)
      || parsed < minimum || parsed > maximum) {
    stop(paste0(name, " must be a finite number from ", minimum, " to ", maximum, "."))
  }
  parsed
}

public_choice <- function(value, name, allowed) {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be one of: ", paste(allowed, collapse = ", "), "."))
  }
  parsed <- as.character(value)
  if (!(parsed %in% allowed)) {
    stop(paste0(name, " must be one of: ", paste(allowed, collapse = ", "), "."))
  }
  parsed
}

public_optional_seed <- function(value) {
  if (is.null(value) || length(value) == 0) return(NULL)
  if (length(value) == 1 && !is.na(value) && identical(trimws(as.character(value)), "")) return(NULL)
  public_bounded_integer(value, "seed", 0, .Machine$integer.max - 1L)
}

public_scalar_text <- function(value, name, maximum_chars = MAX_PUBLIC_PARAMETER_NAME_CHARS) {
  if (!is.atomic(value) || length(value) != 1L || is.na(value)) {
    stop(paste0(name, " must be one text value."))
  }
  parsed <- as.character(value)
  if (!nzchar(trimws(parsed))
      || nchar(parsed, type = "chars") > maximum_chars
      || grepl("[[:cntrl:]]", parsed)) {
    stop(paste0(name, " must be non-empty, contain no control characters, and be no longer than ",
                maximum_chars, " characters."))
  }
  parsed
}

public_metadata_column <- function(object, value, name = "column") {
  parsed <- public_scalar_text(value, name)
  columns <- tryCatch(colnames(object@meta.data), error = function(e) character())
  if (!(parsed %in% columns)) stop(paste0(name, " was not found in object metadata."))
  parsed
}

public_gene_identifier <- function(value, name = "gene") {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be a single gene identifier."))
  }
  parsed <- as.character(value)
  if (nchar(trimws(parsed), type = "chars") == 0
      || nchar(parsed, type = "chars") > MAX_PUBLIC_GENE_NAME_CHARS
      || grepl("[[:cntrl:]]", parsed)) {
    stop(paste0(name, " must be a non-empty gene identifier no longer than ",
                MAX_PUBLIC_GENE_NAME_CHARS, " characters."))
  }
  parsed
}

bounded_public_labels <- function(value, maximum_chars = MAX_PUBLIC_LABEL_CHARS) {
  labels <- as.character(value)
  labels[is.na(labels)] <- ""
  labels <- gsub("[[:cntrl:]]", "", labels)
  substring(labels, 1L, maximum_chars)
}

public_identity_levels <- function(idents) {
  values <- as.character(idents)
  observed <- unique(values[!is.na(values)])
  declared <- levels(idents)
  if (is.null(declared)) return(observed)
  c(declared[declared %in% observed], setdiff(observed, declared))
}

bounded_public_gene_names <- function(value,
                                      maximum = MAX_PUBLIC_GENE_LIST,
                                      maximum_bytes = MAX_PUBLIC_GENE_LIST_BYTES) {
  genes <- as.character(value)
  valid <- !is.na(genes) & nzchar(trimws(genes))
  if (any(valid)) {
    valid[valid] <- nchar(genes[valid], type = "chars") <= MAX_PUBLIC_GENE_NAME_CHARS &
      !grepl("[[:cntrl:]]", genes[valid])
  }
  genes <- head(genes[valid], maximum)
  if (length(genes) == 0) return(character())
  encoded_bytes <- nchar(enc2utf8(genes), type = "bytes") + 3L
  genes[cumsum(encoded_bytes) <= maximum_bytes]
}

public_csv_gene_list <- function(value, maximum = MAX_DOT_PLOT_GENES) {
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop("genes must be one comma-separated list.")
  }
  raw <- as.character(value)
  if (nchar(raw, type = "chars") > maximum * (MAX_PUBLIC_GENE_NAME_CHARS + 1L)) {
    stop(paste0("genes exceeds the maximum encoded length for ", maximum, " genes."))
  }
  values <- trimws(strsplit(raw, ",", fixed = TRUE)[[1]])
  values <- values[values != ""]
  if (length(values) == 0) stop("No genes provided.")
  if (length(values) > maximum) stop(paste0("genes must contain at most ", maximum, " entries."))
  values <- vapply(values, public_gene_identifier, character(1), name = "Each gene")
  unique(unname(values))
}

public_csv_parameter_list <- function(value, name, maximum, allow_empty = TRUE) {
  if (is.null(value) || length(value) == 0) {
    if (allow_empty) return(character())
    stop(paste0(name, " is required."))
  }
  if (!is.atomic(value) || length(value) != 1 || is.na(value)) {
    stop(paste0(name, " must be one comma-separated list."))
  }
  raw <- as.character(value)
  if (identical(trimws(raw), "") && allow_empty) return(character())
  if (nchar(raw, type = "chars") > maximum * (MAX_PUBLIC_PARAMETER_NAME_CHARS + 1L)) {
    stop(paste0(name, " exceeds the maximum encoded length."))
  }
  values <- trimws(strsplit(raw, ",", fixed = TRUE)[[1]])
  values <- values[values != ""]
  if (length(values) > maximum) stop(paste0(name, " must contain at most ", maximum, " entries."))
  if (any(nchar(values, type = "chars") > MAX_PUBLIC_PARAMETER_NAME_CHARS)
      || any(grepl("[[:cntrl:]]", values))) {
    stop(paste0(name, " contains an invalid or overlong entry."))
  }
  unique(values)
}

# Deterministic, evenly spaced sampling with one anchor per observed group. This
# keeps small clusters visible while enforcing a hard global response bound.
bounded_group_sample_indices <- function(groups, maximum = MAX_PUBLIC_CELL_VALUES) {
  maximum <- suppressWarnings(as.integer(maximum))
  total <- length(groups)
  if (length(maximum) != 1 || is.na(maximum) || maximum <= 0 || total == 0) return(integer())
  if (total <= maximum) return(seq_len(total))
  labels <- as.character(groups)
  labels[is.na(labels)] <- "<NA>"
  anchors <- match(unique(labels), labels)
  if (length(anchors) >= maximum) return(sort(as.integer(head(anchors, maximum))))
  candidates <- setdiff(seq_len(total), anchors)
  remaining <- maximum - length(anchors)
  sampled <- candidates[bounded_sample_indices(length(candidates), remaining)]
  sort(as.integer(c(anchors, sampled)))
}

# Select a deterministic top-N marker set without dplyr's tie expansion. The
# returned feature count is bounded even for pathological cluster counts.
bounded_marker_features <- function(markers, top_n,
                                    maximum = MAX_HEATMAP_GENES,
                                    max_clusters = MAX_PUBLIC_CLUSTERS) {
  top_n <- public_bounded_integer(top_n, "top_n", 1, 20)
  if (!is.data.frame(markers) || !all(c("cluster", "gene") %in% names(markers))) {
    stop("Marker results are missing required columns.")
  }
  score_column <- if ("avg_log2FC" %in% names(markers)) {
    "avg_log2FC"
  } else if ("avg_logFC" %in% names(markers)) {
    "avg_logFC"
  } else {
    stop("Marker results are missing a fold-change column.")
  }
  cluster_values <- as.character(markers$cluster)
  clusters <- head(unique(cluster_values[!is.na(cluster_values)]), max_clusters)
  selected <- character()
  for (cluster in clusters) {
    rows <- which(cluster_values == cluster & !is.na(markers$gene))
    if (length(rows) == 0) next
    scores <- suppressWarnings(as.numeric(markers[[score_column]][rows]))
    genes <- as.character(markers$gene[rows])
    valid <- is.finite(scores) & !is.na(genes) & nzchar(genes) &
      nchar(genes, type = "chars") <= MAX_PUBLIC_GENE_NAME_CHARS &
      !grepl("[[:cntrl:]]", genes)
    if (!any(valid)) next
    scores <- scores[valid]
    genes <- genes[valid]
    order_idx <- order(-scores, genes, method = "radix")
    selected <- unique(c(selected, head(genes[order_idx], top_n)))
    if (length(selected) >= maximum) break
  }
  head(selected, maximum)
}

public_validation_response <- function(res, error) {
  res$status <- 400
  list(error = conditionMessage(error))
}

public_compute_admission <- function(object, operation) {
  dimensions <- suppressWarnings(as.numeric(c(
    n_features = nrow(object),
    n_cells = ncol(object)
  )))
  if (length(dimensions) != 2L || any(!is.finite(dimensions))
      || any(dimensions < 0) || any(dimensions != trunc(dimensions))) {
    stop(paste0(operation, " requires an object with valid cell and feature dimensions."))
  }
  n_features <- dimensions[[1]]
  n_cells <- dimensions[[2]]
  if (n_cells > MAX_PUBLIC_SYNC_CELLS || n_features > MAX_PUBLIC_SYNC_FEATURES) {
    stop(paste0(
      operation, " exceeds the live synchronous compute limit of ",
      MAX_PUBLIC_SYNC_CELLS, " cells and ", MAX_PUBLIC_SYNC_FEATURES,
      " features. Use a durable queued job for larger objects."
    ))
  }
  object_bytes <- suppressWarnings(as.numeric(object.size(object)))
  if (length(object_bytes) != 1L || !is.finite(object_bytes) || object_bytes < 0
      || object_bytes > MAX_PUBLIC_OBJECT_BYTES) {
    stop(paste0(
      operation, " exceeds the live synchronous in-memory object limit of ",
      MAX_PUBLIC_OBJECT_BYTES, " bytes. Use a durable queued job for larger objects."
    ))
  }
  list(
    n_cells = as.integer(n_cells),
    n_features = as.integer(n_features),
    object_bytes = object_bytes
  )
}

public_dense_allocation_admission <- function(admission, feature_count, operation,
                                              maximum_values = MAX_PUBLIC_DENSE_VALUES) {
  features <- suppressWarnings(as.numeric(feature_count))
  if (!is.list(admission) || length(admission$n_cells) != 1L
      || !is.finite(admission$n_cells) || admission$n_cells < 0
      || length(features) != 1L || !is.finite(features)
      || features != trunc(features) || features < 1
      || length(maximum_values) != 1L || !is.finite(maximum_values)
      || maximum_values < 1) {
    stop(paste0(operation, " has an invalid dense-allocation estimate."))
  }
  dense_values <- as.numeric(admission$n_cells) * features
  if (!is.finite(dense_values) || dense_values > maximum_values) {
    stop(paste0(
      operation, " exceeds the live synchronous dense-allocation limit of ",
      format(maximum_values, scientific = FALSE),
      " values. Use a durable queued job for larger objects."
    ))
  }
  list(
    n_cells = as.integer(admission$n_cells),
    n_features = as.integer(features),
    dense_values = dense_values
  )
}

public_compute_admission_response <- function(res, error) {
  res$status <- 413
  list(error = conditionMessage(error))
}
