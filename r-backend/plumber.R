# ── R Plumber API for scRNA-seq with Seurat v5 ────────
# Every endpoint wraps its result in a provenance envelope
# 
# Note: In production, Seurat must be installed.

library(Seurat)
library(dplyr)
library(Matrix)
library(ggplot2)

# ── Session ID ────────────────────────────────────────────────────
# Generated fresh on every R process start. Used by the frontend to
# detect restarts so cached pipeline steps are re-executed in R.
r_session_id <- paste0(format(Sys.time(), "%Y%m%d%H%M%S"), "-",
                       paste0(sample(c(letters, 0:9), 8, replace = TRUE), collapse = ""))
cat("[R] Session ID:", r_session_id, "\n")

# Holds the physical Seurat object for stateful processing
global_obj <- NULL
# Holds the unfiltered starting point for the current object (for non-destructive QC re-runs)
raw_obj <- NULL

# ── Helper: generate a provenance envelope ────────────────────────
make_provenance <- function(result, script_text, operation = "unknown",
                            packages_used = c("Seurat"), parameters = list()) {
  list(
    provenance = list(
      id = paste0("prov-", format(Sys.time(), "%Y%m%d%H%M%S"), "-", sample(1000:9999, 1)),
      timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
      language = "R",
      languageVersion = paste0(R.version$major, ".", R.version$minor),
      packages = packages_used,
      script = script_text,
      parameters = parameters,
      operation = operation
    ),
    result = result
  )
}

# ── Validation Helpers ──────────────────────────────────────────────
validate_path <- function(user_path, safe_dir = "vault") {
  dir.create(safe_dir, recursive = TRUE, showWarnings = FALSE)
  real_path <- normalizePath(user_path, mustWork = FALSE)
  safe_real <- normalizePath(safe_dir, mustWork = TRUE)
  if (!startsWith(real_path, safe_real)) {
    stop("Access denied: path traversal attempt. Path must be within the vault.")
  }
  return(real_path)
}

validate_absolute_path <- function(user_path) {
  if (grepl("(^|[/\\\\])\\.\\.(|[/\\\\]|$)", user_path)) stop("Access denied: path traversal attempt using '..'")
  is_absolute <- grepl("^(/|[A-Za-z]:[/\\\\]|\\\\\\\\)", user_path)
  if (!is_absolute) stop("Access denied: path must be absolute")
  return(user_path)
}

# ── Session Management ──────────────────────────────────────────────
active_sessions <- new.env(parent = emptyenv())

#* @plumber
function(pr) {
  pr %>% pr_hook("postroute", function(req, res) {
    sid <- req$HTTP_X_OBJECT_ID
    if (is.null(sid) || nchar(sid) == 0) sid <- "DEFAULT"
    # Save the current state of global variables back to the session cache
    active_sessions[[sid]] <- list(global = global_obj, raw = raw_obj)
  })
}

#* @filter session_loader
function(req, res) {
  sid <- req$HTTP_X_OBJECT_ID
  if (is.null(sid) || nchar(sid) == 0) sid <- "DEFAULT"
  
  if (exists(sid, envir = active_sessions)) {
    sess <- active_sessions[[sid]]
    global_obj <<- sess$global
    raw_obj <<- sess$raw
  } else {
    global_obj <<- NULL
    raw_obj <<- NULL
  }
  
  plumber::forward()
}

# ── API Token Authentication Filter ─────────────────────────────────
#* @filter auth
function(req, res) {
  expected_token <- Sys.getenv("API_TOKEN")
  provided_token <- req$HTTP_X_API_TOKEN
  # Allow OPTIONS requests through for CORS preflight
  if (req$REQUEST_METHOD == "OPTIONS") {
    plumber::forward()
  } else {
    # Fail secure: if API_TOKEN is not set in env, refuse all requests
    if (is.null(expected_token) || nchar(expected_token) == 0 || is.null(provided_token) || provided_token != expected_token) {
      res$status <- 403
      return(list(error = "Unauthorized: Invalid or missing API token"))
    }
    plumber::forward()
  }
}

# ── Plumber API ───────────────────────────────────────────────────

#* @filter cors
function(req, res) {
  # In a production app you might restrict this further, but the Auth token provides the real security
  res$setHeader("Access-Control-Allow-Origin", "http://localhost:5173")
  res$setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res$setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Token, X-Object-ID")
  if (req$REQUEST_METHOD == "OPTIONS") {
    res$status <- 200
    return(list())
  }
  plumber::forward()
}

#* Health check
#* @get /health
function(res) {
  list(status = "ok", timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"), mode = "scRNA-seq Seurat Real")
}

#* Return the R process session ID (changes on every restart)
#* @get /session-id
function(res) {
  list(sessionId = r_session_id)
}

#* Get real QC distribution data from the loaded Seurat object
#* @get /qc-distributions
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded. Load data first."))
  
  tryCatch({
    # Compute percent.mt if not already present
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^[Mm][Tt]-")
    }
    
    mt_vals <- as.numeric(global_obj$percent.mt)
    feature_vals <- as.numeric(global_obj$nFeature_RNA)
    count_vals <- as.numeric(global_obj$nCount_RNA)
    
    list(
      percent_mt = round(mt_vals, 3),
      nFeature_RNA = feature_vals,
      nCount_RNA = count_vals,
      n_cells = length(mt_vals)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Failed to compute QC distributions:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 0: Load Data
# ──────────────────────────────────────────────────────────────────

#* Load dataset into memory
#* @get /load-data
function(res, min_cells = 3, min_features = 200) {
  min_cells <- as.integer(min_cells)
  min_features <- as.integer(min_features)

  tryCatch({
    script <- paste0(
      "library(Seurat)\n",
      "# 1. Read 10X sparse matrix\n",
      "mat <- Read10X(data.dir = 'data/pbmc3k/filtered_gene_bc_matrices/hg19')\n",
      "# 2. Initialize Seurat object\n",
      "obj <- CreateSeuratObject(counts = mat, min.cells = ", min_cells, ", min.features = ", min_features, ")\n"
    )

    # Actual R execution
    data_path <- '../data/pbmc3k/filtered_gene_bc_matrices/hg19'
    
    if (!dir.exists(data_path)) {
       stop(paste("Data directory not found at:", normalizePath(data_path, mustWork = FALSE)))
    }
    
    mat <- Read10X(data.dir = data_path)
    global_obj <<- CreateSeuratObject(counts = mat, min.cells = min_cells, min.features = min_features)
    raw_obj <<- global_obj

    # Calculate real density
    nnz <- length(mat@x)
    total_elements <- as.numeric(nrow(mat)) * as.numeric(ncol(mat))
    density_val <- (nnz / total_elements) * 100
    sparsity_val <- 100 - density_val

    make_provenance(
      result = list(
        message = "Matrix successfully loaded into Seurat.",
        cells = ncol(global_obj),
        features = nrow(global_obj),
        genes = nrow(global_obj),
        sparsity = round(sparsity_val, 2),
        density = round(density_val, 2)
      ),
      script_text = script,
      operation = "load",
      parameters = list(file = "pbmc3k", engine = "Seurat")
    )
  }, error = function(e) { res$status <- 500; list(error = paste("R Error:", e$message))
  })
}

#* Load a local 10X directory (barcodes / features / matrix)
#* @get /load-local-10x
function(res, path, min_cells = 3, min_features = 200) {
  min_cells <- as.integer(min_cells)
  min_features <- as.integer(min_features)
  tryCatch({
    path <- validate_absolute_path(path)
    if (!dir.exists(path)) stop(paste("Directory not found:", path))
    mat <- Read10X(data.dir = path)
    global_obj <<- CreateSeuratObject(counts = mat, min.cells = min_cells, min.features = min_features)
    raw_obj <<- global_obj
    global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^[Mm][Tt]-")
    nnz <- length(mat@x)
    total_el <- as.numeric(nrow(mat)) * as.numeric(ncol(mat))
    density_val <- (nnz / total_el) * 100
    make_provenance(
      result = list(
        message = "Local 10X matrix loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        sparsity = round(100 - density_val, 2), density = round(density_val, 2),
        source = "local-10x"
      ),
      script_text = paste0(
        "mat <- Read10X(data.dir = '", path, "')\n",
        "obj <- CreateSeuratObject(counts = mat, min.cells = ", min_cells,
        ", min.features = ", min_features, ")"
      ),
      operation = "load",
      parameters = list(path = path, min_cells = min_cells, min_features = min_features)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("10X load failed:", e$message)) })
}

#* Load and merge multiple 10X Cell Ranger directories into one Seurat object
#* @post /load-multi-10x
#* @parser json
function(res, req) {
  body        <- req$body
  paths       <- as.character(body$paths)
  sample_names <- as.character(body$sample_names)
  meta_col    <- if (!is.null(body$meta_col) && nchar(trimws(body$meta_col)) > 0) trimws(body$meta_col) else "orig.ident"
  min_cells   <- if (!is.null(body$min_cells))   as.integer(body$min_cells)   else 3L
  min_features <- if (!is.null(body$min_features)) as.integer(body$min_features) else 200L

  if (length(paths) == 0) return(list(error = "No paths provided."))
  if (length(sample_names) != length(paths)) {
    return(list(error = paste0("Length of sample_names (", length(sample_names),
                               ") must match length of paths (", length(paths), ").")))
  }

  tryCatch({
    # Validate all directories exist before starting
    missing_dirs <- paths[!dir.exists(paths)]
    if (length(missing_dirs) > 0) {
      stop(paste("Directories not found:", paste(missing_dirs, collapse = ", ")))
    }

    # ── Load each sample individually ──────────────────────────────
    obj_list <- vector("list", length(paths))
    per_sample_cells <- integer(length(paths))

    for (i in seq_along(paths)) {
      cat("[Multi-10X] Loading sample", i, "/", length(paths), ":", sample_names[i], "\n")
      mat_i <- Read10X(data.dir = paths[i])
      obj_i <- CreateSeuratObject(counts = mat_i, min.cells = min_cells, min.features = min_features,
                                  project = sample_names[i])
      # Assign the sample identity into the desired metadata column
      obj_i[[meta_col]] <- sample_names[i]
      
      # Assign extra metadata columns if provided
      if (!is.null(body$extra_meta)) {
        for (col_name in names(body$extra_meta)) {
          obj_i[[col_name]] <- as.character(body$extra_meta[[col_name]])[i]
        }
      }
      
      per_sample_cells[i] <- ncol(obj_i)
      obj_list[[i]] <- obj_i
    }

    # ── Merge all objects ──────────────────────────────────────────
    cat("[Multi-10X] Merging", length(obj_list), "objects...\n")
    if (length(obj_list) == 1) {
      merged <- obj_list[[1]]
    } else {
      merged <- merge(obj_list[[1]],
                      y = obj_list[-1],
                      add.cell.ids = sample_names,
                      merge.data = FALSE)
    }

    # ── Post-merge QC ─────────────────────────────────────────────
    merged[["percent.mt"]] <- PercentageFeatureSet(merged, pattern = "^[Mm][Tt]-")

    global_obj <<- merged
    raw_obj    <<- merged

    # Compute approximate density on the merged counts
    counts_mat <- tryCatch(GetAssayData(merged, layer = "counts"), error = function(e) NULL)
    density_val <- if (!is.null(counts_mat)) {
      nnz <- length(counts_mat@x)
      total <- as.numeric(nrow(counts_mat)) * as.numeric(ncol(counts_mat))
      (nnz / total) * 100
    } else NA_real_

    # ── Build a reproducible R script ─────────────────────────────
    load_lines <- paste0(
      "# Load sample: ", sample_names, "\n",
      "mat_", seq_along(paths), " <- Read10X(data.dir = '", paths, "')\n",
      "obj_", seq_along(paths), " <- CreateSeuratObject(counts = mat_", seq_along(paths),
      ", min.cells = ", min_cells, ", min.features = ", min_features,
      ", project = '", sample_names, "')\n",
      "obj_", seq_along(paths), "[['", meta_col, "']] <- '", sample_names, "'\n"
    )
    
    if (!is.null(body$extra_meta)) {
      for (col_name in names(body$extra_meta)) {
        meta_vals <- as.character(body$extra_meta[[col_name]])
        load_lines <- paste0(load_lines, "obj_", seq_along(paths), "[['", col_name, "']] <- '", meta_vals, "'\n")
      }
    }
    
    load_lines <- paste0(load_lines, collapse = "\n")
    merge_args <- paste0("obj_", seq_along(paths), collapse = ", ")
    merge_ids  <- paste0("c('", paste(sample_names, collapse = "', '"), "')")
    script_text <- paste0(
      load_lines, "\n",
      "# Merge all samples\n",
      "merged <- merge(obj_1, y = list(", paste0("obj_", seq_along(paths)[-1], collapse = ", "),
      "), add.cell.ids = ", merge_ids, ")\n",
      "merged[['percent.mt']] <- PercentageFeatureSet(merged, pattern = '^[Mm][Tt]-')\n"
    )

    per_sample_summary <- lapply(seq_along(paths), function(i) {
      list(name = sample_names[i], path = paths[i], cells = per_sample_cells[i])
    })

    make_provenance(
      result = list(
        message       = paste0("Merged ", length(paths), " 10X samples into one Seurat object."),
        cells         = ncol(global_obj),
        features      = nrow(global_obj),
        genes         = nrow(global_obj),
        density       = if (!is.na(density_val)) round(density_val, 2) else NULL,
        sparsity      = if (!is.na(density_val)) round(100 - density_val, 2) else NULL,
        source        = "multi-10x",
        meta_col      = meta_col,
        sample_names  = as.list(sample_names),
        per_sample    = per_sample_summary
      ),
      script_text   = script_text,
      operation     = "load",
      parameters    = list(paths = as.list(paths), sample_names = as.list(sample_names),
                           meta_col = meta_col, min_cells = min_cells, min_features = min_features)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Multi-10X load failed:", e$message)) })
}


#* Load a Seurat RDS object from a local file
#* @post /load-rds
#* @parser json
function(res, req) {
  tryCatch({
    path <- validate_absolute_path(req$body$path)
    # Note: RDS deserialization can execute arbitrary code in R.
    # Validate the class immediately to mitigate some risk.
    if (!file.exists(path)) stop(paste("File not found:", path))
    obj <- readRDS(path)
    if (!inherits(obj, "Seurat")) stop("RDS file does not contain a Seurat object.")
    global_obj <<- obj
    raw_obj <<- obj
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    nnz <- tryCatch(length(GetAssayData(global_obj, layer = "counts")@x), error = function(e) NA)
    total <- as.numeric(nrow(global_obj)) * as.numeric(ncol(global_obj))
    density_val <- if (!is.na(nnz)) (nnz / total) * 100 else NA
    make_provenance(
      result = list(
        message = "Seurat RDS loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        sparsity = if (!is.na(density_val)) round(100 - density_val, 2) else NULL,
        density = if (!is.na(density_val)) round(density_val, 2) else NULL,
        source = "rds",
        existing_reductions = names(global_obj@reductions)
      ),
      script_text = paste0("obj <- readRDS('", path, "')"),
      operation = "load",
      parameters = list(path = path)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("RDS load failed:", e$message)) })
}

#* Load an H5AD / H5Seurat file (requires SeuratDisk)
#* @get /load-h5ad
function(res, path) {
  tryCatch({
    path <- validate_absolute_path(path)
    if (!file.exists(path)) stop(paste("File not found:", path))
    if (!requireNamespace("SeuratDisk", quietly = TRUE)) {
      stop("SeuratDisk is required for H5AD files. Install with: remotes::install_github('mojaveazure/seurat-disk')")
    }
    library(SeuratDisk)
    ext <- tolower(tools::file_ext(path))
    if (ext == "h5ad") {
      h5seurat_path <- sub("\\.h5ad$", ".h5seurat", path)
      Convert(path, dest = "h5seurat", overwrite = TRUE)
      global_obj <<- LoadH5Seurat(h5seurat_path)
    } else {
      global_obj <<- LoadH5Seurat(path)
    }
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    make_provenance(
      result = list(
        message = "H5AD/H5Seurat loaded.",
        cells = ncol(global_obj), features = nrow(global_obj), genes = nrow(global_obj),
        source = "h5ad",
        existing_reductions = names(global_obj@reductions)
      ),
      script_text = paste0("obj <- LoadH5Seurat('", path, "')"),
      operation = "load",
      parameters = list(path = path)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("H5AD load failed:", e$message)) })
}

#* Inspect the current Seurat object — metadata, reductions, assays
#* @get /object-info
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  tryCatch({
    meta <- global_obj@meta.data
    meta_cols <- lapply(colnames(meta), function(col) {
      vals <- meta[[col]]
      if (is.numeric(vals)) {
        list(name = col, type = "numeric", n_unique = length(unique(vals)),
             min = round(min(vals, na.rm = TRUE), 4),
             max = round(max(vals, na.rm = TRUE), 4),
             mean = round(mean(vals, na.rm = TRUE), 4),
             preview = NULL)
      } else {
        u_vals <- unique(vals)
        n_uq <- length(u_vals)
        top <- if (n_uq < 50) head(names(sort(table(as.character(vals)), decreasing = TRUE)), 5) else NULL
        list(name = col, type = if (is.factor(vals)) "factor" else "character",
             n_unique = n_uq,
             min = NULL, max = NULL, mean = NULL, preview = top)
      }
    })
    list(
      n_cells = ncol(global_obj),
      n_features = nrow(global_obj),
      active_assay = DefaultAssay(global_obj),
      assays = Assays(global_obj),
      reductions = names(global_obj@reductions),
      meta_cols = meta_cols
    )
  }, error = function(e) { res$status <- 500; list(error = paste("object-info failed:", e$message)) })
}

#* Get all unique values (with counts) for a metadata column
#* @get /meta-values
function(res, column) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  if (!column %in% colnames(global_obj@meta.data)) return(list(error = paste("Column not found:", column)))
  vals <- as.character(global_obj@meta.data[[column]])
  counts_tbl <- sort(table(vals), decreasing = TRUE)
  list(
    column = column,
    n_unique = length(counts_tbl),
    values = lapply(names(counts_tbl), function(v) list(value = v, count = as.integer(counts_tbl[v])))
  )
}

#* Read column names from a local CSV (for the metadata import UI)
#* @get /csv-columns
function(res, path) {
  path <- validate_path(path, "vault")
  tryCatch({
    if (!file.exists(path)) stop(paste("File not found:", path))
    sep <- if (grepl("\\.tsv$", path, ignore.case = TRUE)) "\t" else ","
    df <- read.table(path, sep = sep, header = TRUE, nrows = 1, check.names = FALSE)
    list(columns = colnames(df))
  }, error = function(e) { res$status <- 500; list(error = paste("CSV read failed:", e$message)) })
}

#* Import metadata from a local CSV and join to the Seurat object by barcode
#* @get /add-metadata
function(res, csv_path, key_column = "barcode", value_columns = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  csv_path <- validate_path(csv_path, "vault")
  tryCatch({
    if (!file.exists(csv_path)) stop(paste("CSV not found:", csv_path))
    sep <- if (grepl("\\.tsv$", csv_path, ignore.case = TRUE)) "\t" else ","
    meta_df <- read.table(csv_path, sep = sep, header = TRUE, stringsAsFactors = FALSE, check.names = FALSE)
    if (!key_column %in% colnames(meta_df)) {
      stop(paste0("Key column '", key_column, "' not in CSV. Columns: ", paste(colnames(meta_df), collapse = ", ")))
    }
    cols_to_add <- if (nchar(trimws(value_columns)) == 0) {
      setdiff(colnames(meta_df), key_column)
    } else {
      trimws(strsplit(value_columns, ",")[[1]])
    }
    missing_cols <- setdiff(cols_to_add, colnames(meta_df))
    if (length(missing_cols) > 0) stop(paste("Columns not found in CSV:", paste(missing_cols, collapse = ", ")))

    rownames(meta_df) <- trimws(as.character(meta_df[[key_column]]))
    cell_barcodes <- colnames(global_obj)
    n_matched <- sum(cell_barcodes %in% rownames(meta_df))

    for (col in cols_to_add) {
      vals <- meta_df[cell_barcodes, col]
      global_obj[[col]] <<- vals
    }
    list(
      message = paste0("Added ", length(cols_to_add), " column(s) to ", n_matched, "/", length(cell_barcodes), " cells."),
      added_columns = cols_to_add,
      n_cells_matched = n_matched
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Add metadata failed:", e$message)) })
}

#* Add a new metadata column by mapping values from an existing column
#* @post /add-meta-mapping
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  
  body <- req$body
  source_col <- body$source_col
  new_col <- body$new_col
  mapping <- body$mapping
  
  if (is.null(source_col) || is.null(new_col) || is.null(mapping)) {
    return(list(error = "Missing source_col, new_col, or mapping in request body"))
  }
  
  tryCatch({
    if (!source_col %in% colnames(global_obj@meta.data)) {
      stop(paste("Source column not found:", source_col))
    }
    
    # Extract source values
    source_vals <- as.character(global_obj@meta.data[[source_col]])
    
    # Create the new mapped values, defaulting to NA or original value if not in mapping
    # Here we default to NA for unmapped values, but we could also use the original
    # We enforce as.character so that numbers are correctly typed as categorical metadata
    mapped_vals <- as.character(unlist(lapply(source_vals, function(v) {
      if (!is.null(mapping[[v]])) mapping[[v]] else NA
    })))
    
    # Assign new column
    global_obj[[new_col]] <<- mapped_vals
    
    list(
      message = paste0("Successfully added new metadata column: ", new_col),
      mapped_cells = sum(!is.na(mapped_vals))
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Add meta mapping failed:", e$message)) })
}


#* Subset the Seurat object by a metadata column and selected values
#* @post /subset
#* @parser json
function(res, req) {
  body <- req$body
  column <- body$column
  values <- body$values
  new_name <- if (!is.null(body$new_name)) body$new_name else "Subset"
  path <- body$path

  if (is.null(global_obj)) return(list(error = "No object loaded"))
  tryCatch({
    if (!column %in% colnames(global_obj@meta.data)) stop(paste("Column not found:", column))
    vals_vec <- trimws(strsplit(values, ",")[[1]])
    cell_meta_char <- as.character(global_obj@meta.data[[column]])
    cells_keep <- rownames(global_obj@meta.data)[cell_meta_char %in% vals_vec]
    if (length(cells_keep) == 0) stop("No cells match the specified criteria.")

    # Standard Seurat practice: retain raw counts + QC meta.data, reset processed slots
    sub_obj <- subset(global_obj, cells = cells_keep)
    
    # Bundle as list for persistence
    bundle <- list(global = sub_obj, raw = sub_obj)
    
    # Update active memory immediately to ensure R is in sync with the UI's new target
    global_obj <<- sub_obj
    raw_obj    <<- sub_obj

    if (!is.null(path) && path != "") {
      # Non-destructive mode: Save child to disk
      safe_path <- validate_path(path, "vault")
      saveRDS(bundle, safe_path)
    }

    make_provenance(
      result = list(
        message = paste0("Subset: ", length(cells_keep), " cells retained (", column,
                         " \u2208 {", paste(vals_vec, collapse = ", "), "})."),
        cells = ncol(global_obj),
        features = nrow(global_obj),
        genes = nrow(global_obj),
        # Density not recomputed to save time; marked as unknown
        source = "subset",
        subset_column = column,
        subset_values = vals_vec
      ),
      script_text = paste0(
        "cells.keep <- rownames(obj@meta.data)[obj@meta.data[['", column, "']] %in% c(",
        paste0("'", vals_vec, "'", collapse = ", "), ")]\n",
        "obj <- subset(obj, cells = cells.keep)"
      ),
      operation = "subset",
      parameters = list(column = column, values = vals_vec, new_name = new_name)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Subset failed:", e$message)) })
}

# ── Session Persistence ────────────────────────────────────────────────────────
# Save global_obj as an RDS file so the next app session can restore it without
# re-running the pipeline. A companion JSON stores the original session ID so
# the SQLite result cache (UMAP coords, PCA variance, etc.) remains valid.

#* Save current Seurat object to a local RDS file
#* @post /save-session
#* @parser json
function(res, req) {
  path <- req$body$path
  if (is.null(global_obj)) return(list(error = "No object to save"))
  tryCatch({
    safe_path <- validate_path(path, "vault")
    dir.create(dirname(safe_path), recursive = TRUE, showWarnings = FALSE)
    # Save as a list to preserve the raw checkpoint within a single file
    bundle <- list(global = global_obj, raw = raw_obj)
    saveRDS(bundle, file = safe_path)
    # Companion metadata: session ID + basic stats (used on restore)
    meta <- list(
      session_id = r_session_id,
      cells      = ncol(global_obj),
      features   = nrow(global_obj),
      reductions = names(global_obj@reductions),
      saved_at   = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    writeLines(jsonlite::toJSON(meta, auto_unbox = TRUE), con = meta_path)
    list(success = TRUE, path = safe_path, cells = ncol(global_obj))
  }, error = function(e) { res$status <- 500; list(error = paste("Save-session failed:", e$message)) })
}

#* Check whether a session RDS file exists
#* @post /check-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    safe_path <- validate_path(path, "vault")
    list(exists = file.exists(safe_path), path = safe_path)
  }, error = function(e) { res$status <- 500; list(error = paste("Check-session failed:", e$message)) })
}

#* Restore global_obj from a saved session RDS
#* @post /restore-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    safe_path <- validate_path(path, "vault")
    if (!file.exists(safe_path)) stop(paste("Session file not found:", safe_path))
    bundle <- readRDS(safe_path)
    
    if (inherits(bundle, "Seurat")) {
      # Legacy support: if file is just a Seurat object, use it for both
      global_obj <<- bundle
      raw_obj <<- bundle
    } else if (is.list(bundle) && "global" %in% names(bundle)) {
      global_obj <<- bundle$global
      raw_obj <<- if ("raw" %in% names(bundle)) bundle$raw else bundle$global
    } else {
      stop("File format not recognized (expected Seurat object or Vault bundle)")
    }

    # Restore original session ID so the frontend's SQLite cache keys still match
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    restored_session_id <- r_session_id   # fallback to current
    if (file.exists(meta_path)) {
      tryCatch({
        meta <- jsonlite::fromJSON(paste(readLines(meta_path, warn = FALSE), collapse = ""))
        if (!is.null(meta$session_id) && nchar(meta$session_id) > 0) {
          r_session_id <<- meta$session_id
          restored_session_id <- meta$session_id
        }
      }, error = function(e) invisible(NULL))
    }

    list(
      success      = TRUE,
      session_id   = restored_session_id,
      cells        = ncol(global_obj),
      features     = nrow(global_obj),
      reductions   = names(global_obj@reductions),
      n_meta_cols  = ncol(global_obj@meta.data)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Restore-session failed:", e$message)) })
}

#* Delete a session RDS file and its metadata
#* @post /delete-session
#* @parser json
function(res, req) {
  path <- req$body$path
  tryCatch({
    safe_path <- validate_path(path, "vault")
    if (file.exists(safe_path)) file.remove(safe_path)
    meta_path <- paste0(sub("\\.rds$", "", safe_path, ignore.case = TRUE), ".meta.json")
    if (file.exists(meta_path)) file.remove(meta_path)
    list(success = TRUE, path = safe_path)
  }, error = function(e) { res$status <- 500; list(error = paste("Delete-session failed:", e$message)) })
}
# ──────────────────────────────────────────────────────────────────────────────

#* Perform Quality Control (percent.mt, filtering)
#* @post /qc
#* @parser json
function(res, req) {
  body <- req$body
  mt_threshold <- body$mt_threshold
  min_features <- body$min_features
  max_features <- body$max_features
  min_counts <- body$min_counts

  # Rename to avoid collisions with Seurat column names in subset()
  mt_limit   <- as.numeric(mt_threshold)
  feat_min   <- as.numeric(min_features)
  feat_max   <- as.numeric(max_features)
  count_min  <- as.numeric(min_counts)
  
  # Treat feat_max = 0 as no limit for better UX, 
  # unless user specifically wants to test empty sets
  if (feat_max <= 0) feat_max <- 1e9

  if (is.null(global_obj)) return(list(error = "No object loaded"))

  # Use raw_obj as the base if available, otherwise fallback to global_obj
  target_base <- if (!is.null(raw_obj)) raw_obj else global_obj
  
  # Ensure percent.mt exists in baseline
  if (!"percent.mt" %in% colnames(target_base@meta.data)) {
    target_base[["percent.mt"]] <- PercentageFeatureSet(target_base, pattern = "^MT-")
  }
  
  # Calculate removal reasons for the summary cards
  raw_mt       <- target_base$percent.mt
  raw_features <- target_base$nFeature_RNA
  raw_counts   <- target_base$nCount_RNA
  
  removed_mt_count      <- sum(raw_mt >= mt_limit)
  removed_feature_count <- sum(raw_features <= feat_min | (feat_max < 1e9 & raw_features >= feat_max))
  removed_count_count   <- sum(raw_counts <= count_min)
  
  # Performance-optimized Seurat subsetting
  # We use the renamed variables (feat_min, etc.) to ensure Seurat looks at our local variables
  # rather than attempting to find columns with those exact names.
  tryCatch({
    temp_obj <- subset(target_base, 
                          subset = nFeature_RNA > feat_min & 
                                   nFeature_RNA < feat_max & 
                                   percent.mt < mt_limit &
                                   nCount_RNA > count_min)
    if (ncol(temp_obj) == 0) {
      stop("No cells passed the selected QC thresholds. Please loosen your filters.")
    }
    global_obj <<- temp_obj
  }, error = function(e) {
    stop("QC Filter Error: Likely no cells matched these thresholds. (", e$message, ")")
  })
  
  cells_after <- ncol(global_obj)
  
  make_provenance(
    result = list(
      message = "QC metrics calculated and cells filtered.",
      post_filter_cells = cells_after,
      removed_mt = removed_mt_count,
      removed_features = removed_feature_count,
      removed_counts = removed_count_count,
      removed_doublets = 0,
      median_mt = round(median(global_obj$percent.mt), 2)
    ),
    script_text = paste0("obj <- subset(obj, subset = nFeature_RNA > ", feat_min, " & nFeature_RNA < ", feat_max, " & percent.mt < ", mt_limit, " & nCount_RNA > ", count_min, ")"),
    operation = "quality-control",
    parameters = list(
      mt_threshold = mt_limit, 
      min_features = feat_min, 
      max_features = feat_max, 
      min_counts = count_min,
      summary = list(
        message = "QC metrics calculated and cells filtered.",
        post_filter_cells = cells_after,
        removed_mt = removed_mt_count,
        removed_features = removed_feature_count,
        removed_counts = removed_count_count,
        removed_doublets = 0,
        median_mt = round(median(global_obj$percent.mt), 2)
      )
    )
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 2: Normalization
# ──────────────────────────────────────────────────────────────────

#* Normalize data and find variable features
#* @get /normalize
function(res, method = "LogNormalize", scale_factor = 10000, nfeatures = 2000) {
  scale_factor <- as.numeric(scale_factor)
  nfeatures <- as.numeric(nfeatures)

  if (method == "SCTransform") {
    script <- paste0(
      "# SCTransform normalization\n",
      "obj <- SCTransform(obj, verbose = FALSE)\n"
    )
    if (is.null(global_obj)) return(list(error="No object"))
    global_obj <<- SCTransform(global_obj, verbose = FALSE)
  } else {
    script <- paste0(
      "# Log-normalize data\n",
      "obj <- NormalizeData(obj, normalization.method = '", method, "', scale.factor = ", scale_factor, ")\n",
      "# Identify highly variable features\n",
      "obj <- FindVariableFeatures(obj, selection.method = 'vst', nfeatures = ", nfeatures, ")\n"
    )
    if (is.null(global_obj)) return(list(error="No object"))
    global_obj <<- NormalizeData(global_obj, normalization.method = method, scale.factor = scale_factor)
    global_obj <<- FindVariableFeatures(global_obj, selection.method = "vst", nfeatures = nfeatures)
  }

  make_provenance(
    result = list(
      message = paste0("Normalization complete (", method, "). ", nfeatures, " variable features identified."),
      method = method,
      scale_factor = scale_factor,
      n_variable_features = length(VariableFeatures(global_obj))
    ),
    script_text = script,
    operation = "normalize",
    parameters = list(method = method, scale_factor = scale_factor, nfeatures = nfeatures)
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 2.5: Batch Integration (Optional)
# ──────────────────────────────────────────────────────────────────

#* Batch integration using Harmony or Seurat CCA
#* @get /integrate
function(res, method = "harmony", batch_col = "orig.ident", seed = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded. Please run Normalization first."))
  if (!batch_col %in% colnames(global_obj@meta.data)) {
    return(list(error = paste0("Batch column '", batch_col, "' not found in metadata. Available columns: ",
                               paste(colnames(global_obj@meta.data), collapse = ", "))))
  }

  batch_vals <- unique(as.character(global_obj@meta.data[[batch_col]]))
  if (length(batch_vals) < 2) {
    return(list(error = paste0("Batch column '", batch_col, "' has only one unique value (",
                               batch_vals[1], "). Integration requires at least 2 batches.")))
  }

  if (is.null(seed) || seed == "" || is.na(as.integer(seed))) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- as.integer(seed)
  }

  tryCatch({
    if (tolower(method) == "harmony") {
      # ── Harmony Integration ─────────────────────────────────────────
      if (!requireNamespace("harmony", quietly = TRUE)) {
        return(list(error = paste0(
          "The 'harmony' package is required for Harmony integration.\n",
          "Install with: install.packages('harmony')"
        )))
      }
      library(harmony)

      # Ensure PCA exists; compute it if missing
      if (!"pca" %in% names(global_obj@reductions)) {
        cat("[Integrate] PCA not found — running ScaleData + RunPCA before Harmony...\n")
        global_obj <<- ScaleData(global_obj, features = rownames(global_obj), verbose = FALSE)
        set.seed(used_seed)
        global_obj <<- RunPCA(global_obj, features = VariableFeatures(object = global_obj),
                               npcs = 50, seed.use = used_seed, verbose = FALSE)
      }

      cat("[Integrate] Running Harmony on batch column '", batch_col, "'...\n")
      set.seed(used_seed)
      global_obj <<- RunHarmony(global_obj, group.by.vars = batch_col, reduction = "pca",
                                 reduction.save = "harmony", verbose = FALSE)

      script_text <- paste0(
        "library(harmony)\n",
        "# Ensure PCA is computed\n",
        "obj <- ScaleData(obj, features = rownames(obj))\n",
        "obj <- RunPCA(obj, features = VariableFeatures(obj), npcs = 50, seed.use = ", used_seed, ")\n",
        "# Run Harmony integration\n",
        "set.seed(", used_seed, ")\n",
        "obj <- RunHarmony(obj, group.by.vars = '", batch_col, "', reduction = 'pca', reduction.save = 'harmony')\n"
      )

      make_provenance(
        result = list(
          message   = paste0("Harmony integration complete on batch column '", batch_col, "' (",
                              length(batch_vals), " batches: ", paste(batch_vals, collapse = ", "), ")."),
          method    = "harmony",
          batch_col = batch_col,
          batches   = as.list(batch_vals),
          reduction = "harmony",
          n_cells   = ncol(global_obj)
        ),
        script_text   = script_text,
        operation     = "integrate",
        packages_used = c("Seurat", "harmony"),
        parameters    = list(method = "harmony", batch_col = batch_col, seed = used_seed)
      )

    } else if (tolower(method) == "cca") {
      # ── CCA Integration ─────────────────────────────────────────────
      cat("[Integrate] Running Seurat CCA integration on batch column '", batch_col, "'...\n")

      # Split object by batch
      obj_list <- SplitObject(global_obj, split.by = batch_col)
      cat("[Integrate] Split into", length(obj_list), "objects.\n")

      # Normalize and find variable features per batch
      obj_list <- lapply(obj_list, function(obj) {
        obj <- NormalizeData(obj, verbose = FALSE)
        obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 2000, verbose = FALSE)
        obj
      })

      # Select integration features and find anchors
      features <- SelectIntegrationFeatures(object.list = obj_list)
      anchors  <- FindIntegrationAnchors(object.list = obj_list, anchor.features = features, verbose = FALSE)

      # Integrate data
      global_obj <<- IntegrateData(anchorset = anchors, verbose = FALSE)

      # Switch to integrated assay and re-run scaling + PCA
      DefaultAssay(global_obj) <<- "integrated"
      global_obj <<- ScaleData(global_obj, verbose = FALSE)
      set.seed(used_seed)
      global_obj <<- RunPCA(global_obj, npcs = 50, seed.use = used_seed, verbose = FALSE)

      script_text <- paste0(
        "# Seurat CCA Integration\n",
        "obj_list <- SplitObject(obj, split.by = '", batch_col, "')\n",
        "obj_list <- lapply(obj_list, function(x) {\n",
        "  x <- NormalizeData(x)\n",
        "  x <- FindVariableFeatures(x, selection.method = 'vst', nfeatures = 2000)\n",
        "})\n",
        "features <- SelectIntegrationFeatures(object.list = obj_list)\n",
        "anchors  <- FindIntegrationAnchors(object.list = obj_list, anchor.features = features)\n",
        "obj <- IntegrateData(anchorset = anchors)\n",
        "DefaultAssay(obj) <- 'integrated'\n",
        "obj <- ScaleData(obj)\n",
        "obj <- RunPCA(obj, npcs = 50, seed.use = ", used_seed, ")\n"
      )

      make_provenance(
        result = list(
          message   = paste0("CCA integration complete on batch column '", batch_col, "' (",
                              length(batch_vals), " batches: ", paste(batch_vals, collapse = ", "), ")."),
          method    = "cca",
          batch_col = batch_col,
          batches   = as.list(batch_vals),
          reduction = "pca",  # CCA uses pca on integrated assay
          n_cells   = ncol(global_obj)
        ),
        script_text   = script_text,
        operation     = "integrate",
        packages_used = c("Seurat"),
        parameters    = list(method = "cca", batch_col = batch_col, seed = used_seed)
      )

    } else {
      list(error = paste0("Unknown integration method: '", method, "'. Use 'harmony' or 'cca'."))
    }
  }, error = function(e) { res$status <- 500; list(error = paste("Integration failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 3: PCA
# ──────────────────────────────────────────────────────────────────

#* Run PCA on scaled data
#* @get /pca
function(res, npcs = 50, seed = "") {
  npcs <- as.integer(npcs)

  if (is.null(global_obj)) return(list(error="No object"))
  
  # Auto-clamp parameters (max 100 to prevent math timeouts)
  npcs <- min(npcs, ncol(global_obj) - 1, nrow(global_obj) - 1, 100, na.rm = TRUE)
  if (npcs < 2) stop("Insufficient cells or features to run PCA.")

  if (is.null(seed) || seed == "" || is.na(as.integer(seed))) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- as.integer(seed)
  }

  script <- paste0(
    "# Set seed for reproducibility\n",
    "set.seed(", used_seed, ")\n",
    "# Scale the data\n",
    "obj <- ScaleData(obj, features = rownames(object = obj))\n",
    "# Run PCA\n",
    "obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = ", npcs, ", seed.use = ", used_seed, ")\n"
  )
  
  tryCatch({
    global_obj <<- ScaleData(global_obj, features = rownames(global_obj))
    set.seed(used_seed)
    global_obj <<- RunPCA(global_obj, features = VariableFeatures(object = global_obj), npcs = npcs, seed.use = used_seed, verbose=FALSE)

    # Extract true standard deviations safely
    actual_pcs <- length(global_obj[["pca"]]@stdev)
    stdevs <- global_obj[["pca"]]@stdev[1:min(npcs, actual_pcs)]
    
    # Extract top 5 positive and top 5 negative gene loadings for top 5 PCs safely
    ld <- Loadings(global_obj, "pca")
    loadings <- list()
    for (i in 1:min(5, actual_pcs)) {
      pc_name <- paste0("PC_", i)
      srt_pos <- sort(ld[, pc_name], decreasing=TRUE)
      srt_neg <- sort(ld[, pc_name], decreasing=FALSE)
      top_genes <- c(names(srt_pos)[1:5], names(srt_neg)[1:5])
      loadings[[paste0("PC", i)]] <- top_genes
    }

    make_provenance(
      result = list(
        message = paste0("PCA completed with ", npcs, " components."),
        npcs = npcs,
        stdevs = stdevs,
        gene_loadings = loadings
      ),
      script_text = script,
      operation = "pca",
      parameters = list(npcs = npcs, seed = used_seed)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("PCA failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 4: Clustering
# ──────────────────────────────────────────────────────────────────

#* Find neighbors and cluster cells
#* @get /cluster
function(res, dims = 15, resolution = 0.8, algorithm = 1, seed = "") {
  dims <- as.integer(dims)
  resolution <- as.numeric(resolution)
  algorithm <- as.integer(algorithm)
  algo_name <- if (algorithm == 4) "Leiden" else "Louvain"

  if (is.null(global_obj)) return(list(error="No object"))

  if (is.null(seed) || seed == "" || is.na(as.integer(seed))) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- as.integer(seed)
  }

  # Fallback if Leiden is requested but packages are missing
  if (algorithm == 4 && (!requireNamespace("leiden", quietly = TRUE) || !requireNamespace("reticulate", quietly = TRUE))) {
    cat("[WARN] Leiden packages missing, falling back to Louvain.\n")
    algorithm <- 1
    algo_name <- "Louvain"
  }

  # Auto-detect best reduction: use harmony if available, otherwise pca
  use_reduction <- if ("harmony" %in% names(global_obj@reductions)) "harmony" else "pca"
  if (!use_reduction %in% names(global_obj@reductions)) stop(paste("Reduction", use_reduction, "not found. Run PCA first."))
  
  # Clamp dims
  available_dims <- ncol(Embeddings(global_obj, use_reduction))
  dims <- min(dims, available_dims)

  cat("[Cluster] Using reduction:", use_reduction, "with", dims, "dims\n")

  script <- paste0(
    "# Set seed for reproducibility\n",
    "set.seed(", used_seed, ")\n",
    "# Find neighbors (reduction: ", use_reduction, ")\n",
    "obj <- FindNeighbors(obj, reduction = '", use_reduction, "', dims = 1:", dims, ")\n",
    "# Cluster cells\n",
    "obj <- FindClusters(obj, algorithm = ", algorithm, ", resolution = ", resolution, ", random.seed = ", used_seed, ")\n"
  )

  set.seed(used_seed)
  global_obj <<- FindNeighbors(global_obj, reduction = use_reduction, dims = 1:dims)
  global_obj <<- FindClusters(global_obj, algorithm = algorithm, resolution = resolution, random.seed = used_seed)

  # Read actual cluster outcomes
  cluster_counts <- table(global_obj$seurat_clusters)
  
  make_provenance(
    result = list(
      message = paste0(algo_name, " clustering complete. ", length(cluster_counts), " clusters identified."),
      n_clusters = length(cluster_counts),
      cluster_names = as.list(paste0("Cluster ", names(cluster_counts))),
      cluster_sizes = as.list(as.integer(cluster_counts)),
      algorithm = algo_name,
      resolution = resolution,
      dims_used = dims
    ),
    script_text = script,
    operation = "cluster",
    parameters = list(
      dims = dims, 
      resolution = resolution, 
      algorithm = algorithm, 
      algorithm_name = algo_name, 
      seed = used_seed,
      n_clusters = length(cluster_counts)
    )
  )
}

# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP 5: UMAP
# ──────────────────────────────────────────────────────────────────

#* Run UMAP dimensionality reduction
#* @get /umap
function(res, dims = 15, n_components = 2, n_neighbors = 30, min_dist = 0.3, seed = "") {
  dims <- as.integer(dims)
  n_components <- as.integer(n_components)
  n_neighbors <- as.integer(n_neighbors)
  min_dist <- as.numeric(min_dist)

  # Null-check BEFORE accessing any slots on global_obj
  if (is.null(global_obj)) return(list(error = "No object loaded. Please reload and rerun the pipeline."))

  n_neighbors <- min(n_neighbors, ncol(global_obj) - 1, na.rm = TRUE)
  if (n_neighbors < 2) stop("Insufficient cells for UMAP.")

  if (is.null(seed) || seed == "" || is.na(as.integer(seed))) {
    used_seed <- sample.int(100000, 1)
  } else {
    used_seed <- as.integer(seed)
  }

  # Auto-detect best reduction: use harmony if available, otherwise pca
  use_reduction <- if ("harmony" %in% names(global_obj@reductions)) "harmony" else "pca"
  cat("[UMAP] Using reduction:", use_reduction, "| reductions on obj:", paste(names(global_obj@reductions), collapse=", "), "\n")

  tryCatch({
    # Verify the required reduction actually exists
    if (!use_reduction %in% names(global_obj@reductions)) {
      return(list(error = paste0("'", use_reduction, "' reduction not found. Please re-run the PCA step before computing UMAP.")))
    }

    # Clamp dims to the number of embeddings actually computed
    available_dims <- ncol(Embeddings(global_obj, use_reduction))
    if (dims > available_dims) {
      cat("[WARN] Requested", dims, "dims but only", available_dims, "available. Clamping.\n")
      dims <- available_dims
    }

    script <- paste0(
      "# Set seed for reproducibility\n",
      "set.seed(", used_seed, ")\n",
      "# Run UMAP\n",
      "obj <- RunUMAP(obj, reduction = '", use_reduction, "', dims = 1:", dims, ", n.components = ", n_components, "L",
      ", n.neighbors = ", n_neighbors, ", min.dist = ", min_dist, ", seed.use = ", used_seed, ")\n"
    )

    set.seed(used_seed)
    global_obj <<- RunUMAP(global_obj, reduction = use_reduction, dims = 1:dims,
                           n.components = n_components,
                           n.neighbors = n_neighbors, min.dist = min_dist, seed.use = used_seed)

    emb <- Embeddings(global_obj, "umap")
    clusts <- Idents(global_obj)

    trace_data <- lapply(levels(clusts), function(cl) {
      idx <- which(clusts == cl)
      name_val <- if (grepl("^[0-9]+$", as.character(cl))) paste("Cluster", cl) else as.character(cl)
      el <- list(
        name = name_val,
        x = as.numeric(emb[idx, 1]),
        y = as.numeric(emb[idx, 2])
      )
      if (n_components >= 3) {
        el$z = as.numeric(emb[idx, 3])
      }
      return(el)
    })

    make_provenance(
      result = list(
        message = paste0("UMAP computed (", n_components, "D)."),
        n_components = n_components,
        n_neighbors = n_neighbors,
        min_dist = min_dist,
        trace_data = trace_data
      ),
      script_text = script,
      operation = "umap",
      parameters = list(dims = dims, n_components = n_components, n_neighbors = n_neighbors, min_dist = min_dist, seed = used_seed)
    )
  }, error = function(e) { res$status <- 500; list(error = paste("UMAP failed:", e$message))
  })
}

#* Annotate clusters with biological cell types
#* @post /annotate-clusters
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded."))
  
  tryCatch({
    body <- jsonlite::fromJSON(req$postBody)
    mappings <- body$mappings
    
    if (is.null(mappings) || length(mappings) == 0) {
      stop("No mappings provided.")
    }
    
    if (!"seurat_clusters" %in% colnames(global_obj@meta.data)) {
      stop("Dataset has not been clustered (missing seurat_clusters).")
    }
    
    new_ids <- as.character(mappings)
    names(new_ids) <- names(mappings)
    
    script <- paste0(
      "# Reset and rename cluster identities\n",
      "Idents(obj) <- obj$seurat_clusters\n",
      "new_ids <- c(", paste(paste0('"', names(mappings), '"="', mappings, '"'), collapse=", "), ")\n",
      "obj <- RenameIdents(obj, new_ids)\n",
      "obj$cell_type <- Idents(obj)\n"
    )
    
    Idents(global_obj) <<- global_obj$seurat_clusters
    global_obj <<- RenameIdents(global_obj, new_ids)
    global_obj$cell_type <<- Idents(global_obj)
    
    make_provenance(
      result = list(
        message = "Clusters successfully annotated.",
        annotations = mappings
      ),
      script_text = script,
      operation = "annotate"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Annotation failed:", e$message))
  })
}

# ──────────────────────────────────────────────────────────────────
# ANALYSIS: Gene list
# ──────────────────────────────────────────────────────────────────

#* Get full gene list from the Seurat object
#* @get /genes
function(res) {
  if (is.null(global_obj)) {
    genes <- c("CD3E","CD4","CD8A","MS4A1","LYZ") 
  } else {
    genes <- rownames(global_obj)
  }
  list(genes = genes, count = length(genes))
}

#* Get expression data for a specific gene
#* @get /gene-expression
function(res, gene) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  if (!(gene %in% rownames(global_obj))) return(list(error = "Gene not found in dataset"))
  
  # Fetch expression
  expr_data <- FetchData(global_obj, vars = gene)
  expr_data$ident <- Idents(global_obj)
  umap_coords <- tryCatch(Embeddings(global_obj, "umap"), error = function(e) NULL)
  
  res <- list(
    gene = gene,
    expression = as.numeric(expr_data[[gene]]),
    clusters = as.character(expr_data$ident)
  )
  
  if (!is.null(umap_coords)) {
    res$u1 <- as.numeric(umap_coords[,1])
    res$u2 <- as.numeric(umap_coords[,2])
  }
  
  res
}

#* Feature values for a gene overlaid on UMAP
#* @get /feature-values
function(res, gene) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  if (!(gene %in% rownames(global_obj))) return(list(error = paste("Gene not found:", gene)))
  umap_coords <- tryCatch(Embeddings(global_obj, "umap"), error = function(e) NULL)
  if (is.null(umap_coords)) return(list(error = "UMAP not computed yet. Run the UMAP step first."))
  expr <- as.numeric(FetchData(global_obj, vars = gene)[[gene]])
  list(
    gene = gene,
    expression = expr,
    u1 = as.numeric(umap_coords[, 1]),
    u2 = as.numeric(umap_coords[, 2])
  )
}

#* Top marker gene heatmap data (avg expression per cluster)
#* @get /heatmap
function(res, top_n = 5) {
  top_n <- as.integer(top_n)
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  if (length(levels(Idents(global_obj))) < 2) return(list(error = "Clustering required"))
  tryCatch({
    suppressMessages({ library(dplyr) })
    markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.1, logfc.threshold = 0.25, verbose = FALSE)
    if (is.null(markers) || nrow(markers) == 0) return(list(error = "No marker genes found."))
    top_genes <- as.data.frame(markers) %>%
      group_by(cluster) %>%
      top_n(n = top_n, wt = avg_log2FC) %>%
      pull(gene) %>% unique()
    avg_mat <- AverageExpression(global_obj, features = top_genes, assays = "RNA")$RNA
    z_list <- lapply(seq_len(nrow(avg_mat)), function(i) as.numeric(avg_mat[i, ]))
    list(
      genes    = rownames(avg_mat),
      clusters = colnames(avg_mat),
      z        = z_list
    )
  }, error = function(e) list(error = paste("Heatmap failed:", e$message)))
}

#* Dot plot data — pct expressing and avg expression per cluster per gene
#* @get /dot-plot
function(res, genes = "") {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  if (length(levels(Idents(global_obj))) < 2) return(list(error = "Clustering required"))
  gene_vec <- trimws(strsplit(genes, ",")[[1]])
  gene_vec <- gene_vec[gene_vec != ""]
  if (length(gene_vec) == 0) return(list(error = "No genes provided"))
  missing <- gene_vec[!gene_vec %in% rownames(global_obj)]
  if (length(missing) > 0) return(list(error = paste("Genes not found:", paste(missing, collapse = ", "))))
  tryCatch({
    clusters <- levels(Idents(global_obj))
    avg_list <- vector("list", length(gene_vec))
    pct_list <- vector("list", length(gene_vec))
    for (gi in seq_along(gene_vec)) {
      g <- gene_vec[gi]
      expr <- as.numeric(FetchData(global_obj, vars = g)[[g]])
      idents <- as.character(Idents(global_obj))
      avg_row <- sapply(clusters, function(cl) mean(expr[idents == cl]))
      pct_row <- sapply(clusters, function(cl) mean(expr[idents == cl] > 0))
      avg_list[[gi]] <- as.numeric(avg_row)
      pct_list[[gi]] <- as.numeric(pct_row)
    }
    list(genes = gene_vec, clusters = clusters, avg_expr = avg_list, pct_expr = pct_list)
  }, error = function(e) list(error = paste("Dot plot failed:", e$message)))
}

# ──────────────────────────────────────────────────────────────────
# Remaining Mock Analysis Endpoints
# ──────────────────────────────────────────────────────────────────

#* Infer Cell-Cell Communication (CellChat)
#* @get /cellchat
function(res) {
  make_provenance(result = list(active_pathways=c("WNT")), script_text="Mock", operation="cellchat")
}

#* Find cluster marker genes (DEG)
#* @get /deg
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  
  if (length(levels(Idents(global_obj))) < 2) {
    return(list(error = "Cannot find markers: Dataset only has one identity group. Please run Clustering first."))
  }

  script <- "markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25)"
  
  tryCatch({
    # Execute
    markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25)
    
    # Format markers for frontend table safely (seq_len avoids 1:0 looping)
    marker_list <- list()
    if (!is.null(markers) && nrow(markers) > 0) {
      marker_list <- lapply(seq_len(nrow(markers)), function(i) {
        list(
          gene = as.character(markers$gene[i]),
          cluster = as.character(markers$cluster[i]),
          p_val = markers$p_val_adj[i],
          log2FC = round(markers$avg_log2FC[i], 2),
          pct1 = markers$pct.1[i],
          pct2 = markers$pct.2[i]
        )
      })
    }
    
    # Prep Heatmap Data (Top 5 per cluster for visual clarity)
    heatmap_genes <- character(0)
    heatmap_clusters <- character(0)
    heatmap_z <- list()
    
    if (!is.null(markers) && nrow(markers) > 0) {
      suppressMessages({
        library(dplyr)
        top5 <- as.data.frame(markers) %>% group_by(cluster) %>% top_n(n = 5, wt = avg_log2FC)
        unique_genes <- unique(top5$gene)
        unique_genes <- intersect(unique_genes, rownames(global_obj))
        assay_use <- if ("RNA" %in% Assays(global_obj)) "RNA" else DefaultAssay(global_obj)
        avg_expr <- AverageExpression(global_obj, features = unique_genes, group.by = "seurat_clusters", assays = assay_use)[[assay_use]]
        
        # Convert matrix to row-major list for Plotly heatmap (z-attribute)
        heatmap_z <- lapply(1:nrow(avg_expr), function(i) as.numeric(avg_expr[i,]))
        heatmap_genes <- rownames(avg_expr)
        heatmap_clusters <- colnames(avg_expr)
      })
    }
    
    make_provenance(
      result = list(
        message = "Differential expression identification complete.",
        total_markers = if(is.null(markers)) 0 else nrow(markers),
        markers = marker_list,
        heatmap = list(
          genes = heatmap_genes,
          clusters = heatmap_clusters,
          z = heatmap_z
        )
      ),
      script_text = script,
      operation = "deg"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("DEG failed:", e$message))
  })
}

#* Pathway Enrichment using clusterProfiler (ORA)
#* @get /enrichment
function(res, database = "GO_BP", pval_cutoff = 0.05, logfc_threshold = 0.25, top_n = 20, target_cluster = "all", exclude_artifacts = "true") {
  pval_cutoff    <- as.numeric(pval_cutoff)
  logfc_threshold <- as.numeric(logfc_threshold)
  top_n          <- as.integer(top_n)
  exclude_artifacts <- as.logical(exclude_artifacts)

  if (is.null(global_obj)) return(list(error = "No object loaded"))

  if (length(levels(Idents(global_obj))) < 2) {
    return(list(error = "Dataset only has one identity group. Please run Clustering first."))
  }

  # ── Species Auto-Detection ─────────────────────────────────
  is_mouse <- any(grepl("^[A-Z][a-z]+", rownames(global_obj)[1:20]))
  org_pkg <- if (is_mouse) "org.Mm.eg.db" else "org.Hs.eg.db"
  kegg_org <- if (is_mouse) "mmu" else "hsa"
  reactome_org <- if (is_mouse) "mouse" else "human"

  # ── Package availability checks ──────────────────────────────
  missing_pkgs <- character(0)
  if (!requireNamespace("clusterProfiler", quietly = TRUE)) missing_pkgs <- c(missing_pkgs, "clusterProfiler")
  if (!requireNamespace(org_pkg,   quietly = TRUE)) missing_pkgs <- c(missing_pkgs, org_pkg)
  if (database == "Reactome" && !requireNamespace("ReactomePA", quietly = TRUE)) missing_pkgs <- c(missing_pkgs, "ReactomePA")

  if (length(missing_pkgs) > 0) {
    install_cmd <- paste0('BiocManager::install(c("', paste(missing_pkgs, collapse = '", "'), '"))')
    return(list(error = paste0(
      "Required Bioconductor packages not installed: ", paste(missing_pkgs, collapse = ", "),
      ".\nInstall with:\n  if (!requireNamespace('BiocManager', quietly=TRUE)) install.packages('BiocManager')\n  ", install_cmd
    )))
  }

  tryCatch({
    suppressMessages({
      library(clusterProfiler)
      library(org_pkg, character.only = TRUE)
      if (database == "Reactome") library(ReactomePA)
    })

    # ── Step 1: Find marker genes ────────────────────────────
    if (!is.null(target_cluster) && target_cluster != "all") {
      cat("[Enrichment] Running FindMarkers for cluster", target_cluster, "(logfc.threshold =", logfc_threshold, ")...\n")
      if (!target_cluster %in% levels(Idents(global_obj))) {
        return(list(error = paste("Cluster", target_cluster, "not found.")))
      }
      markers <- FindMarkers(
        global_obj,
        ident.1       = target_cluster,
        only.pos      = TRUE,
        min.pct       = 0.1,
        logfc.threshold = logfc_threshold,
        verbose       = FALSE
      )
      if (!is.null(markers) && nrow(markers) > 0) {
        markers$gene <- rownames(markers)
      }
    } else {
      cat("[Enrichment] Running FindAllMarkers (logfc.threshold =", logfc_threshold, ")...\n")
      markers <- FindAllMarkers(
        global_obj,
        only.pos      = TRUE,
        min.pct       = 0.1,
        logfc.threshold = logfc_threshold,
        verbose       = FALSE
      )
    }

    if (is.null(markers) || nrow(markers) == 0) {
      return(list(error = "No marker genes found. Try lowering logfc.threshold or running Clustering first."))
    }

    if (isTRUE(exclude_artifacts)) {
      cat("[Enrichment] Excluding MT- and RPL/RPS artifact genes...\n")
      markers <- markers[!grepl("^(MT-|RPL|RPS)", markers$gene, ignore.case = TRUE), ]
      if (nrow(markers) == 0) {
        return(list(error = "No marker genes left after excluding mitochondrial and ribosomal genes."))
      }
    }

    # Deduplicated top marker genes (sorted by avg_log2FC)
    markers_sorted <- markers[order(-markers$avg_log2FC), ]
    gene_symbols   <- unique(markers_sorted$gene)
    cat("[Enrichment] Using", length(gene_symbols), "unique marker genes as input.\n")

    # ── Step 2: Symbol → Entrez ID mapping ──────────────────
    entrez_map <- suppressMessages(
      bitr(gene_symbols,
           fromType = "SYMBOL",
           toType   = "ENTREZID",
           OrgDb    = get(org_pkg))
    )
    if (nrow(entrez_map) == 0) {
      return(list(error = "Could not map any gene symbols to Entrez IDs. Check that genes follow HGNC nomenclature."))
    }
    entrez_ids <- unique(entrez_map$ENTREZID)

    # Universe = all genes in the object mapped to Entrez
    universe_map <- suppressMessages(
      bitr(rownames(global_obj),
           fromType = "SYMBOL",
           toType   = "ENTREZID",
           OrgDb    = get(org_pkg))
    )
    entrez_universe <- unique(universe_map$ENTREZID)
    cat("[Enrichment] Mapped", length(entrez_ids), "/", length(gene_symbols), "genes to Entrez IDs.\n")

    # ── Step 3: ORA dispatch ──────────────────────────────────
    script_text <- paste0(
      "markers <- FindAllMarkers(obj, only.pos=TRUE, logfc.threshold=", logfc_threshold, ")\n",
      "entrez  <- bitr(unique(markers$gene), fromType='SYMBOL', toType='ENTREZID', OrgDb=", org_pkg, ")\n"
    )

    ora_result <- NULL

    if (database == "Reactome") {
      script_text <- paste0(script_text,
                            "ora <- enrichPathway(entrez$ENTREZID, organism='human', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running ReactomePA::enrichPathway...\n")
      ora_result <- suppressMessages(
        ReactomePA::enrichPathway(
          gene          = entrez_ids,
          universe      = entrez_universe,
          organism      = reactome_org,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH",
          readable      = TRUE
        )
      )

    } else if (database == "KEGG") {
      script_text <- paste0(script_text,
                            "ora <- enrichKEGG(entrez$ENTREZID, organism='hsa', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running clusterProfiler::enrichKEGG...\n")
      ora_result <- suppressMessages(
        enrichKEGG(
          gene          = entrez_ids,
          universe      = entrez_universe,
          organism      = kegg_org,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH"
        )
      )

    } else {
      # GO_BP or GO_MF
      ont <- if (database == "GO_MF") "MF" else "BP"
      script_text <- paste0(script_text,
                            "ora <- enrichGO(entrez$ENTREZID, OrgDb=org.Hs.eg.db, ont='", ont, "', pvalueCutoff=", pval_cutoff, ")\n")
      cat("[Enrichment] Running clusterProfiler::enrichGO (ont=", ont, ")...\n")
      ora_result <- suppressMessages(
        enrichGO(
          gene          = entrez_ids,
          universe      = entrez_universe,
          OrgDb         = get(org_pkg),
          ont           = ont,
          pvalueCutoff  = pval_cutoff,
          pAdjustMethod = "BH",
          readable      = TRUE,
          minGSSize     = 5,
          maxGSSize     = 500
        )
      )
    }

    # ── Step 4: Format results ───────────────────────────────
    if (is.null(ora_result) || nrow(as.data.frame(ora_result)) == 0) {
      return(list(error = paste0(
        "No significant pathways found in ", database,
        " at p-adj < ", pval_cutoff,
        ". Try increasing pval_cutoff, lowering logfc_threshold, or choosing a different database."
      )))
    }

    df <- as.data.frame(ora_result)
    df <- df[order(df$p.adjust), ]
    if (nrow(df) > top_n) df <- df[1:top_n, ]

    top_pathways <- lapply(seq_len(nrow(df)), function(i) {
      ratio_str   <- as.character(df$GeneRatio[i])
      ratio_parts <- strsplit(ratio_str, "/")[[1]]
      ratio_num   <- if (length(ratio_parts) == 2) as.numeric(ratio_parts[1]) / as.numeric(ratio_parts[2]) else NA

      list(
        name          = as.character(df$Description[i]),
        id            = as.character(df$ID[i]),
        count         = as.integer(df$Count[i]),
        ratio         = ratio_str,
        gene_ratio_num = round(ratio_num, 4),
        p_adj         = as.numeric(df$p.adjust[i]),
        database      = database,
        genes         = as.character(df$geneID[i])  # "/" separated in clusterProfiler
      )
    })

    make_provenance(
      result = list(
        message           = paste0("ORA complete: ", length(top_pathways), " pathways enriched (", database, ")."),
        top_pathways      = top_pathways,
        gene_universe_size = length(entrez_universe),
        n_input_genes     = length(entrez_ids),
        database          = database
      ),
      script_text = script_text,
      operation   = "enrichment",
      packages_used = c("Seurat", "clusterProfiler", "org.Hs.eg.db"),
      parameters  = list(database = database, pval_cutoff = pval_cutoff,
                         logfc_threshold = logfc_threshold, top_n = top_n)
    )

  }, error = function(e) { res$status <- 500; list(error = paste("Enrichment failed:", e$message))
  })
}
# ──────────────────────────────────────────────────────────────────
# PIPELINE STEP: CellChat Inference
# ──────────────────────────────────────────────────────────────────

#* Run CellChat inference on the current Seurat object
#* @post /cellchat-infer
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  
  body <- req$body
  group_by <- body$group_by
  database <- body$database # "human" or "mouse"
  
  if (is.null(group_by)) group_by <- "seurat_clusters"
  if (!group_by %in% colnames(global_obj@meta.data)) {
    return(list(error = paste("Grouping column not found:", group_by)))
  }
  
  tryCatch({
    if (!requireNamespace("CellChat", quietly = TRUE)) {
      stop("CellChat package is not installed. Please install it via the Diagnostics tab.")
    }
    library(CellChat)
    
    # ── Step 1: Prep Data ──────────────────────────────────────
    # CellChat requires normalized data
    data.input <- GetAssayData(global_obj, assay = "RNA", layer = "data")
    meta <- global_obj@meta.data
    
    # CellChat v2 rejects group labels that are purely numeric or start with "0"
    # (e.g. default seurat_clusters values "0", "1", "2", ...).
    # Remap to "Cluster 1", "Cluster 2", ... before passing to CellChat, and
    # record the mapping so we can restore original names in the output.
    orig_labels <- as.character(meta[[group_by]])
    unique_orig <- sort(unique(orig_labels))
    label_needs_remap <- any(grepl("^0$|^[0-9]+$", unique_orig))
    if (label_needs_remap) {
      label_map <- setNames(paste0("Cluster", seq_along(unique_orig)), unique_orig)
      meta[[group_by]] <- factor(label_map[orig_labels], levels = label_map)
      cat("[CellChat] Remapped numeric cluster labels to avoid CellChat v2 '0' restriction.\n")
    } else {
      meta[[group_by]] <- as.factor(meta[[group_by]])
    }
    
    cat("[CellChat] Creating CellChat object...\n")
    cellchat <- createCellChat(object = data.input, meta = meta, group.by = group_by)

    
    # ── Step 2: Set Database ───────────────────────────────────
    if (database == "mouse") {
      CellChatDB <- CellChatDB.mouse
    } else {
      CellChatDB <- CellChatDB.human
    }
    
    # Use the default secreted signaling + ECM + Cell-Cell Contact
    # Alternatively use the whole database:
    CellChatDB.use <- CellChatDB 
    cellchat@DB <- CellChatDB.use
    
    # ── Step 3: Preprocessing ──────────────────────────────────
    cat("[CellChat] Preprocessing...\n")
    
    tryCatch({
      cellchat <- subsetData(cellchat) # subsets expression data to signaling genes
    }, error = function(e) {
      if (grepl("numeric", e$message) || grepl("AnyMatrix", e$message)) {
        stop("Too few signaling genes (1) were found in your dataset, causing CellChat to fail. Ensure your dataset uses Gene Symbols (not Ensembl IDs) or has enough genes.")
      }
      stop(paste("CellChat subsetData failed:", e$message))
    })
    
    if (nrow(cellchat@data.signaling) < 5) {
      stop(paste("Only", nrow(cellchat@data.signaling), "signaling genes overlap with the CellChat database. Ensure your dataset uses Gene Symbols instead of Ensembl IDs, and contains enough genes."))
    }
    
    # For small datasets, min.cells = 1 or 5 might be needed
    cellchat <- identifyOverExpressedGenes(cellchat)
    cellchat <- identifyOverExpressedInteractions(cellchat)
    
    # ── Step 4: Inference ──────────────────────────────────────
    cat("[CellChat] Inferring communication probabilities...\n")
    # computeCommunProb can be slow on large datasets
    cellchat <- computeCommunProb(cellchat, raw.use = TRUE, population.size = TRUE)
    
    # Filter out communications with few cells
    # Use min.cells = 10 by default, but lower it if the smallest group is smaller
    group_sizes <- table(meta[[group_by]])
    min_size <- min(group_sizes[group_sizes > 0]) # min size of present groups
    min_cells_filter <- min(10, min_size)
    
    cat(sprintf("[CellChat] Filtering communications (min.cells = %d)\n", min_cells_filter))
    cellchat <- filterCommunication(cellchat, min.cells = min_cells_filter)
    
    # Pathway level inference
    cellchat <- computeCommunProbPathway(cellchat)
    # Aggregate networks
    cellchat <- aggregateNet(cellchat)
    
    # ── Step 5: Format Output ──────────────────────────────────
    # We will return the aggregated network matrices as an edge list
    net_weight <- cellchat@net$weight
    
    edges <- list()
    if (is.null(net_weight) || length(net_weight) == 0) {
      nodes <- character(0)
    } else {
      nodes <- rownames(net_weight)
      
      for(i in seq_along(nodes)) {
        for(j in seq_along(nodes)) {
          w <- net_weight[i, j]
          if (!is.na(w) && w > 0) {
            edges[[length(edges) + 1]] <- list(
              source = nodes[i],
              target = nodes[j],
              weight = w
            )
          }
        }
      }
    }
    
    make_provenance(
      result = list(
        message = paste("CellChat inference complete on", length(nodes), "groups."),
        nodes = as.list(nodes),
        edges = edges,
        database = database
      ),
      script_text = paste0(
        "library(CellChat)\n",
        "cellchat <- createCellChat(object = obj, group.by = '", group_by, "')\n",
        "cellchat@DB <- CellChatDB.", database, "\n",
        "cellchat <- subsetData(cellchat)\n",
        "cellchat <- identifyOverExpressedGenes(cellchat)\n",
        "cellchat <- identifyOverExpressedInteractions(cellchat)\n",
        "cellchat <- computeCommunProb(cellchat, raw.use = TRUE)\n",
        "cellchat <- filterCommunication(cellchat, min.cells = 10)\n",
        "cellchat <- computeCommunProbPathway(cellchat)\n",
        "cellchat <- aggregateNet(cellchat)\n"
      ),
      operation = "cellchat",
      packages_used = c("Seurat", "CellChat"),
      parameters = list(group_by = group_by, database = database)
    )
    
  }, error = function(e) { res$status <- 500; list(error = paste("CellChat inference failed:", e$message))
  })
}


# ──────────────────────────────────────────────────────────────────
# PUBLICATION: Figure Export Helper
# ──────────────────────────────────────────────────────────────────

# Resolve a color palette by name, with ggsci optional + fallback to RColorBrewer
get_pub_palette <- function(name, n) {
  ggsci_map <- list(
    npg    = "ggsci::pal_npg",
    nejm   = "ggsci::pal_nejm",
    lancet = "ggsci::pal_lancet",
    jama   = "ggsci::pal_jama",
    aaas   = "ggsci::pal_aaas",
    d3     = "ggsci::pal_d3"
  )

  if (name %in% names(ggsci_map)) {
    if (requireNamespace("ggsci", quietly = TRUE)) {
      tryCatch({
        fn_name <- sub("ggsci::", "", ggsci_map[[name]])
        pal_fn  <- getExportedValue("ggsci", fn_name)
        return(pal_fn()(max(n, 1)))
      }, error = function(e) {
        cat("[PubPlot] ggsci palette failed, falling back to Set2\n")
        name <<- "Set2"
      })
    } else {
      cat("[PubPlot] ggsci not installed; falling back to Set2 palette\n")
      name <- "Set2"
    }
  }

  # RColorBrewer palettes
  tryCatch({
    max_colors <- RColorBrewer::brewer.pal.info[name, "maxcolors"]
    safe_n <- min(max(n, 3), max_colors)
    cols <- RColorBrewer::brewer.pal(safe_n, name)
    if (n > max_colors) cols <- colorRampPalette(cols)(n)
    return(cols)
  }, error = function(e) {
    # Last resort: ggplot2 default hue
    return(scales::hue_pal()(n))
  })
}

# Build a ggplot2 publication-ready DimPlot or other Seurat plot
build_pub_plot <- function(params) {
  plot_type      <- params$plot_type %||% "UMAP"
  group_by       <- params$group_by  %||% "seurat_clusters"
  features       <- params$features  # character vector or NULL
  title_str      <- params$title     %||% ""
  subtitle_str   <- params$subtitle  %||% ""
  x_label        <- params$x_label   %||% NULL
  y_label        <- params$y_label   %||% NULL
  pt_size        <- as.numeric(params$pt_size   %||% 1.0)
  alpha_val      <- as.numeric(params$alpha     %||% 1.0)
  do_label       <- isTRUE(params$label)
  label_size     <- as.numeric(params$label_size %||% 4)
  do_repel       <- !isFALSE(params$repel)   # default TRUE
  legend_pos     <- params$legend_position  %||% "right"
  font_size      <- as.numeric(params$font_size %||% 12)
  palette_name   <- params$color_palette %||% "Set2"
  split_by       <- if (!is.null(params$split_by) && nchar(params$split_by) > 0) params$split_by else NULL
  ncol_val       <- if (!is.null(params$ncol)) as.integer(params$ncol) else NULL
  dot_scale_val  <- as.numeric(params$dot_scale %||% 6)
  log_scale_val  <- isTRUE(params$log_scale)
  top_n_val      <- as.integer(params$top_n %||% 5)

  n_groups <- tryCatch(length(levels(Idents(global_obj))), error = function(e) 8)
  palette_colors <- get_pub_palette(palette_name, max(n_groups, 8))

  p <- NULL

  if (plot_type == "UMAP") {
    dim_args <- list(
      object         = global_obj,
      reduction      = "umap",
      group.by       = group_by,
      pt.size        = pt_size,
      alpha          = alpha_val,
      label          = do_label,
      label.size     = label_size,
      repel          = do_repel,
      cols           = palette_colors
    )
    if (!is.null(split_by)) dim_args$split.by <- split_by
    if (!is.null(ncol_val)) dim_args$ncol <- ncol_val
    p <- do.call(DimPlot, dim_args)

  } else if (plot_type == "FeaturePlot") {
    if (is.null(features) || length(features) == 0) stop("Features required for FeaturePlot")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    fp_args <- list(
      object   = global_obj,
      features = valid_features,
      pt.size  = pt_size,
      alpha    = alpha_val
    )
    if (log_scale_val) fp_args$log1p <- FALSE  # FeaturePlot takes log scale data already
    if (!is.null(split_by)) fp_args$split.by <- split_by
    if (!is.null(ncol_val)) fp_args$ncol <- ncol_val
    p <- do.call(FeaturePlot, fp_args)

  } else if (plot_type == "DotPlot") {
    if (is.null(features) || length(features) == 0) stop("Features required for DotPlot")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    p <- DotPlot(global_obj, features = valid_features, group.by = group_by,
                 dot.scale = dot_scale_val, cols = c("lightgrey", palette_colors[length(palette_colors)])) +
         RotatedAxis()

  } else if (plot_type == "Heatmap") {
    if (is.null(features) || length(features) == 0) {
      # Auto: top marker genes
      suppressMessages({ library(dplyr) })
      markers <- FindAllMarkers(global_obj, only.pos = TRUE, min.pct = 0.1, logfc.threshold = 0.25, verbose = FALSE)
      if (!is.null(markers) && nrow(markers) > 0) {
        top_genes <- as.data.frame(markers) %>% group_by(cluster) %>% top_n(n = top_n_val, wt = avg_log2FC) %>% pull(gene) %>% unique()
        features <- top_genes
      }
    }
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    p <- DoHeatmap(global_obj, features = valid_features, group.by = group_by)

  } else if (plot_type == "Violin") {
    if (is.null(features) || length(features) == 0) stop("Features required for Violin")
    valid_features <- intersect(features, rownames(global_obj))
    if (length(valid_features) == 0) stop("None of the requested features found in dataset")
    vln_args <- list(
      object   = global_obj,
      features = valid_features,
      group.by = group_by,
      pt.size  = 0,
      cols     = palette_colors
    )
    if (!is.null(split_by)) vln_args$split.by <- split_by
    if (!is.null(ncol_val)) vln_args$ncol <- ncol_val
    p <- do.call(VlnPlot, vln_args)

  } else {
    stop(paste("Unsupported plot type:", plot_type))
  }

  # Apply publication theme + labels
  p <- p + theme_classic(base_size = font_size) +
    theme(
      legend.position  = legend_pos,
      plot.title       = element_text(face = "bold", hjust = 0.5),
      plot.subtitle    = element_text(hjust = 0.5, color = "grey40"),
      axis.title       = element_text(face = "bold"),
      panel.background = element_rect(fill = "white", color = NA),
      plot.background  = element_rect(fill = "white", color = NA),
      legend.background = element_rect(fill = "white", color = NA)
    )

  title_final <- if (nchar(title_str) > 0) title_str else NULL
  sub_final   <- if (nchar(subtitle_str) > 0) subtitle_str else NULL
  x_final     <- x_label
  y_final     <- y_label

  p <- p + labs(title = title_final, subtitle = sub_final)
  if (!is.null(x_final)) p <- p + xlab(x_final)
  if (!is.null(y_final)) p <- p + ylab(y_final)

  return(p)
}


# NULL-coalescing operator
`%||%` <- function(a, b) if (!is.null(a) && length(a) > 0 && a != "") a else b

#* Export a publication-ready figure to disk
#* @post /export-figure
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))

  body <- req$body

  tryCatch({
    # Parse params
    format   <- body$format  %||% "png"
    width    <- as.numeric(body$width  %||% 8)
    height   <- as.numeric(body$height %||% 6)
    dpi_val  <- as.integer(body$dpi   %||% 300)
    dpi_val  <- min(max(dpi_val, 72), 600)  # clamp to sensible range

    # Coerce features from JSON array to character vector
    features_raw <- body$features
    if (!is.null(features_raw) && length(features_raw) > 0) {
      body$features <- as.character(unlist(features_raw))
    }

    # Create exports directory
    export_dir <- file.path(getwd(), "..", "exports")
    if (!dir.exists(export_dir)) dir.create(export_dir, recursive = TRUE)

    timestamp <- format(Sys.time(), "%Y%m%d_%H%M%S")
    plot_type <- body$plot_type %||% "Plot"
    file_name <- paste0(plot_type, "_", timestamp, ".", format)
    file_path <- file.path(export_dir, file_name)
    file_path <- normalizePath(file_path, mustWork = FALSE)

    # Build the plot
    p <- build_pub_plot(body)

    # Open output device
    if (format == "pdf") {
      pdf(file_path, width = width, height = height)
    } else if (format == "svg") {
      svg(file_path, width = width, height = height)
    } else {
      png(file_path, width = width, height = height, units = "in", res = dpi_val)
    }
    print(p)
    dev.off()

    # Generate a 150dpi JPEG thumbnail for the gallery
    thumbnail_b64 <- tryCatch({
      if (!requireNamespace("base64enc", quietly = TRUE)) stop("base64enc missing")
      tmp_thumb <- tempfile(fileext = ".jpg")
      jpeg(tmp_thumb, width = 6, height = 4.5, units = "in", res = 150, quality = 85)
      print(p)
      dev.off()
      raw_bytes <- readBin(tmp_thumb, "raw", file.info(tmp_thumb)$size)
      b64 <- base64enc::base64encode(raw_bytes)
      unlink(tmp_thumb)
      paste0("data:image/jpeg;base64,", b64)
    }, error = function(e) {
      if (dev.cur() > 1) dev.off()
      ""
    })

    make_provenance(
      result = list(
        message      = paste("Successfully exported", plot_type, "to", file_name),
        file_path    = file_path,
        file_name    = file_name,
        thumbnail_b64 = thumbnail_b64
      ),
      script_text = paste0(
        "# Export: ", plot_type, "\n",
        "p <- build_publication_plot(params)\n",
        if (format == "pdf") paste0("pdf('", file_path, "', width=", width, ", height=", height, ")\n")
        else paste0("png('", file_path, "', width=", width, ", height=", height, ", res=", dpi_val, ", units='in')\n"),
        "print(p)\ndev.off()\n"
      ),
      operation  = "export",
      parameters = as.list(body)
    )
  }, error = function(e) {
    if (dev.cur() > 1) dev.off()
    list(error = paste("Figure export failed:", e$message))
  })
}

#* Fast preview render — returns 150dpi JPEG base64 only (no file saved, no provenance)
#* @post /export-preview
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))

  body <- req$body

  # Coerce features
  features_raw <- body$features
  if (!is.null(features_raw) && length(features_raw) > 0) {
    body$features <- as.character(unlist(features_raw))
  }

  tryCatch({
    if (!requireNamespace("base64enc", quietly = TRUE)) {
      stop("Package 'base64enc' must be installed for preview rendering.")
    }

    p <- build_pub_plot(body)

    tmp_file <- tempfile(fileext = ".jpg")
    jpeg(tmp_file, width = 6, height = 4.5, units = "in", res = 150, quality = 85)
    print(p)
    dev.off()

    raw_bytes <- readBin(tmp_file, "raw", file.info(tmp_file)$size)
    b64 <- base64enc::base64encode(raw_bytes)
    unlink(tmp_file)

    list(result = list(base64 = paste0("data:image/jpeg;base64,", b64)))

  }, error = function(e) {
    if (dev.cur() > 1) dev.off()
    list(error = paste("Preview failed:", e$message))
  })
}

#* @post /render-plot-base64
#* @parser json
function(res, req) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))

  body       <- req$body
  plot_type  <- body$plot_type
  features   <- body$features
  group_by   <- body$group_by
  width      <- as.numeric(if (!is.null(body$width))  body$width  else 6)
  height     <- as.numeric(if (!is.null(body$height)) body$height else 5)
  res        <- as.numeric(if (!is.null(body$res))    body$res    else 150)

  tryCatch({
    if (!requireNamespace("base64enc", quietly = TRUE)) {
      stop("Package 'base64enc' must be installed to use base64 rendering.")
    }

    tmp_file <- tempfile(fileext = ".png")
    png(tmp_file, width = width, height = height, units = "in", res = res)

    p <- NULL
    if (plot_type == "UMAP") {
      p <- DimPlot(global_obj, reduction = "umap", group.by = group_by,
                   label = TRUE, repel = TRUE)
    } else if (plot_type == "FeaturePlot") {
      valid_features <- intersect(as.character(unlist(features)), rownames(global_obj))
      if (length(valid_features) > 0) {
        p <- FeaturePlot(global_obj, features = valid_features[1])
      } else {
        stop("Feature not found.")
      }
    } else if (plot_type == "Violin") {
      valid_features <- intersect(as.character(unlist(features)), rownames(global_obj))
      if (length(valid_features) > 0) {
        p <- VlnPlot(global_obj, features = valid_features[1], group.by = group_by, pt.size = 0)
      } else {
        stop("Feature not found.")
      }
    } else {
      dev.off()
      stop(paste("Unsupported plot type for base64:", plot_type))
    }

    print(p)
    dev.off()

    raw_bytes <- readBin(tmp_file, "raw", file.info(tmp_file)$size)
    b64 <- base64enc::base64encode(raw_bytes)
    unlink(tmp_file)

    list(result = list(base64 = paste0("data:image/png;base64,", b64)))

  }, error = function(e) {
    if (dev.cur() > 1) dev.off()
    list(error = paste("Base64 Render failed:", e$message))
  })
}

#* Bit-Accurate Validation & Sanity Checks
#* @get /validate
function(res) {
  if (is.null(global_obj)) return(list(error = "No object loaded"))
  
  tryCatch({
    # Compute percent.mt if not already present
    if (!"percent.mt" %in% colnames(global_obj@meta.data)) {
      global_obj[["percent.mt"]] <<- PercentageFeatureSet(global_obj, pattern = "^MT-")
    }
    
    cell_count <- ncol(global_obj)
    feature_count <- nrow(global_obj)
    median_genes <- round(median(global_obj$nFeature_RNA), 2)
    median_counts <- round(median(global_obj$nCount_RNA), 2)
    mean_mt <- round(mean(global_obj$percent.mt), 4)
    
    # Sparsity
    counts_mat <- GetAssayData(global_obj, layer = "counts")
    nnz <- length(counts_mat@x)
    total <- as.numeric(nrow(counts_mat)) * as.numeric(ncol(counts_mat))
    sparsity <- round((1 - nnz / total) * 100, 2)
    
    # Check for normalized data
    has_normalized <- tryCatch({
      d <- GetAssayData(global_obj, layer = "data")
      !identical(d, counts_mat)
    }, error = function(e) FALSE)
    
    # Check for PCA
    has_pca <- "pca" %in% names(global_obj@reductions)
    pca_stdevs <- if (has_pca) {
      tryCatch(
        if (existsFunction("Stdev")) Stdev(global_obj, reduction = "pca")
        else if (existsFunction("Stdevs")) Stdevs(global_obj, reduction = "pca")
        else global_obj[["pca"]]@stdev,
        error = function(e) global_obj[["pca"]]@stdev
      )
    } else {
      NA
    }
    pca_variance <- if (has_pca && !any(is.na(pca_stdevs))) round(pca_stdevs[1]^2 / sum(pca_stdevs^2) * 100, 3) else NA

    
    # Check for clusters
    has_clusters <- "seurat_clusters" %in% colnames(global_obj@meta.data)
    n_clusters <- if (has_clusters) length(unique(global_obj$seurat_clusters)) else NA
    
    # Check for UMAP
    has_umap <- "umap" %in% names(global_obj@reductions)
    
    make_provenance(
      result = list(
        cell_count = cell_count,
        feature_count = feature_count,
        median_genes = median_genes,
        median_counts = median_counts,
        mito_mean = paste0(mean_mt, "%"),
        sparsity = paste0(sparsity, "%"),
        has_normalized = has_normalized,
        has_pca = has_pca,
        pca_top_variance = if (!is.na(pca_variance)) paste0(pca_variance, "%") else "N/A",
        has_clusters = has_clusters,
        n_clusters = if (!is.na(n_clusters)) n_clusters else "N/A",
        has_umap = has_umap,
        pipeline_steps = paste(
          c("load",
            if (has_normalized) "normalize",
            if (has_pca) "pca",
            if (has_clusters) "cluster",
            if (has_umap) "umap"),
          collapse = " → "
        )
      ),
      script_text = "# Validation: extract bit-accurate metrics from current Seurat object",
      operation = "validation"
    )
  }, error = function(e) { res$status <- 500; list(error = paste("Validation failed:", e$message))
  })
}


