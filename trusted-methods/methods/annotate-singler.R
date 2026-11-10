# Trusted method: reference-based cell-type annotation with SingleR.
# Upstream: "Assigning cell types with SingleR" (SingleR book), chapters
# "Introduction" and "Annotation diagnostics":
#   ref <- celldex::HumanPrimaryCellAtlasData()
#   pred <- SingleR(test = sce, ref = ref, labels = ref$label.main)
#   table(pred$labels); plotScoreHeatmap(pred); pred$pruned.labels
#   # cluster-level: SingleR(test = sce, ref = ref, clusters = sce$cluster, labels = ...)
# Aran D et al. 2019, Nat Immunol. The sandbox has no network, so celldex
# references are read from copies saved in the R image at build time
# (r-backend/Dockerfile); the reference is chosen from a fixed list.
if (!requireNamespace("SingleR", quietly = TRUE)) stop("SingleR is not installed in this R runtime. See trusted-methods/README.md.")
reference_files <- c(
  hpca = "HumanPrimaryCellAtlasData.rds", blueprint_encode = "BlueprintEncodeData.rds",
  monaco_immune = "MonacoImmuneData.rds", dice = "DatabaseImmuneCellExpressionData.rds",
  mouse_rnaseq = "MouseRNAseqData.rds", immgen = "ImmGenData.rds"
)
reference_path <- file.path("/opt/traceomics/references", reference_files[[params[["reference"]]]])
if (!file.exists(reference_path)) stop("This reference is not installed in the R image. See trusted-methods/README.md.")
ref <- readRDS(reference_path)
label_field <- if (identical(params[["label-level"]], "fine")) "label.fine" else "label.main"

analysis <- inputs$analysis
assay <- intersect(c("RNA", "Spatial", "Xenium"), Assays(analysis))[1]
DefaultAssay(analysis) <- assay
analysis[[assay]] <- JoinLayers(analysis[[assay]])
if (!"data" %in% SeuratObject::Layers(analysis[[assay]])) analysis <- NormalizeData(analysis, verbose = FALSE)
test <- SeuratObject::LayerData(analysis, assay = assay, layer = "data")
shared <- intersect(rownames(test), rownames(ref))
if (length(shared) < 500) stop("Fewer than 500 genes are shared with the reference; check the species.")

mode <- params[["mode"]]
clusters <- NULL
if (mode == "cluster") {
  column <- params[["cluster-column"]]
  if (!column %in% colnames(analysis[[]])) stop("The cluster column is not in the cell metadata.")
  clusters <- as.character(analysis[[column, drop = TRUE]])
}

# --- SingleR book: Introduction -------------------------------------------
pred <- SingleR::SingleR(test = test, ref = ref, labels = ref[[label_field]], clusters = clusters)
# -------------------------------------------------------------------------

if (mode == "cluster") {
  by_cluster <- setNames(pred$pruned.labels, rownames(pred))
  labels <- unname(by_cluster[clusters])
  per <- data.frame(cluster = rownames(pred), label = pred$labels, pruned_label = pred$pruned.labels,
                    delta_next = signif(pred$delta.next, 4))
} else {
  labels <- pred$pruned.labels
  column <- params[["cluster-column"]]
  per <- if (column %in% colnames(analysis[[]])) {
    tab <- as.data.frame(table(cluster = as.character(analysis[[column, drop = TRUE]]), label = ifelse(is.na(labels), "pruned", labels)), stringsAsFactors = FALSE)
    names(tab)[3] <- "cells"
    tab[tab$cells > 0, ]
  } else data.frame(label = names(table(labels)), cells = as.integer(table(labels)))
}
labels[is.na(labels)] <- "Unassigned"
target <- params[["label-column"]]
analysis[[target]] <- labels

write_output("analysis", analysis)
write_output("summary", list(
  n_labels = length(unique(labels)),
  fraction_unassigned = round(mean(labels == "Unassigned"), 4),
  genes_shared = length(shared),
  reference = params[["reference"]],
  label_level = params[["label-level"]],
  mode = mode
))
write_output("assignments", per)
write_output("figure", if ("umap" %in% Reductions(analysis)) DimPlot(analysis, group.by = target, label = TRUE, repel = TRUE) + NoLegend() else
  ggplot2::ggplot(data.frame(label = labels), ggplot2::aes(y = label)) + ggplot2::geom_bar() + ggplot2::theme_minimal())
