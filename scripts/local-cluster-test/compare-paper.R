suppressPackageStartupMessages({library(Seurat); library(ggplot2); library(jsonlite)})
out <- '/output'
obj <- readRDS(file.path(out,'paper-subset-ssh-checkpoint.rds'))$global
markers <- read.csv(file.path(out,'paper-subset-markers.csv'),check.names=FALSE)
cat('Marker columns:',colnames(markers),'\n')
panel <- c('CD3D','CD8A','NKG7','GNLY','CD79A','MS4A1','S100A8','S100A9','FCER1A','PF4')
panel <- intersect(panel,rownames(obj))
umap <- DimPlot(obj,reduction='umap',label=TRUE,pt.size=0.2)+
  labs(title='Zheng et al. PBMC data: 10,000-cell sample',subtitle='TraceOmics Seurat workflow via MCP and SSH; seed 42',caption='Partial biological reproduction: sample seed 20261108; modern Louvain/UMAP differs from original k-means/t-SNE.')+
  theme(plot.title=element_text(size=15),plot.subtitle=element_text(size=11),plot.caption=element_text(size=9))
ggsave(file.path(out,'paper-subset-umap.png'),umap,width=10,height=7,dpi=160,bg='white')
dots <- DotPlot(obj,features=panel)+theme_classic()+RotatedAxis()+labs(title='Published lineage markers across app-generated clusters',subtitle='Dot size: fraction expressing; color: scaled average expression',x=NULL,y='Seurat cluster')+
  theme(plot.title=element_text(size=14),plot.subtitle=element_text(size=10))
ggsave(file.path(out,'paper-subset-markers.png'),dots,width=10,height=7,dpi=160,bg='white')
gene_col <- if('gene' %in% colnames(markers)) 'gene' else if('feature' %in% colnames(markers)) 'feature' else stop('Unknown marker gene column')
group_col <- if('cluster' %in% colnames(markers)) 'cluster' else if('group' %in% colnames(markers)) 'group' else stop('Unknown marker group column')
fc_col <- if('avg_log2FC' %in% colnames(markers)) 'avg_log2FC' else 'avg_logFC'
p_col <- if('p_val_adj' %in% colnames(markers)) 'p_val_adj' else stop('Missing adjusted p values')
reference <- list(T_cells=c('CD3D'),NK_cells=c('NKG7','GNLY'),B_cells=c('CD79A'),myeloid=c('S100A8','S100A9'),megakaryocytes=c('PF4'))
checks <- lapply(reference,function(genes){
  rows <- markers[markers[[gene_col]] %in% genes & markers[[p_col]] < 0.05 & markers[[fc_col]] > 0.25,,drop=FALSE]
  list(reference_genes=genes,significant_genes=unique(rows[[gene_col]]),clusters=unique(as.character(rows[[group_col]])),any_reference_marker_recovered=nrow(rows)>0)
})
write.csv(markers[markers[[gene_col]] %in% unlist(reference),,drop=FALSE],file.path(out,'published-marker-comparison.csv'),row.names=FALSE)
sizes <- as.data.frame(table(obj$seurat_clusters));colnames(sizes)<-c('cluster','cells')
write.csv(sizes,file.path(out,'paper-cluster-sizes.csv'),row.names=FALSE)
result <- list(scope='10,000/68,579 cells; modern Seurat clustering, not exact original methods',source_doi='10.1038/ncomms14049',cells=ncol(obj),genes=nrow(obj),app_clusters=nlevels(Idents(obj)),paper_full_dataset_clusters=10,marker_rows=nrow(markers),reference_marker_checks=checks,all_reference_panels_recovered=all(vapply(checks,function(x)x$any_reference_marker_recovered,logical(1))),interpretation='Marker enrichment supports recovery of lineage signals. It does not establish exact cell type assignments, population proportions, or agreement with original cell labels. NKG7/GNLY also mark cytotoxic T cells; inspect co-expression with CD3D/CD8A.')
write_json(result,file.path(out,'paper-biological-comparison.json'),auto_unbox=TRUE,pretty=TRUE)
print(result)
