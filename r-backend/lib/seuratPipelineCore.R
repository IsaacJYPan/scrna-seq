# Shared Seurat QC -> normalization -> PCA -> clustering -> UMAP computation.
# Used by the Plumber worker bridge (r-backend/plumber.R) and by the standalone
# cluster runner (r-backend/hpc-runner.R) so both execute identical analysis code.
# `read_gene_expression(input)` returns a counts matrix for one input reference;
# `save_rds(value, path)` writes the checkpoint at `output_path`.
run_seurat_pipeline_core <- function(p, read_gene_expression, output_path,
                                     single_input = NULL, dataset_inputs = NULL,
                                     sample_names = NULL, condition_names = NULL,
                                     save_rds = saveRDS) {
  # ---- Read parameters ----
  multi_sample <- !is.null(dataset_inputs)
  as_int <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.integer(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }
  as_num <- function(v, d, lo, hi) {
    x <- suppressWarnings(as.numeric(v))
    if (length(x) != 1 || is.na(x)) return(d)
    max(lo, min(hi, x))
  }
  scalar_string <- function(value) is.character(value) && length(value) == 1L && !is.na(value) && nzchar(value)
  min_cells <- as_int(p$minCells, 3, 0, 10000)
  min_features <- as_int(p$minFeatures, 200, 0, 100000)
  apply_qc <- isTRUE(p$applyQcFilter)
  min_features_filter <- as_int(p$minFeaturesFilter, 200, 0, 100000)
  max_features_filter <- as_int(p$maxFeaturesFilter, 2500, 1, 1000000)
  max_percent_mt <- as_num(p$maxPercentMt, 5, 0, 100)
  norm_method <- if (!is.null(p$normalizationMethod)) as.character(p$normalizationMethod)[1] else "LogNormalize"
  if (!norm_method %in% c("LogNormalize", "SCTransform")) norm_method <- "LogNormalize"
  scale_factor <- as_num(p$scaleFactor, 10000, 1, 1e7)
  nfeatures <- as_int(p$variableFeatures, 2000, 50, 10000)
  pca_dims <- as_int(p$pcaDims, 50, 2, 100)
  cluster_dims <- as_int(p$clusterDims, 15, 2, 100)
  cluster_res <- as_num(p$clusterResolution, 0.8, 0.01, 10)
  umap_dims <- as_int(p$umapDims, 15, 2, 100)
  umap_components <- as_int(p$umapComponents, 2, 2, 3)
  umap_neighbors <- as_int(p$umapNeighbors, 30, 2, 200)
  umap_min_dist <- as_num(p$umapMinDist, 0.3, 0, 1)
  used_seed <- if (is.null(p$seed) || is.na(suppressWarnings(as.integer(p$seed)))) sample.int(100000, 1) else as.integer(p$seed)
  # ---- Load counts ----
  if (multi_sample) {
    sample_objects <- lapply(seq_along(dataset_inputs), function(index) {
      input <- dataset_inputs[[index]]
      sample_name <- sample_names[[index]]
      sample_obj <- CreateSeuratObject(
        counts = read_gene_expression(input$storage_key),
        project = sample_name,
        min.cells = min_cells,
        min.features = min_features
      )
      sample_obj$sample_id <- sample_name
      sample_obj$condition <- condition_names[[index]]
      sample_obj$donor_code <- if (scalar_string(input$donor_code)) as.character(input$donor_code)[1] else NA_character_
      sample_obj$batch <- if (scalar_string(input$batch)) as.character(input$batch)[1] else NA_character_
      sample_obj
    })
    obj <- merge(
      x = sample_objects[[1]],
      y = sample_objects[-1],
      add.cell.ids = sprintf("sample%02d", seq_along(sample_objects)),
      merge.data = FALSE
    )
  } else {
    obj <- CreateSeuratObject(
      counts = read_gene_expression(single_input),
      min.cells = min_cells,
      min.features = min_features
    )
  }
  raw_obj <- obj
  warnings <- c()
  pre_filter_cells <- ncol(obj)

  # ---- Quality control ----
  mt_ok <- TRUE
  tryCatch({
    obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^[Mm][Tt]-")
  }, error = function(e) {
    mt_ok <<- FALSE
    warnings <<- c(warnings, "percent.mt could not be computed")
    obj[["percent.mt"]] <<- 0
  })

  if (apply_qc) {
    keep <- obj$nFeature_RNA >= min_features_filter &
      obj$nFeature_RNA <= max_features_filter &
      obj$percent.mt <= max_percent_mt
    if (sum(keep) < 3) stop("QC filtering would leave fewer than 3 cells.")
    obj <- subset(obj, cells = colnames(obj)[keep])
  }
  post_filter_cells <- ncol(obj)

  # ---- Normalize ----
  set.seed(used_seed)
  if (norm_method == "SCTransform") {
    obj <- SCTransform(obj, verbose = FALSE)
  } else {
    obj <- NormalizeData(obj, normalization.method = norm_method, scale.factor = scale_factor, verbose = FALSE)
    obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = nfeatures, verbose = FALSE)
    obj <- ScaleData(obj, features = rownames(obj), verbose = FALSE)
  }

  # ---- PCA ----
  npcs <- min(pca_dims, ncol(obj) - 1, nrow(obj) - 1, 100, na.rm = TRUE)
  if (is.na(npcs) || npcs < 2) stop("Insufficient cells/features for PCA.")
  obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)

  # ---- Cluster ----
  avail_dims <- ncol(Embeddings(obj, "pca"))
  cdims <- min(cluster_dims, avail_dims)
  obj <- FindNeighbors(obj, reduction = "pca", dims = 1:cdims, verbose = FALSE)
  obj <- FindClusters(obj, resolution = cluster_res, random.seed = used_seed, verbose = FALSE)

  # ---- UMAP ----
  udims <- min(umap_dims, avail_dims)
  un <- min(umap_neighbors, ncol(obj) - 1, na.rm = TRUE)
  if (is.na(un) || un < 2) stop("Insufficient cells for UMAP.")
  obj <- RunUMAP(obj, reduction = "pca", dims = 1:udims, n.components = umap_components,
                 n.neighbors = un, min.dist = umap_min_dist, seed.use = used_seed, verbose = FALSE)

  # ---- Save checkpoint ----
  safe_path <- output_path
  save_rds(list(global = obj, raw = raw_obj), safe_path)
  size_bytes <- as.numeric(file.info(safe_path)$size)
  checksum <- tryCatch({
    if (requireNamespace("digest", quietly = TRUE)) {
      digest::digest(file = safe_path, algo = "sha256")
    } else if (requireNamespace("openssl", quietly = TRUE)) {
      as.character(openssl::sha256(file(safe_path)))
    } else {
      NA_character_
    }
  }, error = function(e) NA_character_)
  saved <- isTRUE(file.exists(safe_path)) && !is.na(checksum)
  cluster_counts <- table(obj$seurat_clusters)

  # ---- Summarize ----
  summary_out <- list(
    n_cells = ncol(obj),
    n_features = nrow(obj),
    pre_filter_cells = pre_filter_cells,
    post_filter_cells = post_filter_cells,
    percent_mt_available = mt_ok,
    n_variable_features = length(VariableFeatures(obj)),
    n_pcs = npcs,
    n_clusters = length(cluster_counts),
    cluster_sizes = as.list(as.integer(cluster_counts)),
    reductions = as.list(names(obj@reductions)),
    normalization_method = norm_method,
    resolution = cluster_res,
    used_seed = used_seed
  )
  if (multi_sample) {
    condition_counts <- table(condition_names)
    summary_out$n_samples <- length(dataset_inputs)
    summary_out$conditions <- as.list(names(condition_counts))
    summary_out$samples_per_condition <- lapply(seq_along(condition_counts), function(index) {
      list(condition = names(condition_counts)[[index]], n = as.integer(condition_counts[[index]]))
    })
  }

  response_out <- list(
    ok = TRUE,
    summary = summary_out,
    warnings = as.list(warnings),
    checkpoint = list(
      saved = saved,
      checksum_sha256 = if (is.na(checksum)) NULL else checksum,
      size_bytes = size_bytes
    ),
    versions = list(
      seurat_version = as.character(utils::packageVersion("Seurat")),
      r_version = as.character(getRversion())
    )
  )
  response_out
}
