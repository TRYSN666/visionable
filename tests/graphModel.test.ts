import { describe, expect, it } from "vitest";
import type { TopologySnapshot } from "../shared/topology";
import { buildGraphModel, edgeIsHighlighted, edgeTouchesSelection } from "../src/graphModel";

const snapshot: TopologySnapshot = {
  revision: "test",
  refreshedAt: new Date(0).toISOString(),
  stats: { configuredDevices: 1, externalDevices: 3, physicalLinks: 2, internalLinks: 0, externalLinks: 2, usedInterfaces: 1, sourceFiles: 1, inventoryRecords: 1, inventoryMatched: 1, manualOverrides: 0 },
  warnings: [],
  nodes: [
    { id: "device:a", kind: "configured", hostname: "MDC-POD1-ASW-001", label: "POD1-ASW-001", role: "ASW", pod: "POD1", lids: ["1717"], interfaces: [{ name: "swp1", addresses: [{ cidr: "10.0.0.1/31", type: "primary" }], peers: [] }] },
    { id: "external:b", kind: "external", hostname: "POD1-GPU-001", label: "GPU-001", role: "ENDPOINT", pod: "POD1", endpointType: "GPU", interfaces: [{ name: "eth0", addresses: [], peers: [] }], clusterId: "cluster:1", serverInfo: { inBandIp: "172.16.0.1", outOfBandIp: "192.168.0.1", manualOverride: false } },
    { id: "external:c", kind: "external", hostname: "POD1-GPU-002", label: "GPU-002", role: "ENDPOINT", pod: "POD1", endpointType: "GPU", interfaces: [{ name: "eth0", addresses: [], peers: [] }], clusterId: "cluster:1" },
    { id: "external:d", kind: "external", hostname: "POD1-GPU-003", label: "GPU-003", role: "ENDPOINT", pod: "POD1", endpointType: "GPU", interfaces: [{ name: "eth0", addresses: [], peers: [] }], clusterId: "cluster:1" },
  ],
  links: [
    { id: "l1", source: "device:a", target: "external:b", sourceInterface: "swp1", targetInterface: "eth0", plane: "production", confidence: "inferred", reciprocal: false },
    { id: "l2", source: "device:a", target: "external:c", sourceInterface: "swp2", targetInterface: "eth0", plane: "production", confidence: "inferred", reciprocal: false },
  ],
  clusters: [{ id: "cluster:1", label: "POD1 · A区 · GPU", pod: "POD1", rack: "A区", endpointType: "GPU", nodeIds: ["external:b", "external:c", "external:d"] }],
  layoutPositions: { "device:a": { x: 123, y: 456 } },
};

function filters(query = "", selectedNodeIds = new Set<string>(), visibleGpuPods = new Set<string>()) {
  return { query, pods: new Set(["POD1"]), roles: new Set(["ASW", "ENDPOINT"]), planes: new Set(["production"] as const), expandedClusters: new Set<string>(), selectedNodeIds, gpuSourceNodeIds: selectedNodeIds, visibleGpuPods };
}

describe("graph model", () => {
  it("hides every GPU until a connected switch is selected", () => {
    const model = buildGraphModel(snapshot, filters());
    expect(model.nodes.map((node) => node.id)).toEqual(["device:a"]);
    expect(model.nodes[0].label).toBe("MDC-POD1-ASW-001");
    expect(model.edges).toHaveLength(0);
    expect(model.positions.get("device:a")).toEqual({ x: 123, y: 456 });

    const selected = buildGraphModel(snapshot, filters("", new Set(["device:a"])));
    expect(selected.nodes.map((node) => node.id)).toEqual(["device:a", "external:b", "external:c"]);
    expect(selected.nodes.some((node) => node.id === "external:d")).toBe(false);
    expect(selected.edges).toHaveLength(2);
  });

  it("shows every GPU in a POD only when its operation button is active", () => {
    const model = buildGraphModel(snapshot, filters("", new Set(), new Set(["POD1"])));
    expect(model.nodes.map((node) => node.id)).toEqual(["device:a", "external:b", "external:c", "external:d"]);
    expect(model.edges).toHaveLength(2);
  });

  it("supports interface/IP search without revealing GPUs by default", () => {
    const searched = buildGraphModel(snapshot, filters("10.0.0.1"));
    expect(searched.nodes.map((node) => node.id)).toEqual(["device:a"]);
    expect(buildGraphModel(snapshot, filters("1717")).nodes.map((node) => node.id)).toEqual(["device:a"]);

    const hiddenGpuSearch = buildGraphModel(snapshot, filters("172.16.0.1"));
    expect(hiddenGpuSearch.nodes).toHaveLength(0);
  });

  it("marks an aggregated edge when any physical member touches the selection", () => {
    const edge = buildGraphModel(snapshot, filters("", new Set(["device:a"]))).edges[0];
    expect(edgeTouchesSelection(edge, new Set(["external:b"]))).toBe(true);
    expect(edgeTouchesSelection(edge, new Set(["missing"]))).toBe(false);
    expect(edgeIsHighlighted(edge, new Set(), new Set([edge.id]))).toBe(true);
    expect(edgeIsHighlighted(edge, new Set(), new Set(["another-edge"]))).toBe(false);
  });

  it("keeps IB POD columns and hierarchy rows separate while revealing only directly connected servers", () => {
    const coreNodes = Array.from({ length: 18 }, (_, index) => ({
      id: `ibcr:${index}`,
      kind: "configured" as const,
      hostname: `MDC-G${String(index + 1).padStart(2, "0")}-IBCR-${index + 1}`,
      label: `IBCR-${index + 1}`,
      role: "IBCR" as const,
      pod: "SHARED" as const,
      interfaces: [],
    }));
    const spine = { id: "ibsp:1", kind: "configured" as const, hostname: "MDC-POD1-IBSP-001", label: "IBSP-001", role: "IBSP" as const, pod: "POD1" as const, interfaces: [] };
    const leaf = { id: "iblf:1", kind: "configured" as const, hostname: "MDC-POD1-IBLF-001", label: "IBLF-001", role: "IBLF" as const, pod: "POD1" as const, interfaces: [] };
    const server = { id: "gpu:1", kind: "external" as const, hostname: "MDC-POD1-GPU-001", label: "GPU-001", role: "ENDPOINT" as const, pod: "POD1" as const, endpointType: "GPU", lids: ["41"], interfaces: [] };
    const ibSnapshot: TopologySnapshot = {
      revision: "ib",
      refreshedAt: new Date(0).toISOString(),
      sourceType: "ports-csv",
      stats: { configuredDevices: 20, externalDevices: 1, physicalLinks: 3, internalLinks: 2, externalLinks: 1, usedInterfaces: 0, sourceFiles: 1, inventoryRecords: 0, inventoryMatched: 0, manualOverrides: 0 },
      warnings: [],
      nodes: [...coreNodes, spine, leaf, server],
      links: [
        { id: "ib-1", source: coreNodes[0].id, target: spine.id, sourceInterface: "1", targetInterface: "1", plane: "production", confidence: "reciprocal", reciprocal: true },
        { id: "ib-2", source: spine.id, target: leaf.id, sourceInterface: "2", targetInterface: "2", plane: "production", confidence: "reciprocal", reciprocal: true },
        { id: "ib-3", source: leaf.id, target: server.id, sourceInterface: "3", targetInterface: "eth0", plane: "production", confidence: "reciprocal", reciprocal: true },
      ],
      clusters: [],
      layoutPositions: {},
    };
    const ibFilters = (selected = new Set<string>()) => ({
      query: "",
      pods: new Set(["POD1", "SHARED"]),
      roles: new Set(["IBCR", "IBSP", "IBLF", "ENDPOINT"]),
      planes: new Set(["production"] as const),
      expandedClusters: new Set<string>(),
      selectedNodeIds: selected,
      gpuSourceNodeIds: selected,
      visibleGpuPods: new Set<string>(),
    });

    const hidden = buildGraphModel(ibSnapshot, ibFilters());
    expect(hidden.nodes.some((node) => node.id === server.id)).toBe(false);
    const coreMaxY = Math.max(...coreNodes.map((node) => hidden.positions.get(node.id)!.y));
    expect(hidden.positions.get(spine.id)!.y).toBeGreaterThan(coreMaxY);
    expect(hidden.positions.get(leaf.id)!.y).toBeGreaterThan(hidden.positions.get(spine.id)!.y);
    expect(hidden.positions.get(coreNodes[0].id)!.x).toBeGreaterThan(hidden.positions.get(spine.id)!.x);
    expect(new Set([...hidden.positions.values()].map((position) => `${position.x}:${position.y}`)).size).toBe(hidden.positions.size);

    const revealed = buildGraphModel(ibSnapshot, ibFilters(new Set([leaf.id])));
    expect(revealed.nodes.some((node) => node.id === server.id)).toBe(true);
    expect(revealed.edges.some((edge) => edge.members.some((link) => link.id === "ib-3"))).toBe(true);
  });

  it("does not reveal unrelated links of a passively displayed device", () => {
    const secondSwitch: TopologySnapshot["nodes"][number] = {
      id: "device:second", kind: "configured", hostname: "MDC-POD1-ASW-002", label: "POD1-ASW-002", role: "ASW", pod: "POD1", interfaces: [],
    };
    const sharedServer: TopologySnapshot["nodes"][number] = {
      id: "external:shared", kind: "external", hostname: "POD1-GPU-010", label: "GPU-010", role: "ENDPOINT", pod: "POD1", endpointType: "GPU", interfaces: [],
    };
    const multiHomed: TopologySnapshot = {
      ...snapshot,
      nodes: [...snapshot.nodes, secondSwitch, sharedServer],
      links: [
        ...snapshot.links,
        { id: "selected-to-server", source: "device:a", target: sharedServer.id, sourceInterface: "swp10", targetInterface: "eth0", plane: "production", confidence: "declared", reciprocal: false },
        { id: "other-to-server", source: secondSwitch.id, target: sharedServer.id, sourceInterface: "swp10", targetInterface: "eth1", plane: "production", confidence: "declared", reciprocal: false },
      ],
    };

    const model = buildGraphModel(multiHomed, filters("", new Set(["device:a"])));
    expect(model.nodes.some((node) => node.id === sharedServer.id)).toBe(true);
    expect(model.edges.some((edge) => edge.members.some((link) => link.id === "selected-to-server"))).toBe(true);
    expect(model.edges.some((edge) => edge.members.some((link) => link.id === "other-to-server"))).toBe(false);
  });
});
