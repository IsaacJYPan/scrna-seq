library(Seurat)
mat <- Read10X("../data/pbmc3k/filtered_gene_bc_matrices/hg19")
obj <- CreateSeuratObject(mat, min.cells = 3, min.features = 200)
obj[["percent.mt"]] <- PercentageFeatureSet(obj, pattern = "^MT-")
obj <- subset(obj, subset = nFeature_RNA > 200 & nFeature_RNA < 2500 & percent.mt < 5 & nCount_RNA > 500)
obj <- NormalizeData(obj)
obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 2000)
obj <- ScaleData(obj)
obj <- RunPCA(obj)
obj <- FindNeighbors(obj, dims = 1:10)
obj <- FindClusters(obj, resolution = 0.5)
obj <- RunUMAP(obj, dims = 1:10, n.components = 3)

cat("Running DimPlot...\n")
dim_args <- list(
  object = obj,
  reduction = "umap",
  group.by = "seurat_clusters",
  pt.size = 1.0,
  alpha = 1.0,
  label = FALSE,
  label.size = 4,
  repel = TRUE,
  cols = RColorBrewer::brewer.pal(8, "Set2")
)

p <- do.call(DimPlot, dim_args)
cat("Running PDF print...\n")
pdf("test_out2.pdf", width=7, height=5)
print(p)
dev.off()

cat("Running JPEG print...\n")
jpeg("test_out2.jpg", width=6, height=4.5, units="in", res=150, quality=85)
print(p)
dev.off()

cat("Done!\n")
