/**
 * Union-find clustering over a thresholded similarity matrix.
 *
 * Chosen over k-means (which needs the cluster count up front - that count is the thing
 * being discovered) and over DBSCAN (more parameters to tune for no benefit at this
 * scale). With a few dozen tracks the pairwise matrix is a few hundred comparisons, so
 * nothing cleverer is warranted.
 *
 * This is single-linkage, which can chain: A~B and B~C merges A and C even when A and C
 * are dissimilar. At a high threshold and this scale it is acceptable, and the golden set
 * is the check on whether it bites in practice.
 */
class DisjointSet {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array<number>(size).fill(0);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root]!;
    }
    // Path compression.
    let current = x;
    while (this.parent[current] !== root) {
      const next = this.parent[current]!;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank[rootA]!;
    const rankB = this.rank[rootB]!;
    if (rankA < rankB) {
      this.parent[rootA] = rootB;
    } else if (rankA > rankB) {
      this.parent[rootB] = rootA;
    } else {
      this.parent[rootB] = rootA;
      this.rank[rootA] = rankA + 1;
    }
  }
}

/**
 * Group indices whose pairwise similarity meets the threshold.
 *
 * Returns groups of indices, each group sorted ascending, and the groups themselves
 * ordered by their smallest member. Both orderings are explicit so the result never
 * depends on hash or iteration order.
 */
export function clusterByThreshold(
  count: number,
  similarity: (a: number, b: number) => number,
  threshold: number,
): number[][] {
  const sets = new DisjointSet(count);

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (similarity(i, j) >= threshold) {
        sets.union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const root = sets.find(i);
    const group = byRoot.get(root);
    if (group === undefined) {
      byRoot.set(root, [i]);
    } else {
      group.push(i);
    }
  }

  const groups = [...byRoot.values()].map((group) => [...group].sort((a, b) => a - b));
  groups.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  return groups;
}
