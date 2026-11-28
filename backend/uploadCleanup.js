'use strict';

const fs = require('fs');

// Removes Multer temporary files after a request finishes or fails.
function cleanupUploadedFiles(files) {
  for (const file of files.filter(Boolean)) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (err) {
      console.warn('[Upload] Failed to clean up temporary file:', err.message);
    }
  }
}

module.exports = { cleanupUploadedFiles };
