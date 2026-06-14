const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 8000,
  path: '/cellchat-infer',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(data);
  });
});

req.on('error', console.error);
req.write(JSON.stringify({ group_by: 'seurat_clusters', database: 'human' }));
req.end();
