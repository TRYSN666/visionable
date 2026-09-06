export interface GraphSelection {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export interface SelectionTarget {
  kind: "node" | "edge";
  id: string;
}

export function emptyGraphSelection(): GraphSelection {
  return { nodeIds: new Set(), edgeIds: new Set() };
}

export function updateGraphSelection(
  current: GraphSelection,
  target?: SelectionTarget,
  additive = false,
): GraphSelection {
  if (!target) return emptyGraphSelection();
  if (!additive) {
    return target.kind === "node"
      ? { nodeIds: new Set([target.id]), edgeIds: new Set() }
      : { nodeIds: new Set(), edgeIds: new Set([target.id]) };
  }
  const nodeIds = new Set(current.nodeIds);
  const edgeIds = new Set(current.edgeIds);
  const ids = target.kind === "node" ? nodeIds : edgeIds;
  if (ids.has(target.id)) ids.delete(target.id);
  else ids.add(target.id);
  return { nodeIds, edgeIds };
}

export function updateGraphBoxSelection(
  current: GraphSelection,
  nodeIdsToAdd: Iterable<string>,
  additive = false,
): GraphSelection {
  const nodeIds = additive ? new Set(current.nodeIds) : new Set<string>();
  for (const id of nodeIdsToAdd) nodeIds.add(id);
  return { nodeIds, edgeIds: additive ? new Set(current.edgeIds) : new Set() };
}

export function shouldShowHoveredNode(selection: GraphSelection, nodeId: string): boolean {
  return selection.nodeIds.size <= 1 || !selection.nodeIds.has(nodeId);
}
