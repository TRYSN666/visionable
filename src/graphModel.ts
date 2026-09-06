import type { EndpointCluster, LinkPlane, TopologyLink, TopologyNode, TopologySnapshot } from "../shared/topology";

export interface GraphFilters {
  query: string;
  pods: Set<string>;
  roles: Set<string>;
  planes: Set<LinkPlane>;
  expandedClusters: Set<string>;
  selectedNodeIds: Set<string>;
  gpuSourceNodeIds: Set<string>;
  visibleGpuPods: Set<string>;
  simulationNodeIds?: ReadonlySet<string>;
}

export interface GraphNodeData {
  id: string;
  label: string;
  hostname: string;
  kind: "configured" | "external" | "cluster";
  role: string;
  pod: string;
  interfaceCount: number;
  memberCount?: number;
  cluster?: EndpointCluster;
  node?: TopologyNode;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  plane: LinkPlane;
  count: number;
  label: string;
  members: TopologyLink[];
}

export interface GraphModel {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  positions: Map<string, { x: number; y: number }>;
}

function nodeMatches(node: TopologyNode, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (`${node.hostname} ${node.label} ${node.role} ${node.pod} ${node.rack ?? ""}`.toLowerCase().includes(query)) {
    return true;
  }
  const serverText = node.serverInfo
    ? `${node.serverInfo.inBandIp ?? ""} ${node.serverInfo.outOfBandIp ?? ""}`
    : "";
  if (serverText.toLowerCase().includes(query)) return true;
  if (node.lids?.some((lid) => lid.toLowerCase().includes(query))) return true;
  return node.interfaces.some(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query) ||
      item.addresses.some((address) => address.cidr.toLowerCase().includes(query)),
  );
}

export function edgeTouchesSelection(edge: GraphEdgeData, selectedIds: ReadonlySet<string>): boolean {
  return edge.members.some((link) => selectedIds.has(link.source) || selectedIds.has(link.target));
}

export function edgeIsHighlighted(
  edge: GraphEdgeData,
  selectedNodeIds: ReadonlySet<string>,
  selectedEdgeIds: ReadonlySet<string>,
): boolean {
  return selectedEdgeIds.has(edge.id) || edgeTouchesSelection(edge, selectedNodeIds);
}

function allowed(node: TopologyNode, filters: GraphFilters): boolean {
  return Boolean(filters.simulationNodeIds?.has(node.id)) || filters.pods.has(node.pod) && filters.roles.has(node.role) && nodeMatches(node, filters.query);
}

const POD_ORDER = ["POD1", "POD2", "POD3", "SHARED", "UNKNOWN"];
const ROLE_LAYERS = [
  ["CSW", "IBCR"],
  ["SSW", "IBSP"],
  ["ASW", "IBLF"],
  ["HSS"],
  ["MGMT"],
  ["LSW"],
  ["SOOB"],
  ["OOB"],
  ["SERVER", "ENDPOINT", "UNKNOWN"],
] as const;

function roleLayer(role: string): number {
  const index = ROLE_LAYERS.findIndex((roles) => roles.some((candidate) => candidate === role));
  return index >= 0 ? index : ROLE_LAYERS.length - 1;
}

function makePositions(nodes: GraphNodeData[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const maxColumns = 8;
  const horizontalGap = 250;
  const verticalGap = 120;
  const layerGap = 230;
  const podColumnWidth = maxColumns * horizontalGap + 360;
  const podCenter = new Map(POD_ORDER.map((pod, index) => [pod, 1100 + index * podColumnWidth]));
  const buckets = new Map<string, GraphNodeData[]>();

  for (const node of nodes) {
    const key = `${roleLayer(node.role)}|${node.pod}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(node);
    buckets.set(key, bucket);
  }

  let currentY = 150;
  for (let layer = 0; layer < ROLE_LAYERS.length; layer += 1) {
    const layerBuckets = POD_ORDER.map((pod) => buckets.get(`${layer}|${pod}`) ?? []);
    const maxRows = Math.max(0, ...layerBuckets.map((bucket) => Math.ceil(bucket.length / maxColumns)));
    if (maxRows === 0) continue;

    for (let podIndex = 0; podIndex < POD_ORDER.length; podIndex += 1) {
      const pod = POD_ORDER[podIndex];
      const bucket = layerBuckets[podIndex];
      bucket.sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
      for (let index = 0; index < bucket.length; index += 1) {
        const row = Math.floor(index / maxColumns);
        const column = index % maxColumns;
        const countInRow = Math.min(maxColumns, bucket.length - row * maxColumns);
        positions.set(bucket[index].id, {
          x: (podCenter.get(pod) ?? podCenter.get("UNKNOWN")!) + (column - (countInRow - 1) / 2) * horizontalGap,
          y: currentY + row * verticalGap,
        });
      }
    }
    currentY += maxRows * verticalGap + layerGap;
  }
  return positions;
}

export function buildGraphModel(snapshot: TopologySnapshot, filters: GraphFilters): GraphModel {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const isDeferredServer = (node: TopologyNode): boolean =>
    node.kind === "external" && (node.endpointType === "GPU" || (snapshot.sourceType === "ports-csv" && node.role === "SERVER"));
  const clusterByNode = new Map<string, EndpointCluster>();
  for (const cluster of snapshot.clusters) {
    if (cluster.endpointType === "GPU") continue;
    for (const nodeId of cluster.nodeIds) {
      if (nodeById.get(nodeId)?.endpointType !== "GPU") clusterByNode.set(nodeId, cluster);
    }
  }

  const graphNodes = new Map<string, GraphNodeData>();
  for (const node of snapshot.nodes.filter((item) => item.kind === "configured")) {
    if (!allowed(node, filters)) continue;
    graphNodes.set(node.id, {
      id: node.id,
      label: node.hostname,
      hostname: node.hostname,
      kind: "configured",
      role: node.role,
      pod: node.pod,
      interfaceCount: node.interfaces.length,
      node,
    });
  }

  for (const cluster of snapshot.clusters) {
    if (cluster.endpointType === "GPU") continue;
    const members = cluster.nodeIds
      .map((id) => nodeById.get(id))
      .filter((node): node is TopologyNode => node !== undefined && node.endpointType !== "GPU");
    const matchingMembers = members.filter((node) => allowed(node, filters));
    if (matchingMembers.length === 0) continue;
    if (!filters.expandedClusters.has(cluster.id)) {
      graphNodes.set(cluster.id, {
        id: cluster.id,
        label: cluster.label,
        hostname: cluster.label,
        kind: "cluster",
        role: "ENDPOINT",
        pod: cluster.pod,
        interfaceCount: matchingMembers.reduce((sum, node) => sum + node.interfaces.length, 0),
        memberCount: matchingMembers.length,
        cluster: { ...cluster, nodeIds: matchingMembers.map((node) => node.id) },
      });
      continue;
    }
    for (const node of matchingMembers) {
      graphNodes.set(node.id, {
        id: node.id,
        label: node.hostname,
        hostname: node.hostname,
        kind: "external",
        role: "ENDPOINT",
        pod: node.pod,
        interfaceCount: node.interfaces.length,
        node,
      });
    }
  }

  const selectedSwitchIds = new Set(
    [...filters.gpuSourceNodeIds].filter((id) => graphNodes.get(id)?.kind === "configured"),
  );
  const visibleServerIds = new Set(
    snapshot.nodes
      .filter(
        (node) =>
          isDeferredServer(node) &&
          (filters.visibleGpuPods.has(node.pod) || filters.selectedNodeIds.has(node.id)) &&
          allowed(node, filters),
      )
      .map((node) => node.id),
  );
  for (const link of snapshot.links) {
    const candidateId = selectedSwitchIds.has(link.source)
      ? link.target
      : selectedSwitchIds.has(link.target)
        ? link.source
        : undefined;
    const candidate = candidateId ? nodeById.get(candidateId) : undefined;
    if (!candidate || !isDeferredServer(candidate)) continue;
    if (allowed(candidate, filters)) visibleServerIds.add(candidate.id);
  }

  for (const nodeId of visibleServerIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    graphNodes.set(node.id, {
      id: node.id,
      label: node.hostname,
      hostname: node.hostname,
      kind: "external",
      role: "ENDPOINT",
      pod: node.pod,
      interfaceCount: node.interfaces.length,
      node,
    });
  }

  for (const nodeId of filters.simulationNodeIds ?? []) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    graphNodes.set(node.id, {
      id: node.id,
      label: node.hostname,
      hostname: node.hostname,
      kind: node.kind,
      role: node.role,
      pod: node.pod,
      interfaceCount: node.interfaces.length,
      node,
    });
  }

  const displayId = (nodeId: string): string | undefined => {
    if (graphNodes.has(nodeId)) return nodeId;
    const node = nodeById.get(nodeId);
    if (node && isDeferredServer(node)) return undefined;
    const cluster = clusterByNode.get(nodeId);
    if (cluster && graphNodes.has(cluster.id)) return cluster.id;
    return undefined;
  };

  const aggregated = new Map<string, GraphEdgeData>();
  for (const link of snapshot.links) {
    if (!filters.planes.has(link.plane)) continue;
    const source = displayId(link.source);
    const target = displayId(link.target);
    if (!source || !target || source === target) continue;
    const [first, second] = [source, target].sort();
    const key = `${first}|${second}|${link.plane}`;
    const current = aggregated.get(key) ?? {
      id: `bundle:${key}`,
      source: first,
      target: second,
      plane: link.plane,
      count: 0,
      label: "",
      members: [],
    };
    current.count += 1;
    current.label = current.count > 1 ? `×${current.count}` : "";
    current.members.push(link);
    aggregated.set(key, current);
  }

  const nodes = [...graphNodes.values()];
  const positionNodes = snapshot.sourceType === "ports-csv"
    ? snapshot.nodes.map((node): GraphNodeData => ({
        id: node.id,
        label: node.hostname,
        hostname: node.hostname,
        kind: node.kind,
        role: node.role,
        pod: node.pod,
        interfaceCount: node.interfaces.length,
        node,
      }))
    : nodes;
  const allPositions = makePositions(positionNodes);
  const positions = new Map(nodes.map((node) => [node.id, allPositions.get(node.id)!]));
  for (const node of nodes) {
    const savedPosition = snapshot.layoutPositions[node.id];
    if (savedPosition) positions.set(node.id, savedPosition);
  }
  return { nodes, edges: [...aggregated.values()], positions };
}
