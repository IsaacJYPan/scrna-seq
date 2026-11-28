const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function isInsidePath(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeVaultSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function isUnsafeUserPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  const normalized = path.normalize(value);
  return path.isAbsolute(value) || normalized.split(/[\\/]+/).includes('..');
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function getSafeRelativeSegments(relativePath) {
  const rawSegments = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  const safeSegments = rawSegments.map(segment => segment.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (safeSegments.length === 0 || safeSegments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid upload path.');
  }
  return safeSegments;
}

function createUserVault({ vaultDir }) {
  function getUserVaultDir(user) {
    const segment = sanitizeVaultSegment(user?.email);
    if (!segment) throw new Error('Authenticated user email is required.');
    return path.join(vaultDir, segment);
  }

  function resolveVaultPath(userPath, user) {
    if (isUnsafeUserPath(userPath)) {
      throw new Error('Path must be a relative vault path.');
    }

    const absolutePath = path.resolve(process.cwd(), userPath);
    if (!isInsidePath(absolutePath, getUserVaultDir(user))) {
      throw new Error('Path must stay within the authenticated user vault.');
    }

    return path.relative(process.cwd(), absolutePath);
  }

  function moveUploadIntoUserVault(file, user, relativePath = file.originalname) {
    const batchId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const segments = getSafeRelativeSegments(relativePath);
    const destinationRoot = path.join(getUserVaultDir(user), 'uploads', batchId);
    const destination = path.join(destinationRoot, ...segments);

    if (!isInsidePath(destination, destinationRoot) || !isInsidePath(destination, getUserVaultDir(user))) {
      throw new Error('Invalid upload destination.');
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(file.path, destination);
    return toPosixPath(path.relative(process.cwd(), destination));
  }

  function moveDirectoryUploadIntoUserVault(files, user, relativePaths = []) {
    if (!files || files.length === 0) throw new Error('No files uploaded.');

    const batchId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const destinationRoot = path.join(getUserVaultDir(user), 'uploads', batchId);
    const uploadedRelPaths = [];

    files.forEach((file, index) => {
      const relativePath = Array.isArray(relativePaths) ? relativePaths[index] : relativePaths;
      const segments = getSafeRelativeSegments(relativePath || file.originalname);
      const destination = path.join(destinationRoot, ...segments);
      if (!isInsidePath(destination, destinationRoot) || !isInsidePath(destination, getUserVaultDir(user))) {
        throw new Error('Invalid upload destination.');
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(file.path, destination);
      uploadedRelPaths.push(toPosixPath(path.relative(destinationRoot, destination)));
    });

    const firstSegments = uploadedRelPaths.map(p => p.split('/')[0]).filter(Boolean);
    const commonTop = firstSegments.length > 0 && firstSegments.every(segment => segment === firstSegments[0])
      ? firstSegments[0]
      : '';
    const root = commonTop ? path.join(destinationRoot, commonTop) : destinationRoot;
    return toPosixPath(path.relative(process.cwd(), root));
  }

  return {
    getUserVaultDir,
    resolveVaultPath,
    moveUploadIntoUserVault,
    moveDirectoryUploadIntoUserVault,
  };
}

module.exports = {
  isInsidePath,
  sanitizeVaultSegment,
  isUnsafeUserPath,
  toPosixPath,
  getSafeRelativeSegments,
  createUserVault,
};
