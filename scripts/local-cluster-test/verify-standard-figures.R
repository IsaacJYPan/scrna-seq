suppressPackageStartupMessages({library(Seurat);library(Matrix);library(ggplot2);library(jsonlite)})
source('/source/r-backend/lib/standardFigures.R')
set.seed(21);counts<-as(matrix(rpois(18000,4),nrow=300),'CsparseMatrix');rownames(counts)<-c('MT-TEST',paste0('GENE',2:300));colnames(counts)<-paste0('cell',1:60)
obj<-CreateSeuratObject(counts);obj[['percent.mt']]<-PercentageFeatureSet(obj,pattern='^MT-');obj<-NormalizeData(obj,verbose=FALSE);obj<-FindVariableFeatures(obj,nfeatures=50,verbose=FALSE);obj<-ScaleData(obj,verbose=FALSE);obj<-RunPCA(obj,npcs=10,verbose=FALSE,seed.use=21);obj<-RunUMAP(obj,dims=1:10,n.neighbors=10,verbose=FALSE,seed.use=21);Idents(obj)<-factor(rep(0:2,each=20));obj$seurat_clusters<-Idents(obj)
recipes<-paste0('figure_',c('qc','pca','umap','heatmap','dot','feature'))
for(recipe in recipes){bundle<-standard_study_figure(obj,recipe)$figureBundle;png<-base64enc::base64decode(bundle$png);pdf<-rawToChar(base64enc::base64decode(bundle$pdf)[1:5]);svg<-rawToChar(base64enc::base64decode(bundle$svg));stopifnot(identical(as.integer(png[1:8]),c(137L,80L,78L,71L,13L,10L,26L,10L)),pdf=='%PDF-',grepl('<svg',svg,fixed=TRUE),nchar(toJSON(bundle))<12*1024^2);cat('PASS',recipe,'PNG/SVG/PDF\n')}
write_json(list(status='passed',syntheticDataOnly=TRUE,recipes=recipes,formats=c('png','svg','pdf')),'/output/figure-template-r-tests.json',auto_unbox=TRUE,pretty=TRUE)
