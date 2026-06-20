const http = require('http');

function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port: 8005,
      path,
      method,
      headers: {
        'X-Object-ID': 'test-run',
        'X-API-Token': 'testtoken',
        ...(data && {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        })
      }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  console.log('Loading data...');
  let r = await req('GET', '/load-data?dataset=pbmc3k');
  console.log(r.status, r.body.substring(0, 500));
  console.log('QC Distributions...');
  r = await req('GET', '/qc-distributions');
  console.log(r.status, r.body.substring(0, 500));
  console.log('QC...');
  r = await req('POST', '/qc', { min_features: 200, max_features: 2500, max_percent_mt: 5 });
  console.log(r.status, r.body.substring(0, 500));
  console.log('Normalize...');
  r = await req('GET', '/normalize');
  console.log(r.status, r.body.substring(0, 500));
  console.log('PCA...');
  r = await req('GET', '/pca');
  console.log(r.status, r.body.substring(0, 500));
  console.log('Cluster...');
  r = await req('GET', '/cluster?resolution=0.5');
  console.log(r.status, r.body.substring(0, 500));
  console.log('UMAP 2D...');
  r = await req('GET', '/umap?n_components=2');
  console.log(r.status, r.body.substring(0, 500));
  console.log('UMAP 3D...');
  r = await req('GET', '/umap?n_components=3');
  console.log(r.status, r.body.substring(0, 500));
  console.log('Export Figure...');
  const start = Date.now();
  const res = await req('POST', '/export-figure', {
    plot_type: 'UMAP',
    format: 'pdf',
    width: 7,
    height: 5,
    group_by: 'seurat_clusters'
  });
  console.log(`Export took ${Date.now() - start}ms`);
  console.log('STATUS:', res.status);
  console.log('BODY:', res.body.substring(0, 500));
}

run().catch(console.error);
