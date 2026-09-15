export function serializePipeline(pipeline) {
  return `${JSON.stringify(pipeline, null, 2)}\n`;
}
