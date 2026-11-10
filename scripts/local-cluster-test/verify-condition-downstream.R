suppressPackageStartupMessages({library(Seurat);library(Matrix);library(ggplot2);library(jsonlite)})
for(file in c('standardFigures.R','conditionComparison.R','cellChatInference.R','conditionStudy.R'))source(file.path('/source/r-backend/lib',file))
set.seed(19);counts<-Read10X_h5('/source/scratch/blind-study/sample-A.h5');obj<-CreateSeuratObject(counts);obj<-NormalizeData(obj,verbose=FALSE)
obj$sample_id<-paste0('S',rep(1:8,length.out=ncol(obj)));obj$condition<-ifelse(as.integer(sub('S','',obj$sample_id))<=4,'A','B');obj$donor_code<-obj$sample_id;obj$seurat_clusters<-as.character(rep(c(0,0,0,0,1,1,1,1),length.out=ncol(obj)))
# Alternate groups within every donor, not a donor-confounded artificial label.
obj$seurat_clusters<-as.character((seq_len(ncol(obj))%/%8)%%2);Idents(obj)<-obj$seurat_clusters
for(recipe in if('--communication-only'%in%commandArgs(TRUE))'study_communication' else c('study_pathways','study_communication')){
  if(recipe=='study_communication'){obj<-readRDS('/source/exports/evolved-study/blinded/selected-checkpoint.rds')$global;obj$sample_id<-paste0('S',rep(1:8,length.out=ncol(obj)));obj$condition<-ifelse(as.integer(sub('S','',obj$sample_id))<=4,'A','B');obj$donor_code<-obj$sample_id}
  result<-condition_study_analysis(obj,list(recipe=recipe,groupMap=if(recipe=='study_communication')'' else '0=PopulationA;1=PopulationB',targetGroup='PopulationA',conditionName=if(recipe=='study_communication')'A' else 'all',numerator='B',denominator='A'))
  stopifnot(length(result$figureBundle$tables)>0,length(base64enc::base64decode(result$figureBundle$png))>1000)
  if(recipe=='study_communication')stopifnot(result$figureBundle$tables$group_mapping$rows[[1]][[1]]=='Group 1')
  cat('PASS',recipe,'\n')
}
write_json(list(status='passed',usesUnrelatedEarlierBenchmark=TRUE,checks=c('edgeR_ranked_GO','bounded_condition_specific_CellChat','explicit_group_alias_mapping','native_figure_bundle')),'/output/downstream-r-tests.json',auto_unbox=TRUE,pretty=TRUE)
