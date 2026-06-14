const http = require('http');

async function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1', port: 8001, path, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const r = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function run() {
  console.log("Loading dataset...");
  await req('GET', '/load-data?min_cells=3&min_features=200');
  console.log("QC...");
  await req('GET', '/qc?mt_threshold=5&min_features=200&max_features=2500&min_counts=0');
  console.log("Normalize...");
  await req('GET', '/normalize?method=LogNormalize&scale_factor=10000&nfeatures=2000');
  console.log("PCA...");
  await req('GET', '/pca?npcs=50');
  console.log("Cluster...");
  await req('GET', '/cluster?dims=10&resolution=0.5&algorithm=1');
  
  console.log("Enrichment...");
  let resEnrich = await req('GET', '/enrichment?database=GO_BP&pval_cutoff=0.05');
  if (resEnrich.body.error) {
    console.log("Enrichment Error:", resEnrich.body.error);
  } else {
    console.log("Enrichment Results: ", resEnrich.body.result.top_pathways.length, " pathways");
  }

  console.log("CellChat...");
  let resCellchat = await req('POST', '/cellchat-infer', { group_by: 'seurat_clusters', database: 'human' });
  if (resCellchat.body.error) {
    console.log("CellChat Error:", resCellchat.body.error);
  } else {
    console.log("CellChat Results: Nodes:", resCellchat.body.result.nodes.length, "Edges:", resCellchat.body.result.edges.length);
  }
}

run().catch(console.error);
