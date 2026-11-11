# Harness-only: builds a condition design from synthetic cell metadata so the
# evaluation scripts can stand in for a person-registered contrast. Production
# never derives designs from cell labels; the server resolves a pinned contrast.
harness_metadata_design <- function(obj, numerator, denominator) {
  meta <- obj[[]]
  if (!all(c("sample_id", "condition", "donor_code") %in% names(meta))) stop("Sample design unavailable")
  if (identical(numerator, denominator) || !all(c(numerator, denominator) %in% meta$condition)) {
    stop("Invalid condition contrast")
  }
  samples <- unique(meta[, c("sample_id", "condition", "donor_code"), drop = FALSE])
  if (anyDuplicated(samples$sample_id)) stop("Samples have inconsistent condition/donor labels")
  samples <- samples[samples$condition %in% c(numerator, denominator), , drop = FALSE]
  if (any(table(factor(samples$condition, levels = c(numerator, denominator))) < 2L)) {
    stop("Insufficient independent samples")
  }
  if (anyNA(samples$donor_code) || any(!nzchar(samples$donor_code)) || anyDuplicated(samples$donor_code)) {
    stop("Independent unique donors required")
  }
  list(
    unit_of_replication = "donor",
    paired = FALSE,
    model_formula = "~ condition",
    cell_type_column = "seurat_clusters",
    samples = lapply(seq_len(nrow(samples)), function(i) list(
      sample_id = samples$sample_id[i],
      condition = if (samples$condition[i] == numerator) "numerator" else "denominator",
      donor_code = samples$donor_code[i],
      unit_id = samples$donor_code[i],
      cell_metadata_column = "sample_id",
      cell_metadata_value = samples$sample_id[i]
    ))
  )
}

harness_contrast_args <- function(obj, numerator, denominator) {
  list(
    design = harness_metadata_design(obj, numerator, denominator),
    contrast_labels = list(numerator = numerator, denominator = denominator)
  )
}
