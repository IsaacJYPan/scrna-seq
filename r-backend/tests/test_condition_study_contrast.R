# The workbench's condition DE recipe must test the person-registered contrast
# it is given, never a design rebuilt from cell metadata labels.
#
# Usage: Rscript r-backend/tests/test_condition_study_contrast.R
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
  library(ggplot2)
})
options(bitmapType = "cairo")

script_dir <- local({
  file_arg <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(file_arg)) dirname(normalizePath(file_arg)) else file.path(getwd(), "r-backend", "tests")
})
lib_dir <- normalizePath(file.path(script_dir, "..", "lib"))
for (file in c("storage.R", "conditionComparison.R", "standardFigures.R", "conditionStudy.R")) {
  source(file.path(lib_dir, file))
}

failures <- 0L
check <- function(desc, ok) {
  cat(if (isTRUE(ok)) "PASS:" else "FAIL:", desc, "\n")
  if (!isTRUE(ok)) failures <<- failures + 1L
}
error_message <- function(expr) tryCatch({
  force(expr)
  NA_character_
}, error = function(e) conditionMessage(e))

set.seed(7)
n_genes <- 200L
sample_ids <- paste0("S", 1:8)
cells <- do.call(rbind, lapply(sample_ids, function(id) data.frame(
  sample_id = id,
  seurat_clusters = rep(c("0", "1"), each = 25L),
  stringsAsFactors = FALSE
)))
counts <- matrix(rpois(n_genes * nrow(cells), 4), nrow = n_genes)
rownames(counts) <- paste0("G", seq_len(n_genes))
colnames(counts) <- paste0("C", seq_len(nrow(cells)))
rownames(cells) <- colnames(counts)
# Misleading cell labels: every cell claims the same condition and there is no
# donor column. A design built from metadata could not run; the registered
# contrast below must.
cells$condition <- "unlabelled"
obj <- CreateSeuratObject(counts = as(counts, "dgCMatrix"), meta.data = cells)
obj <- NormalizeData(obj, verbose = FALSE)

design <- list(
  unit_of_replication = "sample",
  paired = FALSE,
  model_formula = "~ condition",
  cell_type_column = "seurat_clusters",
  samples = lapply(seq_along(sample_ids), function(i) list(
    sample_id = sample_ids[i],
    condition = if (i <= 4L) "denominator" else "numerator",
    donor_code = paste0("D", i),
    unit_id = sample_ids[i],
    cell_metadata_column = "sample_id",
    cell_metadata_value = sample_ids[i]
  ))
)

missing <- error_message(condition_study_analysis(obj, list(recipe = "study_de", contrastId = "contrast_ab")))
check("study_de without a registered contrast is refused", grepl("registered condition contrast", missing))

result <- condition_study_analysis(
  obj,
  list(recipe = "study_de", contrastId = "contrast_ab"),
  design = design,
  contrast_labels = list(numerator = "disease", denominator = "control")
)
bundle <- result$figureBundle
check("study_de returns an investigation bundle", identical(bundle$schema, "traceomics.standard-figure.v1"))
design_rows <- bundle$tables$design$rows
check("the design table lists the registered samples", length(design_rows) == 8L)
check(
  "the design table carries the registered numerator assignment",
  sum(vapply(design_rows, function(row) identical(row[[2]], "numerator"), logical(1))) == 4L
)
check("the summary records the contrast id", identical(bundle$scientificSummary$contrastId, "contrast_ab"))
check("numerator/denominator are no longer free parameters", is.null(bundle$scientificSummary$numerator))

# Organism: pathway and communication recipes never assume human.
mouse_symbols <- sort(AnnotationDbi::keys(org.Mm.eg.db::org.Mm.eg.db, keytype = "SYMBOL"))
mouse_symbols <- mouse_symbols[grepl("^[A-Z][a-z][a-z0-9]+$", mouse_symbols)]
mouse_symbols <- mouse_symbols[seq(1L, by = 100L, length.out = n_genes)]
mouse_mapping <- study_symbol_mapping(mouse_symbols, "mouse")
check("mouse symbols map with the mouse annotation database", mouse_mapping$mapping_rate >= 0.95)
check("the mapping reports its species", identical(mouse_mapping$species, "mouse"))
human_on_mouse <- error_message(study_symbol_mapping(mouse_symbols, "human"))
check(
  "a human request on mouse symbols is refused with the mapping rate",
  grepl("map to human Entrez IDs \\(minimum 60%\\); check that species matches the data", human_on_mouse)
)
check("an unknown species is refused", grepl("Choose species", error_message(study_symbol_mapping(mouse_symbols, "rat"))))

mouse_obj <- obj
mouse_counts <- counts
rownames(mouse_counts) <- mouse_symbols
mouse_obj <- CreateSeuratObject(counts = as(mouse_counts, "dgCMatrix"), meta.data = cells)
mouse_obj <- NormalizeData(mouse_obj, verbose = FALSE)
pathway_params <- list(recipe = "study_pathways", contrastId = "contrast_ab", targetGroup = "0")
check(
  "study_pathways without species is refused",
  grepl("Choose species", error_message(condition_study_analysis(mouse_obj, pathway_params, design = design)))
)
pathway_params$species <- "human"
check(
  "study_pathways with human species on mouse data is refused before GO scoring",
  grepl("check that species matches the data", error_message(condition_study_analysis(mouse_obj, pathway_params, design = design)))
)

if (failures > 0L) {
  cat(failures, "check(s) failed\n")
  quit(status = 1L)
}
cat("All workbench contrast checks passed\n")
