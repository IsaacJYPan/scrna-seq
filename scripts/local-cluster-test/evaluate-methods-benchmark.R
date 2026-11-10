# Post-freeze methods-only annotation comparison. No functional/condition analysis.
suppressPackageStartupMessages({library(Seurat);library(jsonlite);library(ggplot2)})
stopifnot(file.exists('/output/author-freeze-lock.json'))
config<-fromJSON('/fixture/evaluation-input.json');annotation<-fromJSON(config$annotation)
bundle<-readRDS(config$checkpoint);obj<-bundle$global;rm(bundle);invisible(gc())
meta<-obj[[]];groups<-as.character(meta$seurat_clusters);labels<-unlist(annotation$clusterToPopulation)
stopifnot(setequal(unique(groups),names(labels)))
semantic<-unname(labels[groups])
strict_labels<-if(is.null(annotation$finerStateMap))labels else unlist(annotation$finerStateMap)
stopifnot(setequal(names(strict_labels),unique(groups)))
canonical<-function(label,strict=FALSE) {
 text<-gsub('[^a-z0-9]+','_',tolower(label))
 if(grepl('mixed|mixture|doublet|ambiguous|nkt|t_nk|nk_t',text))return('Unknown')
 prefix<-gsub('[^a-z0-9]+','_',tolower(strsplit(label,';',fixed=TRUE)[[1]][1]))
 if(grepl('unresolved|unknown',text)) {
  narrower_uncertainty<-grepl('subtype',text)||(grepl('gamma_delta',text)&&grepl('cytotoxic_t',prefix))
  if(!narrower_uncertainty)return('Unknown')
 }
 text<-prefix
 if(grepl('unknown|unresolved|low.?quality',text))return('Unknown')
 if(grepl('platelet|megakary',text))return('Platelet')
 if(grepl('plasmacytoid|pdc',text))return(if(strict)'pDC' else 'DC')
 if(grepl('dendritic|cdc|mdc|(^|_)dc($|_)',text))return(if(strict&&!grepl('conventional|cdc|mdc|cd1c',text))'Unknown' else 'DC')
 if(grepl('monocyt',text)) {
  if(!strict)return('Monocyte')
  if(grepl('cd16|nonclassical|non_classical|fcgr3a',text))return('CD16_Monocyte')
  if(grepl('cd14|classical',text))return('CD14_Monocyte')
  return('Unknown')
 }
 if(grepl('(^|_)nk($|_)|natural.?killer',text))return('NK')
 if(grepl('(^|_)b($|_)|b_?cells?',text))return('B')
 if(grepl('(^|_)t($|_)|t_?cells?|cd4|cd8|cytotoxic_t',text)) {
  if(!strict)return('T')
  if(grepl('cd4',text))return('CD4_T')
  if(grepl('cd8|cytotoxic',text))return('Cytotoxic_T')
 }
 'Unknown'
}
truth<-read.delim(config$reference,stringsAsFactors=FALSE,check.names=FALSE)
stopifnot(all(c('NAME','CellType')%in%names(truth)))
manifest<-fromJSON(config$sourceManifest);prefixes<-setNames(manifest$sourcePrefix,manifest$sampleName)
stopifnot(all(meta$sample_id%in%names(prefixes)))
selected_reference<-Reduce(`|`,lapply(unname(prefixes),function(p)startsWith(truth$NAME,paste0(p,'_'))))
barcode<-sub('-[0-9]+$','',sub('^sample[0-9]+_','',rownames(meta)))
stopifnot(all(grepl('^[ACGT]{16}$',barcode)))
keys<-paste(unname(prefixes[meta$sample_id]),barcode,sep='_')
stopifnot(!anyNA(keys),!anyDuplicated(keys),!anyDuplicated(truth$NAME))
idx<-match(keys,truth$NAME);shared<-!is.na(idx)
stopifnot(any(shared))
truth_strict<-c('Cytotoxic T cell'='Cytotoxic_T','CD4+ T cell'='CD4_T','CD14+ monocyte'='CD14_Monocyte','B cell'='B','Megakaryocyte'='Platelet','CD16+ monocyte'='CD16_Monocyte','Natural killer cell'='NK','Dendritic cell'='DC','Plasmacytoid dendritic cell'='pDC','Unassigned'='Unknown')
truth_broad<-c('Cytotoxic_T'='T','CD4_T'='T','CD14_Monocyte'='Monocyte','CD16_Monocyte'='Monocyte','B'='B','Platelet'='Platelet','NK'='NK','DC'='DC','pDC'='DC','Unknown'='Unknown')
stopifnot(all(truth$CellType%in%names(truth_strict)))
out<-'/output/evaluation';dir.create(out,showWarnings=FALSE)
metrics_all<-list();mappings<-list()
for(level in c('broad','strict')) {
 strict<-level=='strict';source_labels<-if(strict)strict_labels else labels
 mapped<-setNames(vapply(source_labels,canonical,character(1),strict=strict),names(source_labels));predicted<-unname(mapped[groups]);mappings[[level]]<-as.list(mapped)
 actual<-unname(truth_strict[truth$CellType[idx[shared]]]);if(!strict)actual<-unname(truth_broad[actual])
 eligible<-actual!='Unknown';actual_scored<-actual[eligible];predicted_scored<-predicted[shared][eligible]
 classes<-if(strict)c('B','CD4_T','Cytotoxic_T','CD14_Monocyte','CD16_Monocyte','DC','pDC','NK','Platelet') else c('B','T','Monocyte','DC','NK','Platelet')
 confusion<-table(reference=factor(actual_scored,levels=classes),predicted=factor(predicted_scored,levels=c(classes,'Unknown')))
 write.csv(as.data.frame.matrix(confusion),file.path(out,paste0(level,'-annotation-confusion.csv')))
 metrics<-do.call(rbind,lapply(classes,function(label){tp<-sum(actual_scored==label&predicted_scored==label);fp<-sum(actual_scored!=label&predicted_scored==label);fn<-sum(actual_scored==label&predicted_scored!=label);precision<-if(tp+fp)tp/(tp+fp) else 0;recall<-if(tp+fn)tp/(tp+fn) else 0;data.frame(class=label,reference_cells=sum(actual_scored==label),predicted_cells=sum(predicted_scored==label),precision=precision,recall=recall,f1=if(precision+recall)2*precision*recall/(precision+recall) else 0)}))
 write.csv(metrics,file.path(out,paste0(level,'-annotation-class-metrics.csv')),row.names=FALSE)
 selected_classes<-unname(truth_strict[truth$CellType[selected_reference]])
 if(!strict)selected_classes<-unname(truth_broad[selected_classes])
 coverage<-do.call(rbind,lapply(c(classes,'Unknown'),function(label)data.frame(class=label,selected_library_reference_cells=sum(selected_classes==label),retained_reference_cells=sum(actual==label),retained_fraction=if(sum(selected_classes==label))sum(actual==label)/sum(selected_classes==label) else NA_real_)))
 write.csv(coverage,file.path(out,paste0(level,'-reference-coverage.csv')),row.names=FALSE)
 by_library<-do.call(rbind,lapply(unique(meta$sample_id),function(sample){sel<-meta$sample_id[shared][eligible]==sample;data.frame(sample=sample,shared_scored_cells=sum(sel),accuracy=if(any(sel))mean(actual_scored[sel]==predicted_scored[sel]) else NA_real_)}))
 score<-list(retainedCells=nrow(meta),researcherAnnotatedCellsWholeStudy=nrow(truth),selectedLibraryReferenceCells=sum(selected_reference),referenceCellsOutsideSelectedLibraries=sum(!selected_reference),sharedCells=sum(shared),sharedReferenceUnassigned=sum(!eligible),scoredSharedCells=sum(eligible),retainedWithoutResearcherLabel=sum(!shared),selectedLibraryReferenceLabelsNotRetained=sum(selected_reference&!truth$NAME%in%keys),accuracy=mean(actual_scored==predicted_scored),macroF1=mean(metrics$f1),unknownPredictions=sum(predicted_scored=='Unknown'),classMetrics=metrics,referenceCoverage=coverage,byLibrary=by_library)
 metrics_all[[level]]<-score
 frame<-as.data.frame(confusion)
 p<-ggplot(frame,aes(x=predicted,y=reference,fill=log10(Freq+1)))+geom_tile()+geom_text(aes(label=Freq),size=3)+scale_fill_gradient(low='white',high='#2166ac')+theme_classic(11)+theme(axis.text.x=element_text(angle=45,hjust=1))+labs(title=paste('Frozen healthy-PBMC annotations:',level,'comparison'),x='Blinded labels mapped by semantic rules',y='Researchers public cell-type labels',fill='log10(n+1)')
 ggsave(file.path(out,paste0(level,'-annotation-comparison.png')),p,width=10,height=6,dpi=200)
}
write_json(list(method='Semantic-only mapping; never optimized against overlaps. Strict scoring uses the frozen finerStateMap when supplied, otherwise the primary semantic map. Broad and strict results differ in declared resolution, not in retuned analysis.',originalLabels=as.list(labels),strictSourceLabels=as.list(strict_labels),mappings=mappings),file.path(out,'annotation-canonicalization.json'),auto_unbox=TRUE,pretty=TRUE)
write_json(metrics_all,file.path(out,'annotation-metrics.json'),auto_unbox=TRUE,pretty=TRUE)
write.csv(data.frame(cell=rownames(meta),sample=meta$sample_id,cluster=groups,blinded_label=semantic,reference_name=keys,shared=shared,reference_label=truth$CellType[idx]),file.path(out,'cell-annotation-comparison.csv'),row.names=FALSE)
cat(toJSON(lapply(metrics_all,function(x)x[c('retainedCells','sharedCells','scoredSharedCells','accuracy','macroF1')]),auto_unbox=TRUE,pretty=TRUE),'\n')
