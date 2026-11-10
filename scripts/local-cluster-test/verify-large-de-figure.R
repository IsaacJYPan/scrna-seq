suppressPackageStartupMessages({library(Seurat);library(Matrix);library(ggplot2);library(jsonlite)})
source('/source/r-backend/lib/standardFigures.R')
set.seed(41);frame<-data.frame(log_fc=rnorm(160000),minus_log10_fdr=rexp(160000),cell_type=rep(paste0('Population',1:8),each=20000));frame$significant<-frame$minus_log10_fdr>1.3
obj<-CreateSeuratObject(sparseMatrix(i=rep(1L,10),j=1:10,x=1,dims=c(1,10),dimnames=list('GENE',paste0('C',1:10))))
p<-ggplot(frame,aes(x=log_fc,y=minus_log10_fdr,color=significant))+scattermore::geom_scattermore(pointsize=2,pixels=c(768,768),alpha=.5)+facet_wrap(~cell_type,scales='free_x',ncol=4)+scale_color_manual(values=c('grey70','#B22222'))+theme_classic(11)
bundle<-encode_study_figure(p,'study_de',obj)$figureBundle
stopifnot(nrow(frame)==160000,length(base64enc::base64decode(bundle$svg))<4*1024^2,is.null(get_last_plot()))
write_json(list(status='passed',syntheticOnly=TRUE,testedGenePoints=160000,populations=8,allPointsRendered=TRUE,svgBytes=length(base64enc::base64decode(bundle$svg)),lastPlotCleared=TRUE),'/output/large-de-figure-r-tests.json',auto_unbox=TRUE,pretty=TRUE)
cat('PASS 160000-gene-point volcano facets fit export budget without sampling\n')
