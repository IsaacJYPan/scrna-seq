# Trusted method: cellular niches from spatial neighborhoods.
# Upstream: Seurat vignette "Analysis of Image-based Spatial Data in Seurat",
# Xenium section "Niche analysis":
#   xenium.obj <- BuildNicheAssay(object = xenium.obj, fov = "fov",
#                   group.by = "predicted.celltype", niches.k = 5, neighbors.k = 30)
#   ImageDimPlot(xenium.obj, group.by = "niches", size = 1.5, dark.background = F)
#   table(xenium.obj$predicted.celltype, xenium.obj$niches)
# Each cell's niche is a k-means cluster of the cell-type composition of its
# spatial neighbors. Requires cell types to be annotated first.
analysis <- inputs$analysis
group_column <- params[["cell-type-column"]]
if (!group_column %in% colnames(analysis[[]])) stop("The cell type column is not in the cell metadata.")
fov <- params[["fov"]]
if (!nzchar(fov)) fov <- Images(analysis)[1]
if (is.na(fov) || !fov %in% Images(analysis)) stop("The field of view is not present in this analysis.")

set.seed(seed)
analysis <- BuildNicheAssay(object = analysis, fov = fov, group.by = group_column,
                            niches.k = params[["niches"]], neighbors.k = params[["neighbors"]])
analysis$niches <- as.character(analysis$niches)

composition <- as.data.frame.matrix(table(analysis[[group_column, drop = TRUE]], analysis$niches))
composition <- data.frame(cell_type = rownames(composition), composition, check.names = FALSE, row.names = NULL)
sizes <- table(analysis$niches)
write_output("analysis", analysis)
write_output("summary", list(
  n_niches = length(sizes),
  smallest_niche = as.integer(min(sizes)),
  largest_niche = as.integer(max(sizes)),
  n_cell_types = length(unique(analysis[[group_column, drop = TRUE]])),
  fov = fov
))
write_output("composition", composition)
write_output("figure", ImageDimPlot(analysis, fov = fov, group.by = "niches", size = 1.5, dark.background = FALSE), width = 9, height = 8)
