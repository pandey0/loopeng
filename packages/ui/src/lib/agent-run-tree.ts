// Turns a flat list of agent runs (each optionally pointing at a parent via
// parentAgentRunId) into a forest, so a card's Activity tab can render the
// whole delegation tree — sub-agent runs nested under the run that spawned
// them — instead of a flat list. Pure and UI-free so it's unit-testable.

export interface AgentRunTreeInput {
  id: string;
  parentAgentRunId: string | null;
}

export interface AgentRunTreeNode<T extends AgentRunTreeInput> {
  run: T;
  children: AgentRunTreeNode<T>[];
}

/**
 * Builds the delegation forest, preserving the input's ordering at every
 * level (callers pass rows already sorted by startedAt). A run whose parent
 * isn't in the list (e.g. the parent belongs to another card, or the row was
 * filtered out) is treated as a root rather than dropped, so nothing ever
 * silently disappears from the Activity tab.
 */
export function buildAgentRunTree<T extends AgentRunTreeInput>(runs: T[]): AgentRunTreeNode<T>[] {
  const nodes = new Map<string, AgentRunTreeNode<T>>();
  for (const run of runs) {
    nodes.set(run.id, { run, children: [] });
  }

  const roots: AgentRunTreeNode<T>[] = [];
  for (const run of runs) {
    const node = nodes.get(run.id)!;
    const parent = run.parentAgentRunId ? nodes.get(run.parentAgentRunId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Depth-first flattening of the forest into render order, tagging each run with its depth for indentation. */
export function flattenAgentRunTree<T extends AgentRunTreeInput>(
  roots: AgentRunTreeNode<T>[],
): { run: T; depth: number }[] {
  const out: { run: T; depth: number }[] = [];
  const visit = (node: AgentRunTreeNode<T>, depth: number) => {
    out.push({ run: node.run, depth });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
}
