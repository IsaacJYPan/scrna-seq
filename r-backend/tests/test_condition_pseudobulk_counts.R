# Condition pseudobulk must aggregate raw counts, never a normalized or
# SCTransform-corrected assay, whatever the object's default assay is.
#
# Usage: Rscript r-backend/tests/test_condition_pseudobulk_counts.R
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
})

script_dir <- local({
  file_arg <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(file_arg)) dirname(normalizePath(file_arg)) else file.path(getwd(), "r-backend", "tests")
})
lib_dir <- normalizePath(file.path(script_dir, "..", "lib"))
source(file.path(lib_dir, "storage.R"))
source(file.path(lib_dir, "conditionComparison.R"))

failures <- 0L
check <- function(desc, ok) {
  if (isTRUE(ok)) {
    cat("PASS:", desc, "\n")
  } else {
    cat("FAIL:", desc, "\n")
    failures <<- failures + 1L
  }
}
expect_error_matching <- function(desc, expr, pattern) {
  message <- tryCatch({
    force(expr)
    NA_character_
  }, error = function(e) conditionMessage(e))
  check(desc, !is.na(message) && grepl(pattern, message))
}

set.seed(11)
n_genes <- 300L
samples <- data.frame(
  sample_id = paste0("S", 1:8),
  condition = rep(c("denominator", "numerator"), each = 4L),
  stringsAsFactors = FALSE
)
cells_per_unit <- 30L
cell_meta <- do.call(rbind, lapply(seq_len(nrow(samples)), function(i) {
  data.frame(
    sample = samples$sample_id[i],
    cell_type = rep(c("T", "B"), each = cells_per_unit),
    stringsAsFactors = FALSE
  )
}))
n_cells <- nrow(cell_meta)
means <- rgamma(n_genes, shape = 2, rate = 0.5)
raw <- matrix(rpois(n_genes * n_cells, lambda = rep(means, n_cells)), nrow = n_genes)
rownames(raw) <- paste0("Gene", seq_len(n_genes))
colnames(raw) <- paste0("Cell", seq_len(n_cells))
rownames(cell_meta) <- colnames(raw)

obj <- CreateSeuratObject(counts = as(raw, "dgCMatrix"), meta.data = cell_meta)

design <- list(
  unit_of_replication = "sample",
  paired = FALSE,
  model_formula = "~ condition",
  cell_type_column = "cell_type",
  samples = lapply(seq_len(nrow(samples)), function(i) list(
    sample_id = samples$sample_id[i],
    condition = samples$condition[i],
    donor_code = paste0("D", i),
    unit_id = samples$sample_id[i],
    cell_metadata_column = "sample",
    cell_metadata_value = samples$sample_id[i]
  ))
)

reference <- run_condition_pseudobulk_de(obj, design)
check("reference run reports the RNA count assay", identical(reference$summary$count_assay, "RNA"))

# An SCT-like default assay: corrected, still integer-valued counts that differ
# from the raw counts. Pseudobulk must ignore it.
corrected <- raw
corrected[corrected > 0] <- pmax(1L, round(corrected[corrected > 0] / 2))
sct_obj <- obj
sct_obj[["SCT"]] <- CreateAssayObject(counts = as(corrected, "dgCMatrix"))
DefaultAssay(sct_obj) <- "SCT"

selected <- condition_raw_count_matrix(sct_obj)
check("SCT default assay still selects RNA", identical(selected$assay, "RNA"))
check(
  "selected matrix equals the RNA counts",
  identical(as.matrix(selected$counts), as.matrix(LayerData(obj, assay = "RNA", layer = "counts")))
)

sct_result <- run_condition_pseudobulk_de(sct_obj, design)
check("SCT-default run reports the RNA count assay", identical(sct_result$summary$count_assay, "RNA"))
check(
  "SCT-default run gives the same statistics as the RNA-default run",
  isTRUE(all.equal(sct_result$table, reference$table))
)

# Split RNA layers (Seurat v5) are joined before aggregation.
split_obj <- obj
split_obj[["RNA"]] <- split(split_obj[["RNA"]], f = split_obj$sample)
split_selected <- condition_raw_count_matrix(split_obj)
joined <- as.matrix(split_selected$counts)[, colnames(raw)]
check("split layers are joined into one count matrix", identical(joined, as.matrix(as(raw, "dgCMatrix"))))

# Non-integer counts are refused instead of being treated as counts.
fractional <- obj
fractional_counts <- as(raw, "dgCMatrix")
fractional_counts@x <- fractional_counts@x + 0.25
fractional[["RNA"]] <- CreateAssayObject(counts = fractional_counts)
expect_error_matching(
  "non-integer counts are refused",
  run_condition_pseudobulk_de(fractional, design),
  "non-negative integer"
)

no_raw <- CreateSeuratObject(counts = as(raw, "dgCMatrix"), assay = "SCT", meta.data = cell_meta)
expect_error_matching(
  "an object without an RNA or Spatial assay is refused",
  run_condition_pseudobulk_de(no_raw, design),
  "raw-count"
)

if (failures > 0L) {
  cat(failures, "check(s) failed\n")
  quit(status = 1L)
}
cat("All condition pseudobulk count checks passed\n")
