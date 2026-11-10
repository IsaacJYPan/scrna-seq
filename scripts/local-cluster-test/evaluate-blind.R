suppressPackageStartupMessages({library(Seurat);library(jsonlite)})
selection<-fromJSON('/output/locked-selection.json')
truth<-read.csv('/fixture/reference/truth.csv',stringsAsFactors=FALSE)
reference<-fromJSON('/fixture/reference/preregistered.json')
obj<-readRDS('/output/selected-checkpoint.rds')$global
pred<-as.character(obj$seurat_clusters);names(pred)<-colnames(obj)
common<-intersect(truth$cell,names(pred));y<-truth$label[match(common,truth$cell)];z<-pred[common]
tab<-table(reference_label=y,app_cluster=z)
choose2<-function(v) sum(v*(v-1)/2)
n<-sum(tab);index<-choose2(tab);rows<-choose2(rowSums(tab));cols<-choose2(colSums(tab));expected<-rows*cols/choose2(n)
denominator<-(rows+cols)/2-expected
ari<-if(denominator==0) if(identical(index,expected)) 1 else 0 else (index-expected)/denominator
# Maximum one-to-one matching, with dummy columns when too few clusters exist.
# This penalizes overclustering rather than hiding it with many-to-one purity.
weights<-as.matrix(tab)
if(ncol(weights)<nrow(weights))weights<-cbind(weights,matrix(0,nrow(weights),nrow(weights)-ncol(weights)))
best<-list(score=-Inf,assignment=NULL)
search<-function(row,used,score,assignment){
  if(row>nrow(weights)){if(score>best$score)best<<-list(score=score,assignment=assignment);return(invisible(NULL))}
  for(column in setdiff(seq_len(ncol(weights)),used))search(row+1,c(used,column),score+weights[row,column],c(assignment,column))
}
search(1,integer(),0,integer())
accuracy<-best$score/n
purity<-sum(apply(tab,2,max))/n
all_retained<-length(common)==nrow(truth)&&ncol(obj)==nrow(truth)&&setequal(colnames(obj),truth$cell)
criteria<-list(all_cells_retained=all_retained,population_count_matches=nlevels(factor(z))==reference$criteria$population_count,adjusted_rand_index_pass=ari>=reference$criteria$adjusted_rand_index_min,best_label_accuracy_pass=accuracy>=reference$criteria$best_label_accuracy_min)
result<-list(reference=reference$source,scope='Complete post-QC 10x single-cell population recovery experiment, not every analysis in the paper',selected_analysis_object_id=selection$analysisObjectId,selected_job_id=selection$jobId,reference_cells=nrow(truth),app_cells=ncol(obj),reference_populations=nrow(tab),app_clusters=ncol(tab),adjusted_rand_index=ari,best_one_to_one_accuracy=accuracy,matched_cells=best$score,mismatched_or_unmatched_cells=n-best$score,additional_diagnostic_many_to_one_purity=purity,criteria=criteria,all_preregistered_criteria_pass=all(unlist(criteria)),reference_label_counts=as.list(rowSums(tab)),cluster_sizes=as.list(colSums(tab)),label_matching=as.list(setNames(colnames(weights)[best$assignment],rownames(weights))),limits='The child had a fresh conversation and received no reference information. This is procedural blinding, not a filesystem sandbox or a guarantee against pretrained familiarity. The app uses modern Seurat, not the paper historic software environment. Many-to-one purity is an additional diagnostic, not a prespecified pass criterion.')
write.csv(as.data.frame.matrix(tab),'/output/reference-confusion-matrix.csv')
write_json(result,'/output/blind-evaluation.json',auto_unbox=TRUE,pretty=TRUE,digits=NA)
write.csv(data.frame(cell=common,reference_label=y,app_cluster=unname(z)),'/output/cell-assignment-comparison.csv',row.names=FALSE)
print(result)
suppressPackageStartupMessages(library(ggplot2))
frame<-as.data.frame(tab)
figure<-ggplot(frame,aes(x=app_cluster,y=reference_label,fill=Freq))+
  geom_tile(color='white',linewidth=1)+geom_text(aes(label=Freq),size=5)+
  scale_fill_gradient(low='#f4f7fb',high='#3676ba')+theme_minimal(base_size=12)+
  labs(title='Blinded app analysis vs withheld reference labels',subtitle=sprintf('%d cells; adjusted Rand index %.4f; best one-to-one accuracy %.2f%%',n,ari,100*accuracy),x='Agent-selected app cluster',y='Authors\' genotype-based reference',fill='Cells',caption='Agent selection frozen before reference scoring. Full post-QC dataset; modern Seurat workflow.')+
  theme(panel.grid=element_blank(),plot.title=element_text(face='bold'))
ggsave('/output/reference-comparison.png',figure,width=9,height=4.8,dpi=160,bg='white')
