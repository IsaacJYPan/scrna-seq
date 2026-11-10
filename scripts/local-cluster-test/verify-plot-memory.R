suppressPackageStartupMessages({library(Seurat);library(Matrix);library(ggplot2);library(jsonlite)})
source('/source/r-backend/lib/standardFigures.R')
state<-new.env();state$collected<-FALSE
make_private_plot<-function(){
  private_environment<-new.env();private_environment$unused_data<-rep(1,1000)
  reg.finalizer(private_environment,function(e)state$collected<-TRUE)
  counts<-sparseMatrix(i=rep(1L,20),j=1:20,x=1,dims=c(1,20),dimnames=list('GENE',paste0('C',1:20)))
  obj<-CreateSeuratObject(counts)
  p<-ggplot(data.frame(x=1:20,y=1:20),aes(x,y))+geom_point()
  stopifnot(!is.null(get_last_plot()))
  encode_study_figure(p,'synthetic_memory_check',obj)
}
bundle<-make_private_plot();invisible(gc(full=TRUE))
stopifnot(is.null(get_last_plot()),isTRUE(state$collected),length(base64enc::base64decode(bundle$figureBundle$png))>1000)
write_json(list(status='passed',syntheticOnly=TRUE,lastPlotCleared=TRUE,privatePlotEnvironmentGarbageCollected=TRUE,nativeMediaStillProduced=TRUE),'/output/plot-memory-r-tests.json',auto_unbox=TRUE,pretty=TRUE)
cat('PASS plot cache cleared and captured private data environment garbage-collected\n')
