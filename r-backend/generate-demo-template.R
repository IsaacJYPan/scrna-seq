#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(jsonlite)
  library(Matrix)
  library(Seurat)
})

storage_root <- normalizePath(Sys.getenv("STORAGE_ROOT", unset="/app/storage-volume/data"), mustWork=TRUE)
pending_path <- file.path(storage_root, ".demo-template-bootstrap.json")
if (!file.exists(pending_path)) stop("No pending demo-template bootstrap record exists.")
pending <- fromJSON(pending_path, simplifyVector=TRUE)
checkpoint_key <- as.character(pending$checkpointKey)
if (length(checkpoint_key) != 1L || !grepl(
  "^projects/proj_[A-Za-z0-9_-]{3,128}/checkpoints/job_[A-Za-z0-9_-]{3,128}/checkpoint\\.rds$",
  checkpoint_key
)) stop("Pending checkpoint key is invalid.")

destination <- file.path(storage_root, checkpoint_key)
dir.create(dirname(destination), recursive=TRUE, showWarnings=FALSE, mode="0750")
parent <- normalizePath(dirname(destination), mustWork=TRUE)
portable_path <- function(value) chartr("\\", "/", value)
root_check <- portable_path(storage_root)
parent_check <- portable_path(parent)
if (.Platform$OS.type == "windows") {
  root_check <- tolower(root_check)
  parent_check <- tolower(parent_check)
}
if (!startsWith(paste0(parent_check, "/"), paste0(root_check, "/"))) {
  stop("Checkpoint destination escaped the storage root.")
}
if (file.exists(destination)) stop("Demo checkpoint already exists; refusing to overwrite it.")

set.seed(20260808)
marker_symbols <- c(
  "IL7R","CCR7","LTB","MALAT1","CD3D","CD3E","TRBC1","TRBC2","LEF1","MAL",
  "MS4A1","CD79A","CD37","CD74","CD22","HLA-DRA","CD83","CD84","BANK1","CD52",
  "LST1","S100A8","S100A9","CTSS","TYROBP","LGALS3","FCN1","CTSD","CTSB","LYZ",
  "NKG7","GNLY","CCL5","PRF1","GZMB","CTSW","KLRD1","TRAC","HCST","HOPX",
  "ISG15","IFIT1","IFIT2","IFIT3","MX1","OAS1","OAS2","STAT1","IRF7","IFI6",
  "ACTB","GAPDH","B2M","JUN","FOS","JUNB","DUSP1","IER2","RPLP0","RPS18"
)
genes <- c(marker_symbols, paste0("Gene", seq_len(200L - length(marker_symbols))))
cell_types <- rep(c("CD4 T","B","Monocyte","NK"), each=200L)
samples <- rep(rep(c("C1","C2","T1","T2"), each=50L), 4L)
conditions <- ifelse(samples %in% c("T1","T2"), "treated", "control")
counts <- matrix(rpois(length(genes) * length(cell_types), lambda=0.8), nrow=length(genes))
for (group_index in seq_len(4L)) {
  rows <- ((group_index - 1L) * 10L + 1L):(group_index * 10L)
  columns <- which(cell_types == c("CD4 T","B","Monocyte","NK")[[group_index]])
  counts[rows, columns] <- counts[rows, columns] + matrix(
    rpois(length(rows) * length(columns), lambda=6), nrow=length(rows)
  )
}
treated_columns <- which(conditions == "treated")
counts[41:50, treated_columns] <- counts[41:50, treated_columns] + matrix(
  rpois(10L * length(treated_columns), lambda=2.5), nrow=10L
)
rownames(counts) <- genes
colnames(counts) <- paste0("SyntheticCell", seq_len(ncol(counts)))

raw_object <- CreateSeuratObject(counts=Matrix(counts, sparse=TRUE), project="SyntheticPBMCDemo")
raw_object$sample_id <- samples
raw_object$condition <- conditions
raw_object$cell_type <- cell_types
raw_object$seurat_clusters <- factor(match(cell_types, c("CD4 T","B","Monocyte","NK")) - 1L)
Idents(raw_object) <- raw_object$cell_type

object <- NormalizeData(raw_object, verbose=FALSE)
object <- FindVariableFeatures(object, nfeatures=120, verbose=FALSE)
object <- ScaleData(object, features=VariableFeatures(object), verbose=FALSE)
object <- RunPCA(object, features=VariableFeatures(object), npcs=15, verbose=FALSE)
object <- FindNeighbors(object, dims=1:10, verbose=FALSE)
object <- RunUMAP(object, dims=1:10, n.neighbors=20, min.dist=0.25, seed.use=20260808, verbose=FALSE)

temporary <- paste0(destination, ".tmp-", Sys.getpid())
on.exit(if (file.exists(temporary)) unlink(temporary), add=TRUE)
saveRDS(list(global=object, raw=raw_object), temporary, compress="gzip")
if (!file.rename(temporary, destination)) stop("Could not atomically publish the demo checkpoint.")
Sys.chmod(destination, mode="0600")
cat(toJSON(list(
  checkpointKey=checkpoint_key,
  cells=ncol(object), features=nrow(object),
  reductions=names(object@reductions), synthetic=TRUE
), auto_unbox=TRUE), "\n", sep="")
