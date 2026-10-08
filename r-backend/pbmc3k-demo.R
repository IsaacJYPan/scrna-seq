# Public 10x PBMC3k reference used by the Seurat guided clustering tutorial.
# Only called at image build time. No invented labels, replicates or conditions.
build_pbmc3k_demo <- function(directory) {
  suppressPackageStartupMessages({ library(Seurat); library(Matrix) })
  expected <- c(
    'barcodes.tsv'='58c2a224a2b4258f7e8799a18890bda6d23824b247b80db2b08a0dcc36a4c660',
    'genes.tsv'='8778dd78085086be6dcafa8334f95f7cf76b25526e8ef2b63186db5127a1492c',
    'matrix.mtx'='7d92358b9d29128a225c50f2a662d6ccca9c71bc665e0af82692ed1361eb94e4')
  for (name in names(expected)) {
    if (!identical(digest::digest(file=file.path(directory,name), algo='sha256'), expected[[name]])) {
      stop('PBMC3k input checksum mismatch: ', name)
    }
  }
  raw <- CreateSeuratObject(Read10X(directory), project='PBMC3k', min.cells=3, min.features=200)
  raw[['percent.mt']] <- PercentageFeatureSet(raw, pattern='^MT-')
  raw$sample_id <- 'PBMC3k'
  obj <- subset(raw, subset=nFeature_RNA > 200 & nFeature_RNA < 2500 & percent.mt < 5)
  obj@misc$traceomics_pipeline <- list(qc=TRUE)
  obj <- NormalizeData(obj, normalization.method='LogNormalize', scale.factor=10000, verbose=FALSE)
  obj <- FindVariableFeatures(obj, selection.method='vst', nfeatures=2000, verbose=FALSE)
  obj <- ScaleData(obj, features=rownames(obj), verbose=FALSE)
  obj <- RunPCA(obj, features=VariableFeatures(obj), npcs=50, seed.use=42, verbose=FALSE)
  obj <- FindNeighbors(obj, dims=1:10, verbose=FALSE)
  obj <- FindClusters(obj, resolution=.5, random.seed=0, verbose=FALSE)
  obj <- RunUMAP(obj, dims=1:10, n.neighbors=30, min.dist=.3, seed.use=42, verbose=FALSE)
  stopifnot(ncol(raw)==2700L, ncol(obj)==2638L, nrow(obj)==13714L)
  obj@misc$traceomics_demo <- list(dataset='pbmc3k', synthetic=FALSE,
    sourceUrl='https://cf.10xgenomics.com/samples/cell/pbmc3k/pbmc3k_filtered_gene_bc_matrices.tar.gz',
    sourceSha256='847d6ebd9a1ec9a768f2be7e40ca42cbfe75ebeb6d76a4c24167041699dc28b5',
    tutorialUrl='https://satijalab.org/seurat/articles/pbmc3k_tutorial',
    clustering='Seurat graph clustering; numeric identities are not cell-type annotations',
    singleSample=TRUE, umap=list(dims=10L,n_neighbors=30L,min_dist=.3,seed=42L))
  list(global=obj, raw=raw)
}
