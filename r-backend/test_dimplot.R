library(Seurat)
cat("Loading matrix...\n")
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

cat("Running UMAP 2D...\n")
obj <- RunUMAP(obj, dims = 1:10, n.components = 2)

cat("Running UMAP 3D...\n")
obj <- RunUMAP(obj, dims = 1:10, n.components = 3)

cat("Plotting UMAP...\n")
p <- DimPlot(obj, reduction = "umap")

cat("Saving PDF...\n")
pdf("test_out.pdf", width=7, height=5)
print(p)
dev.off()

cat("Done!\n")
