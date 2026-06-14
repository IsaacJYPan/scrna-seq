library(Seurat)
library(CellChat)

# Create dummy data with 2 groups and very few cells
mat <- matrix(rnorm(100*20), nrow=100, ncol=20)
rownames(mat) <- paste0("Gene", 1:100) # These won't match CellChatDB!
# Let's add exactly 1 matching gene to trigger the "numeric" error
rownames(mat)[1] <- "IL2"
colnames(mat) <- paste0("Cell", 1:20)

obj <- CreateSeuratObject(counts = mat)
obj$group <- sample(c("A", "B"), 20, replace=TRUE)

CellChatDB <- CellChatDB.human
CellChatDB.use <- CellChatDB

data.input <- GetAssayData(obj, assay = "RNA", layer = "data")
meta <- obj@meta.data
meta$group <- factor(meta$group)

cellchat <- createCellChat(object = data.input, meta = meta, group.by = "group")
cellchat@DB <- CellChatDB.use

cat("Running subsetData...\n")
cellchat <- subsetData(cellchat)
cat("Success!\n")
