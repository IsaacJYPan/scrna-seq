/**
 * gitOperations.js
 * 
 * Pure functions to manipulate the workspace's Git-like branch state.
 * These functions take the current state and return the updated state.
 */

/**
 * Creates a new branch pointing to a specific node.
 * @param {Object} currentWs - The current workspace object.
 * @param {string} newBranchName - The name of the new branch.
 * @param {string} targetNodeId - The node ID to fork from.
 * @returns {Object} The updated workspace object.
 */
export function forkBranch(currentWs, newBranchName, targetNodeId) {
  if (!currentWs || !newBranchName || !targetNodeId) {
    throw new Error("Missing required arguments for forkBranch");
  }
  
  if (currentWs.branches && currentWs.branches[newBranchName]) {
    throw new Error(`Branch '${newBranchName}' already exists.`);
  }

  return {
    ...currentWs,
    activeBranch: newBranchName,
    branches: {
      ...(currentWs.branches || {}),
      [newBranchName]: targetNodeId
    }
  };
}

/**
 * Sets the active branch's HEAD to a specific node.
 * @param {Object} currentWs - The current workspace object.
 * @param {string} targetNodeId - The node ID to set as HEAD.
 * @returns {Object} The updated workspace object.
 */
export function setAsHead(currentWs, targetNodeId) {
  if (!currentWs || !currentWs.activeBranch || !targetNodeId) {
    throw new Error("Missing required arguments for setAsHead");
  }

  return {
    ...currentWs,
    branches: {
      ...(currentWs.branches || {}),
      [currentWs.activeBranch]: targetNodeId
    }
  };
}

/**
 * Merges a source branch into a target branch. 
 * This logically updates the target branch to point to a new "merge node"
 * which you must create via the provenance API before calling this.
 * 
 * @param {Object} currentWs - The current workspace object.
 * @param {string} targetBranch - The branch to merge INTO (and update).
 * @param {string} sourceBranch - The branch to merge FROM.
 * @param {string} mergeNodeId - The ID of the newly created merge node.
 * @returns {Object} The updated workspace object.
 */
export function mergeBranches(currentWs, targetBranch, sourceBranch, mergeNodeId) {
  if (!currentWs || !targetBranch || !sourceBranch || !mergeNodeId) {
    throw new Error("Missing required arguments for mergeBranches");
  }

  if (!currentWs.branches || !currentWs.branches[targetBranch]) {
    throw new Error(`Target branch '${targetBranch}' does not exist.`);
  }

  if (!currentWs.branches[sourceBranch]) {
    throw new Error(`Source branch '${sourceBranch}' does not exist.`);
  }

  return {
    ...currentWs,
    activeBranch: targetBranch, // automatically switch to the target branch if not already
    branches: {
      ...currentWs.branches,
      [targetBranch]: mergeNodeId
    }
  };
}

/**
 * Logically prunes a node from the visible history by returning a filtered array.
 * Note: A real implementation would also need to delete descendant nodes or 
 * reparent them to avoid orphaned subgraphs. This is a simple filter.
 * 
 * @param {Array} provenanceRecords - Array of node objects.
 * @param {string} nodeIdToRemove - The ID to remove.
 * @returns {Array} The filtered array.
 */
export function pruneNode(provenanceRecords, nodeIdToRemove) {
  if (!provenanceRecords || !Array.isArray(provenanceRecords)) return [];
  
  return provenanceRecords.filter(node => node.id !== nodeIdToRemove);
}
