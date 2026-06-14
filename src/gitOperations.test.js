import { describe, it, expect } from 'vitest';
import { forkBranch, setAsHead, mergeBranches, pruneNode } from './gitOperations';

describe('Git/DAG Operations', () => {

  const initialWorkspace = {
    activeBranch: 'main',
    branches: {
      'main': 'node-1'
    }
  };

  describe('forkBranch', () => {
    it('creates a new branch pointing to the specified node', () => {
      const result = forkBranch(initialWorkspace, 'experiment-1', 'node-2');
      
      expect(result.activeBranch).toBe('experiment-1');
      expect(result.branches['main']).toBe('node-1'); // original intact
      expect(result.branches['experiment-1']).toBe('node-2'); // new branch created
    });

    it('throws an error if the branch already exists', () => {
      expect(() => {
        forkBranch(initialWorkspace, 'main', 'node-3');
      }).toThrowError(/already exists/);
    });

    it('throws an error if arguments are missing', () => {
      expect(() => forkBranch(initialWorkspace, null, 'node-3')).toThrow();
    });
  });

  describe('setAsHead', () => {
    it('updates the active branch to point to a new node', () => {
      const result = setAsHead(initialWorkspace, 'node-3');
      
      expect(result.activeBranch).toBe('main');
      expect(result.branches['main']).toBe('node-3');
    });

    it('preserves other branches when updating HEAD', () => {
      const ws = {
        activeBranch: 'feature',
        branches: {
          'main': 'node-1',
          'feature': 'node-2'
        }
      };
      
      const result = setAsHead(ws, 'node-4');
      
      expect(result.branches['main']).toBe('node-1');
      expect(result.branches['feature']).toBe('node-4');
    });
  });

  describe('mergeBranches', () => {
    it('updates the target branch to point to the new merge node', () => {
      const ws = {
        activeBranch: 'feature',
        branches: {
          'main': 'node-1',
          'feature': 'node-2'
        }
      };

      // Simulating a merge of 'feature' INTO 'main'
      const mergeNodeId = 'node-3-merge';
      const result = mergeBranches(ws, 'main', 'feature', mergeNodeId);

      expect(result.activeBranch).toBe('main');
      expect(result.branches['main']).toBe(mergeNodeId);
      expect(result.branches['feature']).toBe('node-2'); // source remains unchanged
    });

    it('throws an error if target branch does not exist', () => {
      expect(() => {
        mergeBranches(initialWorkspace, 'nonexistent', 'main', 'node-x');
      }).toThrowError(/does not exist/);
    });
    
    it('throws an error if source branch does not exist', () => {
      expect(() => {
        mergeBranches(initialWorkspace, 'main', 'nonexistent', 'node-x');
      }).toThrowError(/does not exist/);
    });
  });

  describe('pruneNode', () => {
    it('filters out the specified node from the provenance records array', () => {
      const records = [
        { id: 'node-1', operation: 'load' },
        { id: 'node-2', operation: 'normalize' },
        { id: 'node-3', operation: 'pca' }
      ];

      const result = pruneNode(records, 'node-2');
      
      expect(result).toHaveLength(2);
      expect(result.map(n => n.id)).not.toContain('node-2');
    });

    it('returns an empty array if invalid input is provided', () => {
      expect(pruneNode(null, 'node-1')).toEqual([]);
      expect(pruneNode({}, 'node-1')).toEqual([]);
    });
  });

});
