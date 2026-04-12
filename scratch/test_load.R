library(Seurat)
print("Loading data...")
tryCatch({
  mat <- Read10X('data/pbmc3k/filtered_gene_bc_matrices/hg19')
  print(dim(mat))
  print("Success")
}, error = function(e) {
  print(paste("Error:", e$message))
})
