'use strict';

// Bounded scientific labels, never expressions or executable text.
function scientificText(kind,value) {
  if(typeof value!=='string'||value.length>3000)throw new Error(`Invalid ${kind}.`);
  if(value==='')return value;
  if(kind==='populationLabel'){if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value))throw new Error('Invalid population label.');return value;}
  const parts=value.split(kind==='geneList'?',':';');
  const pattern=kind==='geneList'?/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/:/^[A-Za-z0-9_.-]{1,80}=[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
  if(parts.length>(kind==='geneList'?12:64)||parts.some(p=>!pattern.test(p)))throw new Error(`Invalid ${kind}.`);
  const keys=parts.map(p=>p.split('=')[0]);
  if(new Set(keys).size!==keys.length)throw new Error(`Duplicate ${kind} entry.`);
  return value;
}
module.exports={scientificText};
