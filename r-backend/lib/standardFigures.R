standard_study_figure <- function(obj,recipe) {
  raster_points<-ncol(obj)>20000L
  features <- head(VariableFeatures(obj),if(recipe=="figure_heatmap")20L else if(recipe=="figure_feature")4L else 8L)
  p <- switch(recipe,
    figure_qc=VlnPlot(obj,features=intersect(c("nCount_RNA","nFeature_RNA","percent.mt"),colnames(obj@meta.data)),pt.size=0),
    figure_pca=ElbowPlot(obj,ndims=min(50L,ncol(Embeddings(obj,"pca")))),
    figure_umap=DimPlot(obj,reduction="umap",label=TRUE,repel=TRUE,pt.size=.3,raster=raster_points,raster.dpi=c(2048,2048)),
    figure_heatmap=DoHeatmap(obj,features=features),
    figure_dot=DotPlot(obj,features=features)+RotatedAxis(),
    figure_feature=FeaturePlot(obj,features=features,order=TRUE,raster=raster_points,raster.dpi=c(1024,1024)),stop("Unapproved figure recipe"))
  if(inherits(p,"patchwork"))p<-p & theme_classic(base_size=11) else p<-p+theme_classic(base_size=11)
  if(recipe=="figure_qc")p<-p & theme(legend.position="none")
  encode_study_figure(p,recipe,obj,features,summary=list(pointRendering=if(raster_points&&recipe%in%c("figure_umap","figure_feature"))"all_cells_raster_points_vector_axes" else "recipe_native",renderedCells=ncol(obj)))
}

encode_study_figure <- function(p,recipe,obj,features=character(),summary=NULL,tables=list()) {
  # ggplot's last-plot store can capture this call's full Seurat environment.
  # Exported media are sufficient; never retain private expression via graphics.
  on.exit(ggplot2::set_last_plot(NULL),add=TRUE)
  files<-setNames(vapply(c("png","svg","pdf"),function(format)tempfile(fileext=paste0(".",format)),character(1)),c("png","svg","pdf"))
  on.exit(unlink(files),add=TRUE)
  for(format in names(files))ggsave(files[[format]],p,width=8,height=5.5,dpi=300,bg="white",device=format,limitsize=TRUE)
  if(any(file.info(files)$size>4*1024^2))stop("Figure exceeds the preview/export budget.")
  list(figureBundle=c(list(schema="traceomics.standard-figure.v1",recipe=recipe,nCells=ncol(obj),features=as.list(features),rVersion=as.character(getRversion()),seuratVersion=as.character(packageVersion("Seurat")),scientificSummary=summary,tables=tables),lapply(files,function(file)base64enc::base64encode(file))))
}
