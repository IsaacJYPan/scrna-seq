# Post-freeze external reference scoring. Never supplied to the blinded author.
suppressPackageStartupMessages({library(Seurat);library(Matrix);library(jsonlite);library(ggplot2)})
stopifnot(file.exists('/output/author-freeze-lock.json'))
config<-fromJSON('/fixture/evaluation-input.json');annotation<-fromJSON(config$annotation)
source('/source/r-backend/lib/conditionComparison.R');source('/source/r-backend/lib/conditionStudy.R');source('/source/scripts/local-cluster-test/harness-design.R')
bundle<-readRDS(config$checkpoint);obj<-bundle$global;rm(bundle);invisible(gc())
meta<-obj[[]];counts<-LayerData(obj,assay='RNA',layer='counts');rm(obj);invisible(gc())
groups<-as.character(meta$seurat_clusters);labels<-unlist(annotation$clusterToPopulation)
stopifnot(setequal(unique(groups),names(labels)))
semantic<-unname(labels[groups])
canonical<-function(label){
 text<-tolower(label)
 if(grepl('unknown|unresolved|mixed|doublet|ambiguous|nkt|t_nk|nk_t',text))return('Unknown')
 if(grepl('plasmacytoid|pdc',text))return('pDC')
 if(grepl('plasma|plasmablast',text))return('Plasma')
 if(grepl('dendritic|cdc|mdc|(^|_)dc($|_)',text))return('mDC')
 if(grepl('macroph|monocyt|myeloid|alveolar|resident_am|(^|_)mac($|_)',text))return('Macrophages')
 if(grepl('mast',text))return('Mast')
 if(grepl('neutro',text))return('Neutrophil')
 if(grepl('epithel|ciliat|club|goblet|basal|pneumocyt',text))return('Epithelial')
 if(grepl('(^|_)nk($|_)|natural_killer',text))return('NK')
 if(grepl('(^|_)b($|_)|b_?cells?',text))return('B')
 if(grepl('(^|_)t($|_)|t_?cells?|cd4|cd8',text))return('T')
 'Unknown'
}
class_by_cluster<-setNames(vapply(labels,canonical,character(1)),names(labels));predicted<-unname(class_by_cluster[groups])
out<-'/output/evaluation';dir.create(out,showWarnings=FALSE)
write_json(list(method='Semantic-only canonicalization using predeclared rules; not optimized against reference overlaps',originalLabels=as.list(labels),canonicalClasses=as.list(class_by_cluster)),file.path(out,'annotation-canonicalization.json'),auto_unbox=TRUE,pretty=TRUE)
manifest<-fromJSON(config$sourceManifest);source_sample<-setNames(manifest$sourceSample,manifest$sampleName)
barcode<-sub('-[0-9]+$','',sub('^sample[0-9]+_','',rownames(meta)))
keys<-paste(unname(source_sample[meta$sample_id]),barcode,sep='::')
truth<-read.delim(config$reference,stringsAsFactors=FALSE,check.names=FALSE)
truth_keys<-paste(truth$sample,sub('_[0-9]+$','',truth$ID),sep='::')
stopifnot(!anyDuplicated(keys),!anyDuplicated(truth_keys))
idx<-match(keys,truth_keys);shared<-!is.na(idx);actual<-truth$celltype[idx[shared]]
classes<-c('B','Epithelial','Macrophages','Mast','mDC','Neutrophil','NK','pDC','Plasma','T')
confusion<-table(reference=factor(actual,levels=classes),predicted=factor(predicted[shared],levels=c(classes,'Unknown')))
write.csv(as.data.frame.matrix(confusion),file.path(out,'annotation-confusion.csv'))
metrics<-do.call(rbind,lapply(classes,function(label){tp<-sum(actual==label&predicted[shared]==label);fp<-sum(actual!=label&predicted[shared]==label);fn<-sum(actual==label&predicted[shared]!=label);precision<-if(tp+fp)tp/(tp+fp) else 0;recall<-if(tp+fn)tp/(tp+fn) else 0;data.frame(class=label,reference_cells=sum(actual==label),predicted_cells=sum(predicted[shared]==label),precision=precision,recall=recall,f1=if(precision+recall)2*precision*recall/(precision+recall) else 0)}))
write.csv(metrics,file.path(out,'annotation-class-metrics.csv'),row.names=FALSE)
score<-list(retainedCells=nrow(meta),authorAnnotatedCells=nrow(truth),sharedCells=sum(shared),retainedWithoutAuthorLabel=sum(!shared),authorLabelsNotRetained=sum(!truth_keys%in%keys),accuracy=mean(actual==predicted[shared]),macroF1=mean(metrics$f1),unknownPredictions=sum(predicted=='Unknown'),classMetrics=metrics)
write_json(score,file.path(out,'annotation-metrics.json'),auto_unbox=TRUE,pretty=TRUE)
frame<-as.data.frame(confusion)
p<-ggplot(frame,aes(x=predicted,y=reference,fill=log10(Freq+1)))+geom_tile()+geom_text(aes(label=Freq),size=2.7)+scale_fill_gradient(low='white',high='#2166ac')+theme_classic(11)+theme(axis.text.x=element_text(angle=45,hjust=1))+labs(title='Frozen blinded annotations versus published annotations',x='Blinded semantic labels mapped to publication classes',y='Published class',fill='log10(n+1)')
ggsave(file.path(out,'annotation-comparison.png'),p,width=10,height=6,dpi=200)
# Reconstruct only raw counts/metadata to reduce the independent scorer's memory.
obj<-CreateSeuratObject(counts,meta.data=meta,min.cells=0,min.features=0);rm(counts);invisible(gc())
anchors<-c('FCN1','S100A8','S100A9','CD14','SPP1','FABP4','MARCO','PPARG','CCL2','CCL3','CCL4','CXCL8','CXCL10','CXCL11','CXCL16','CCR1','CXCR2','CXCR3','CXCR6','GZMA','GZMK','FASLG','ITGA1','JAML')
anchor_results<-list();de_summaries<-list()
evaluation_labels<-list(blinded_semantic=semantic,canonical_broad=predicted)
if(!is.null(annotation$finerStateMap)) {
 finer<-unlist(annotation$finerStateMap)
 stopifnot(setequal(names(finer),unique(groups)))
 evaluation_labels$blinded_finer_state<-unname(finer[groups])
}
for(level in names(evaluation_labels)) {
 obj$seurat_clusters<-evaluation_labels[[level]]
 for(pair in list(c('severe','control'),c('severe','moderate'),c('moderate','control'))){
  design<-harness_metadata_design(obj,pair[1],pair[2]);de<-run_condition_pseudobulk_de(obj,design);contrast<-paste(pair,collapse='_vs_');hits<-de$table[de$table$gene%in%anchors,,drop=FALSE];hits$contrast<-contrast;hits$annotation_level<-level;key<-paste(level,contrast,sep='::');anchor_results[[key]]<-hits;de_summaries[[key]]<-de$summary
 }
}
write.csv(do.call(rbind,anchor_results),file.path(out,'postfreeze-reference-anchor-de.csv'),row.names=FALSE)
write_json(de_summaries,file.path(out,'postfreeze-de-countercheck-summary.json'),auto_unbox=TRUE,pretty=TRUE)
manuscript<-paste(readLines('/output/blinded/manuscript.md',warn=FALSE),collapse='\n')
write_json(list(independentlyMentionedAnchors=anchors[vapply(anchors,function(g)grepl(paste0('\\b',g,'\\b'),manuscript,perl=TRUE),logical(1))],note='Mention overlap is descriptive; it does not prove independent discovery or correctness. The author remained instruction-blinded, not protected from pretrained recognition.'),file.path(out,'manuscript-reference-anchor-overlap.json'),auto_unbox=TRUE,pretty=TRUE)
cat(toJSON(score[c('retainedCells','authorAnnotatedCells','sharedCells','accuracy','macroF1')],auto_unbox=TRUE,pretty=TRUE),'\n')
