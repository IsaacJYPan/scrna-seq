normalize_condition_pseudobulk_design <- function(value) {
  samples_value <- if (is.list(value)) value$samples else NULL
  if (is.data.frame(samples_value)) {
    samples_value <- lapply(seq_len(nrow(samples_value)), function(index) {
      as.list(samples_value[index, , drop = FALSE])
    })
  }
  expected_design_fields <- c("unit_of_replication", "paired", "model_formula", "cell_type_column", "samples")
  if (!is.list(value) || !setequal(names(value), expected_design_fields) ||
      !is_scalar_string(value$unit_of_replication) ||
      !(value$unit_of_replication %in% c("sample", "donor")) ||
      !is.logical(value$paired) || length(value$paired) != 1L || is.na(value$paired) ||
      !is_scalar_string(value$model_formula) ||
      !is_scalar_string(value$cell_type_column) ||
      !grepl("^[A-Za-z][A-Za-z0-9_.-]{0,63}$", value$cell_type_column) ||
      !is.list(samples_value) || length(samples_value) < 4L || length(samples_value) > 1000L) {
    stop("Invalid condition design.")
  }
  expected_formula <- if (isTRUE(value$paired)) "~ donor + condition" else "~ condition"
  if (!identical(value$model_formula, expected_formula)) stop("Invalid condition model.")
  required <- c("sample_id", "condition", "donor_code", "unit_id",
                "cell_metadata_column", "cell_metadata_value")
  samples <- lapply(samples_value, function(sample) {
    if (!is.list(sample) || !setequal(names(sample), required) ||
        !is_scalar_string(sample$sample_id) ||
        !is_scalar_string(sample$condition) || !(sample$condition %in% c("numerator", "denominator")) ||
        !is_scalar_string(sample$unit_id) ||
        !is_scalar_string(sample$cell_metadata_column) ||
        !grepl("^[A-Za-z][A-Za-z0-9_.-]{0,63}$", sample$cell_metadata_column) ||
        !is_scalar_string(sample$cell_metadata_value) ||
        nchar(sample$cell_metadata_value, type = "bytes") > 200L) stop("Invalid condition sample map.")
    if (!is.null(sample$donor_code) && !is_scalar_string(sample$donor_code)) {
      stop("Invalid donor code.")
    }
    sample
  })
  if (anyDuplicated(vapply(samples, `[[`, character(1), "sample_id"))) {
    stop("Duplicate condition sample.")
  }
  list(
    unit_of_replication = value$unit_of_replication,
    paired = isTRUE(value$paired),
    model_formula = expected_formula,
    cell_type_column = value$cell_type_column,
    samples = samples
  )
}

run_condition_pseudobulk_de <- function(input_obj, design) {
  if (!requireNamespace("edgeR", quietly = TRUE) || !requireNamespace("limma", quietly = TRUE)) {
    stop("Controlled pseudobulk packages are unavailable.")
  }
  metadata <- input_obj[[]]
  required_columns <- unique(c(
    design$cell_type_column,
    vapply(design$samples, `[[`, character(1), "cell_metadata_column")
  ))
  if (any(!required_columns %in% colnames(metadata))) stop("Required sample or cell-type metadata is absent.")

  assigned_sample <- rep(NA_character_, nrow(metadata))
  names(assigned_sample) <- rownames(metadata)
  for (sample in design$samples) {
    matched <- !is.na(metadata[[sample$cell_metadata_column]]) &
      as.character(metadata[[sample$cell_metadata_column]]) == sample$cell_metadata_value
    if (any(matched & !is.na(assigned_sample))) stop("A cell maps to more than one biological sample.")
    assigned_sample[matched] <- sample$sample_id
  }
  if (!any(!is.na(assigned_sample))) stop("No cells match the registered biological samples.")
  sample_lookup <- setNames(design$samples, vapply(design$samples, `[[`, character(1), "sample_id"))
  cell_type <- as.character(metadata[[design$cell_type_column]])
  valid <- !is.na(assigned_sample) & !is.na(cell_type) & nzchar(cell_type)
  if (!any(valid)) stop("No mapped cells have a usable cell-type label.")
  cell_types <- sort(unique(cell_type[valid]))
  if (length(cell_types) > 128L) stop("Cell-type cardinality exceeds the supported limit.")

  assay <- Seurat::DefaultAssay(input_obj)
  counts <- Seurat::GetAssayData(input_obj, assay = assay, layer = "counts")
  if (nrow(counts) > 100000L || ncol(counts) > 1000000L) stop("Pseudobulk input exceeds supported dimensions.")
  result_parts <- list()
  skipped <- character()
  tested_genes <- character()

  for (label in cell_types) {
    cells <- names(assigned_sample)[valid & cell_type == label]
    sample_ids <- assigned_sample[cells]
    unit_keys <- vapply(sample_ids, function(sample_id) {
      sample <- sample_lookup[[sample_id]]
      paste(sample$condition, sample$unit_id, sep = "::")
    }, character(1))
    unit_counts <- table(unit_keys)
    kept_units <- names(unit_counts)[unit_counts >= 20L]
    keep_cell <- unit_keys %in% kept_units
    cells <- cells[keep_cell]
    unit_keys <- unit_keys[keep_cell]
    unit_condition <- sub("::.*$", "", kept_units)
    if (sum(unit_condition == "numerator") < 2L || sum(unit_condition == "denominator") < 2L) {
      skipped <- c(skipped, label)
      next
    }
    membership <- Matrix::sparse.model.matrix(~ 0 + factor(unit_keys, levels = kept_units))
    colnames(membership) <- kept_units
    pseudobulk <- counts[, cells, drop = FALSE] %*% membership
    condition <- factor(unit_condition, levels = c("denominator", "numerator"))
    if (design$paired) {
      donor <- factor(sub("^[^:]+::", "", kept_units))
      model <- stats::model.matrix(~ donor + condition)
    } else {
      model <- stats::model.matrix(~ condition)
    }
    if (qr(model)$rank < ncol(model)) {
      skipped <- c(skipped, label)
      next
    }
    y <- edgeR::DGEList(counts = pseudobulk)
    keep_gene <- edgeR::filterByExpr(y, design = model, min.count = 10)
    if (sum(keep_gene) < 2L) {
      skipped <- c(skipped, label)
      next
    }
    y <- edgeR::calcNormFactors(y[keep_gene, , keep.lib.sizes = FALSE])
    y <- edgeR::estimateDisp(y, model, robust = TRUE)
    fit <- edgeR::glmQLFit(y, model, robust = TRUE)
    coefficient <- which(colnames(model) == "conditionnumerator")
    if (length(coefficient) != 1L) stop("Condition coefficient is unavailable.")
    table_out <- edgeR::topTags(edgeR::glmQLFTest(fit, coef = coefficient), n = Inf, sort.by = "PValue")$table
    table_out$gene <- rownames(table_out)
    table_out$cell_type <- label
    table_out <- data.frame(
      cell_type = table_out$cell_type, gene = table_out$gene,
      log_fc = table_out$logFC, log_cpm = table_out$logCPM,
      f_statistic = table_out$F, p_value = table_out$PValue, fdr = table_out$FDR,
      stringsAsFactors = FALSE
    )
    result_parts[[length(result_parts) + 1L]] <- table_out
    tested_genes <- union(tested_genes, table_out$gene)
  }
  result_table <- if (length(result_parts)) do.call(rbind, result_parts) else data.frame(
    cell_type = character(), gene = character(), log_fc = numeric(), log_cpm = numeric(),
    f_statistic = numeric(), p_value = numeric(), fdr = numeric(), stringsAsFactors = FALSE
  )
  if (nrow(result_table) > 500000L) stop("Pseudobulk result exceeds the supported row limit.")
  significant <- result_table[is.finite(result_table$fdr) & result_table$fdr <= 0.05, , drop = FALSE]
  top <- head(result_table[order(result_table$fdr, result_table$p_value, na.last = TRUE), , drop = FALSE], 50L)
  top_results <- lapply(seq_len(nrow(top)), function(index) list(
    cell_type = as.character(top$cell_type[[index]]), gene = as.character(top$gene[[index]]),
    log_fc = as.numeric(top$log_fc[[index]]), p_value = as.numeric(top$p_value[[index]]),
    fdr = as.numeric(top$fdr[[index]])
  ))
  list(
    table = result_table,
    summary = list(
      method = "edgeR quasi-likelihood pseudobulk",
      cell_type_column = design$cell_type_column,
      unit_of_replication = design$unit_of_replication,
      paired = design$paired,
      model_formula = design$model_formula,
      sample_count = as.integer(length(design$samples)),
      tested_cell_type_count = as.integer(length(result_parts)),
      tested_gene_count = as.integer(length(tested_genes)),
      significant_result_count = as.integer(nrow(significant)),
      skipped_cell_types = as.list(head(skipped, 128L)),
      top_results = top_results,
      package_versions = list(
        r = as.character(getRversion()),
        seurat = as.character(utils::packageVersion("Seurat")),
        edger = as.character(utils::packageVersion("edgeR")),
        limma = as.character(utils::packageVersion("limma"))
      ),
      warnings = if (length(skipped)) list("Cell types without sufficient per-unit cells or replication were skipped.") else list()
    )
  )
}
