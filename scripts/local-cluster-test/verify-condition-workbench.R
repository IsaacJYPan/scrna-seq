suppressPackageStartupMessages({library(Seurat);library(Matrix);library(ggplot2);library(jsonlite)})
source('/source/r-backend/lib/standardFigures.R');source('/source/r-backend/lib/conditionComparison.R');source('/source/r-backend/lib/conditionStudy.R')
set.seed(51);x<-matrix(rpois(120*640,4),nrow=120);rownames(x)<-c('MT-TEST',paste0('GENE',2:120));colnames(x)<-paste0('cell',1:640)
sample<-rep(paste0('S',1:8),each=80);condition<-rep(rep(c('A','B'),each=4),each=80);group<-rep(rep(c('0','1'),each=40),8)
x[2:8,condition=='B']<-x[2:8,condition=='B']+10
obj<-CreateSeuratObject(as(x,'CsparseMatrix'));obj$sample_id<-sample;obj$condition<-condition;obj$donor_code<-sample;obj$seurat_clusters<-group;Idents(obj)<-group;obj[['percent.mt']]<-PercentageFeatureSet(obj,pattern='^MT-');obj<-NormalizeData(obj,verbose=FALSE)
for(recipe in c('study_composition','study_qc','study_expression','study_de')){
  b<-condition_study_analysis(obj,list(recipe=recipe,featureNames='GENE2,GENE3',groupMap='0=Myeloid;1=T_cells',numerator='B',denominator='A'))$figureBundle
  stopifnot(length(base64enc::base64decode(b$png))>1000,length(b$tables)>0)
  if(recipe=='study_de'){hits<-b$tables$de_hits;stopifnot(any(vapply(hits$rows,function(r)r[[2]]=='GENE2'&&r[[3]]>0,logical(1))))}
  cat('PASS',recipe,'\n')
}
stopifnot(inherits(try(study_group_map(obj,'0=Only'),silent=TRUE),'try-error'))
bad<-obj;bad$donor_code<-'D1';stopifnot(inherits(try(study_condition_design(bad,'B','A'),silent=TRUE),'try-error'))
write_json(list(status='passed',syntheticOnly=TRUE,checks=c('four_recipes','positive_known_condition_signal','incomplete_annotation_refused','pseudoreplication_refused')),'/output/workbench-r-tests.json',auto_unbox=TRUE,pretty=TRUE)
