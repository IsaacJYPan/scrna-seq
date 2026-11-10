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
  stages <- c("qc","normalize","pca","cluster","umap")
  completed_stage <- if(is.null(p$stopAfter)) "umap" else as.character(p$stopAfter)[1]
  if(!completed_stage %in% stages) stop("Unsupported preprocessing stage.")
  stage <- match(completed_stage,stages)
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
    rm(sample_objects);invisible(gc())
    # Join before retaining the raw snapshot so raw/global can share immutable
    # count storage rather than keeping both split and joined count copies.
    obj<-JoinLayers(obj);invisible(gc())
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

  qc_distribution <- function(values) {
    values <- as.numeric(values)
    values <- values[is.finite(values)]
    if (!length(values)) return(NULL)
    as.list(setNames(
      as.numeric(quantile(values, c(0, .25, .5, .75, 1), names = FALSE)),
      c("min", "q25", "median", "q75", "max")
    ))
  }
  qc_before <- lapply(obj@meta.data[, c("nCount_RNA", "nFeature_RNA", "percent.mt"), drop = FALSE], qc_distribution)
  sample_qc <- if (multi_sample) lapply(split(obj[[]], obj$sample_id), function(m) list(
    sample = as.character(m$sample_id[1]),
    condition = as.character(m$condition[1]),
    cells = nrow(m),
    counts = qc_distribution(m$nCount_RNA),
    genes = qc_distribution(m$nFeature_RNA),
    mitochondrial = qc_distribution(m$percent.mt)
  )) else list()
  if (apply_qc) {
    keep <- obj$nFeature_RNA >= min_features_filter &
      obj$nFeature_RNA <= max_features_filter &
      obj$percent.mt <= max_percent_mt & obj$nCount_RNA >= as_int(p$minCountsFilter,0,0,10000000)
    if (sum(keep) < 3) stop("QC filtering would leave fewer than 3 cells.")
    obj <- subset(obj, cells = colnames(obj)[keep])
  }
  post_filter_cells <- ncol(obj)
  invisible(gc())

  # ---- Normalize ----
  set.seed(used_seed)
  npcs <- 0L
  if(stage >= 2L) {
  if(multi_sample){obj<-JoinLayers(obj);invisible(gc())}
  if (norm_method == "SCTransform") {
    obj <- SCTransform(obj, verbose = FALSE)
  } else {
    obj <- NormalizeData(obj, normalization.method = norm_method, scale.factor = scale_factor, verbose = FALSE)
    invisible(gc())
    obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = nfeatures, verbose = FALSE)
    invisible(gc())
    obj <- ScaleData(obj, features = VariableFeatures(obj), block.size = 256L, verbose = FALSE)
    invisible(gc())
  }
  }

  # ---- PCA ----
  if(stage >= 3L) {
  npcs <- min(pca_dims, ncol(obj) - 1, nrow(obj) - 1, 100, na.rm = TRUE)
  if (is.na(npcs) || npcs < 2) stop("Insufficient cells/features for PCA.")
  obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)
  }

  # ---- Cluster ----
  graph_reduction <- "pca"
  if (stage >= 4L && identical(p$integrationMethod, "rpca")) {
    if (!multi_sample || norm_method != "LogNormalize") stop("RPCA requires multiple samples and LogNormalize")
    obj[["RNA"]] <- split(obj[["RNA"]], f = obj$sample_id)
    obj <- IntegrateLayers(
      object = obj, method = RPCAIntegration,
      orig.reduction = "pca", new.reduction = "integrated.rpca",
      dims = seq_len(npcs), verbose = FALSE
    )
    obj <- JoinLayers(obj)
    graph_reduction <- "integrated.rpca"
  }
  if(stage >= 4L) {
  avail_dims <- ncol(Embeddings(obj, "pca"))
  cdims <- min(cluster_dims, avail_dims)
  obj <- FindNeighbors(obj, reduction = graph_reduction, dims = 1:cdims, verbose = FALSE)
  obj <- FindClusters(obj, resolution = cluster_res, random.seed = used_seed, verbose = FALSE)
  }

  # ---- UMAP ----
  if(stage >= 5L) {
  avail_dims <- ncol(Embeddings(obj, "pca"))
  udims <- min(umap_dims, avail_dims)
  un <- min(umap_neighbors, ncol(obj) - 1, na.rm = TRUE)
  if (is.na(un) || un < 2) stop("Insufficient cells for UMAP.")
  obj <- RunUMAP(obj, reduction = graph_reduction, dims = 1:udims, n.components = umap_components,
                 n.neighbors = un, min.dist = umap_min_dist, seed.use = used_seed, verbose = FALSE)
  }

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
  cluster_counts <- if("seurat_clusters" %in% colnames(obj@meta.data)) table(obj$seurat_clusters) else integer()
  count_checks <- lapply(Layers(raw_obj[[DefaultAssay(raw_obj)]],search="^counts"),function(layer) {
    counts <- LayerData(raw_obj,layer=layer)
    values <- if(inherits(counts,"sparseMatrix"))counts@x else as.numeric(counts)
    c(nonfinite=any(!is.finite(values)),negative=any(values<0),integer=all(is.finite(values)&values==round(values)))
  })

  # ---- Summarize ----
  summary_out <- list(
    completed_stage = completed_stage,
    diagnostics = list(
      sample_qc = unname(sample_qc),
      qc_before = qc_before,
      qc_after = lapply(obj@meta.data[, c("nCount_RNA", "nFeature_RNA", "percent.mt"), drop = FALSE], qc_distribution),
      pca_variance = if (stage >= 3L) as.list(as.numeric(Stdev(obj, "pca")^2 / sum(Stdev(obj, "pca")^2))) else list(),
      pca_variance_basis = "fraction_among_stored_PCs",
      cluster_sizes = as.list(cluster_counts),
      checks = list(
        contains_nonfinite_counts = any(vapply(count_checks, function(x) x[["nonfinite"]], logical(1))),
        negative_counts = any(vapply(count_checks, function(x) x[["negative"]], logical(1))),
        integer_counts = all(vapply(count_checks, function(x) x[["integer"]], logical(1))),
        doublets_assessed = FALSE,
        ambient_rna_assessed = FALSE,
        batch_effects_assessed = FALSE
      )
    ),
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
