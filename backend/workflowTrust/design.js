'use strict';
const crypto=require('node:crypto');
async function snapshot(db,projectId,analysisObjectId,contrastId){
  const {rows}=await db.query('SELECT * FROM condition_contrasts WHERE id=$1 AND project_id=$2 AND analysis_object_id=$3',[contrastId,projectId,analysisObjectId]);
  if(rows.length!==1||rows[0].status==='invalid')throw Object.assign(new Error('A valid sponsor-defined contrast on the accepted input is required.'),{code:'INVALID_CONTRAST',status:409});
  const samples=await db.query('SELECT snapshot.*,sample.batch,sample.metadata_json FROM condition_contrast_samples snapshot JOIN biological_samples sample ON sample.id=snapshot.sample_id WHERE snapshot.contrast_id=$1 ORDER BY snapshot.sample_id',[contrastId]);
  if(samples.rows.length<4)throw Object.assign(new Error('At least four biological samples are required.'),{code:'INVALID_CONTRAST',status:409});
  return {contrast:rows[0],samples:samples.rows};
}
function digest(value){return crypto.createHash('sha256').update(require('./catalog').canonicalJson(value)).digest('hex');}
async function pinDesign(db,projectId,analysisObjectId,contrastId){return {contrastId,sha256:digest(await snapshot(db,projectId,analysisObjectId,contrastId))};}
async function verifyDesign(db,plan){const actual=await pinDesign(db,plan.projectId,plan.inputs.analysisObjectId,plan.design.contrastId);if(actual.sha256!==plan.design.sha256)throw Object.assign(new Error('The approved condition design changed before execution.'),{code:'WORKFLOW_DESIGN_CHANGED'});}
module.exports={pinDesign,verifyDesign};
