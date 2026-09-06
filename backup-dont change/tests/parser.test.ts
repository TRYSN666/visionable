import path from "node:path";
import { describe, expect, it } from "vitest";
import { NvueParseError, parseConfigDirectory, parseNvueDocument } from "../server/parser";
import { TopologyStore } from "../server/store";
import { DEVICE_ROLES, POD_NAMES } from "../shared/topology";
import { buildGraphModel } from "../src/graphModel";

describe("NVUE parser", () => {
  it("parses configured interfaces, primary IPs, VRR IPs and link declarations", () => {
    const parsed = parseNvueDocument(`
# target
nv set interface swp1-48 type swp
nv set interface swp1 description Link_MDC-DH1E-G13-42U-CSW-002_swp2_BW400G
nv set interface swp1 ip address 10.0.0.1/31
nv set interface vlan1000 ip address 10.1.0.1/24
nv set interface vlan1000 ip vrr address 10.1.0.254/24
nv set system hostname MDC-DH1E-G13-39U-CSW-001
`, "fixture.md");

    expect(parsed.node.role).toBe("CSW");
    expect(parsed.node.rack).toBe("G13");
    expect(parsed.node.interfaces.map((item) => item.name)).toEqual(["swp1", "vlan1000"]);
    expect(parsed.node.interfaces[1].addresses).toEqual([
      { cidr: "10.1.0.1/24", type: "primary" },
      { cidr: "10.1.0.254/24", type: "vrr" },
    ]);
    expect(parsed.links).toHaveLength(1);
  });

  it("rejects documents without an NVUE hostname", () => {
    expect(() => parseNvueDocument("nv set interface eth0 ip address 10.0.0.1/24", "broken.md")).toThrow(NvueParseError);
  });

  it("parses the current configuration baseline without exposing raw secrets", async () => {
    const snapshot = await parseConfigDirectory(path.resolve("device-config"));
    expect(snapshot.stats).toMatchObject({
      configuredDevices: 48,
      externalDevices: 654,
      physicalLinks: 2667,
      internalLinks: 738,
      externalLinks: 1929,
    });
    expect(snapshot.clusters.length).toBeGreaterThan(20);
    expect(snapshot.clusters.length).toBeLessThan(80);
    expect(snapshot.nodes.filter((node) => node.kind === "configured").every((node) => node.interfaces.length > 0)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/readonly-community|hashed-password|trap-destination|aaa user/i);
  });

  it("synchronizes the current GPU inventory into matching topology nodes", async () => {
    const store = new TopologyStore(path.resolve("device-config"));
    const snapshot = await store.refresh();
    expect(snapshot.stats).toMatchObject({ inventoryRecords: 624, inventoryMatched: 624, manualOverrides: 0 });
    expect(snapshot.nodes.filter((node) => node.serverInfo)).toHaveLength(624);
    expect(snapshot.nodes.filter((node) => node.serverInfo).every((node) => node.serverInfo?.inBandIp && node.serverInfo.outOfBandIp)).toBe(true);
    expect(snapshot.warnings.filter((warning) => warning.code === "INVENTORY_ROW_SKIPPED")).toHaveLength(2);
    expect(snapshot.warnings.filter((warning) => warning.code === "INVENTORY_DUPLICATE")).toHaveLength(1);

    const gpuById = new Map(snapshot.nodes.filter((node) => node.endpointType === "GPU").map((node) => [node.id, node]));
    const gpuLink = snapshot.links.find((link) => gpuById.has(link.source) || gpuById.has(link.target));
    expect(gpuLink).toBeDefined();
    const switchId = gpuById.has(gpuLink!.source) ? gpuLink!.target : gpuLink!.source;
    const commonFilters = {
      query: "",
      pods: new Set<string>(POD_NAMES),
      roles: new Set<string>(DEVICE_ROLES),
      planes: new Set(["production", "management"] as const),
      visibleGpuPods: new Set<string>(),
    };
    const hiddenModel = buildGraphModel(snapshot, { ...commonFilters, expandedClusters: new Set(), selectedNodeIds: new Set(), gpuSourceNodeIds: new Set() });
    expect(hiddenModel.nodes.some((node) => node.node?.endpointType === "GPU" || node.id.startsWith("gpu-cluster:"))).toBe(false);

    const selectedModel = buildGraphModel(snapshot, { ...commonFilters, expandedClusters: new Set(), selectedNodeIds: new Set([switchId]), gpuSourceNodeIds: new Set([switchId]) });
    const expectedGpuIds = new Set(snapshot.links.flatMap((link) => {
      if (link.source !== switchId && link.target !== switchId) return [];
      const peer = gpuById.get(link.source === switchId ? link.target : link.source);
      return peer ? [peer.id] : [];
    }));
    const visibleGpuIds = new Set(selectedModel.nodes.filter((node) => node.node?.endpointType === "GPU").map((node) => node.id));
    expect(visibleGpuIds).toEqual(expectedGpuIds);

    const pod = gpuById.get([...expectedGpuIds][0])!.pod;
    const podModel = buildGraphModel(snapshot, { ...commonFilters, visibleGpuPods: new Set([pod]), expandedClusters: new Set(), selectedNodeIds: new Set(), gpuSourceNodeIds: new Set() });
    const visibleGpuCount = podModel.nodes.filter((node) => node.node?.endpointType === "GPU" && node.pod === pod).length;
    const podGpuCount = snapshot.nodes.filter((node) => node.endpointType === "GPU" && node.pod === pod).length;
    expect(visibleGpuCount).toBe(podGpuCount);
  });
});
