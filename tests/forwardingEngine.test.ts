import { describe, expect, it } from "vitest";
import type { ForwardingInterface, ForwardingSnapshotData } from "../shared/forwarding";
import type { InterfaceRecord, TopologyLink, TopologyNode, TopologySnapshot } from "../shared/topology";
import { traceForwarding } from "../server/forwardingEngine";

function networkInterface(name: string, address?: string): InterfaceRecord {
  return { name, addresses: address ? [{ cidr: address, type: "primary" }] : [], peers: [] };
}

function node(id: string, interfaces: InterfaceRecord[]): TopologyNode {
  return { id, kind: "configured", hostname: id.toUpperCase(), label: id.toUpperCase(), role: "ASW", pod: "POD1", interfaces };
}

function link(id: string, source: string, sourceInterface: string, target: string, targetInterface: string): TopologyLink {
  return { id, source, sourceInterface, target, targetInterface, plane: "production", confidence: "reciprocal", reciprocal: true };
}

function topology(nodes: TopologyNode[], links: TopologyLink[]): TopologySnapshot {
  return {
    revision: "test", refreshedAt: "2026-09-04T00:00:00.000Z", sourceType: "ports-csv", nodes, links, clusters: [], layoutPositions: {}, warnings: [],
    stats: { configuredDevices: nodes.length, externalDevices: 0, physicalLinks: links.length, internalLinks: links.length, externalLinks: 0, usedInterfaces: nodes.reduce((sum, item) => sum + item.interfaces.length, 0), sourceFiles: 1, inventoryRecords: 0, inventoryMatched: 0, manualOverrides: 0 },
  };
}

function forwardingInterface(deviceId: string, interfaceName: string, overrides: Partial<ForwardingInterface> = {}): ForwardingInterface {
  return { row: 2, deviceId, deviceName: deviceId.toUpperCase(), interfaceName, interfaceType: "physical", forwardingMode: "routed", vrf: "default", allowedVlans: [], status: "up", ...overrides };
}

function data(overrides: Partial<ForwardingSnapshotData> = {}): ForwardingSnapshotData {
  return {
    metadata: { templateVersion: "1.0", batchName: "test", collectedAt: "2026-09-04T00:00:00.000Z" },
    interfaces: [], lagMembers: [], routes: [], arpEntries: [], macEntries: [], vxlanEntries: [], ...overrides,
  };
}

describe("abstract forwarding engine", () => {
  it("uses longest-prefix forwarding and expands every route in one ECMP group", () => {
    const graph = topology(
      [
        node("a", [networkInterface("lo", "10.0.0.1/32"), networkInterface("p1"), networkInterface("p2")]),
        node("b", [networkInterface("p1"), networkInterface("lo", "10.9.0.1/32")]),
        node("c", [networkInterface("p1"), networkInterface("lo", "10.9.0.1/32")]),
      ],
      [link("ab", "a", "p1", "b", "p1"), link("ac", "a", "p2", "c", "p1")],
    );
    const table = data({
      interfaces: [forwardingInterface("a", "p1"), forwardingInterface("a", "p2")],
      routes: [
        { row: 2, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "0.0.0.0/0", action: "drop" },
        { row: 3, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "10.9.0.0/24", action: "forward", nextHop: "192.0.2.2", outputInterface: "p1", ecmpGroup: "ecmp-1" },
        { row: 4, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "10.9.0.0/24", action: "forward", nextHop: "192.0.2.3", outputInterface: "p2", ecmpGroup: "ecmp-1" },
      ],
      arpEntries: [
        { row: 2, deviceId: "a", deviceName: "A", vrf: "default", ip: "192.0.2.2", mac: "00:00:00:00:00:02", interfaceName: "p1", status: "reachable" },
        { row: 3, deviceId: "a", deviceName: "A", vrf: "default", ip: "192.0.2.3", mac: "00:00:00:00:00:03", interfaceName: "p2", status: "reachable" },
      ],
    });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "a", sourceIp: "10.0.0.1", destinationIp: "10.9.0.1" });
    expect(result.transitions.map((item) => item.topologyLinkId).sort()).toEqual(["ab", "ac"]);
    expect(result.endpoints.filter((item) => item.code === "DELIVERED")).toHaveLength(2);
    expect(result.states[0].evidence?.filter((item) => item.sheet === "路由表")).toHaveLength(2);
  });

  it("expands a LAG with more than 64 live members without a hidden branch cap", () => {
    const targets = Array.from({ length: 65 }, (_, index) => `t${index}`);
    const sourceInterfaces = [networkInterface("lo", "10.0.0.1/32"), ...targets.map((_, index) => networkInterface(`p${index}`)), networkInterface("lag0")];
    const graph = topology(
      [node("s", sourceInterfaces), ...targets.map((id) => node(id, [networkInterface("p0"), networkInterface("lo", "10.99.0.1/32")]))],
      targets.map((id, index) => link(`link-${index}`, "s", `p${index}`, id, "p0")),
    );
    const table = data({
      interfaces: [
        forwardingInterface("s", "lag0", { interfaceType: "lag" }),
        ...targets.map((_, index) => forwardingInterface("s", `p${index}`)),
      ],
      lagMembers: targets.map((_, index) => ({ row: index + 2, deviceId: "s", deviceName: "S", aggregateInterface: "lag0", memberInterface: `p${index}`, status: "up" })),
      routes: [{ row: 2, deviceId: "s", deviceName: "S", vrf: "default", destinationCidr: "10.99.0.0/24", action: "forward", nextHop: "192.0.2.2", outputInterface: "lag0" }],
      arpEntries: [{ row: 2, deviceId: "s", deviceName: "S", vrf: "default", ip: "192.0.2.2", mac: "00:00:00:00:00:02", interfaceName: "lag0", status: "reachable" }],
    });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "s", sourceIp: "10.0.0.1", destinationIp: "10.99.0.1" });
    expect(result.transitions).toHaveLength(65);
    expect(result.endpoints.filter((item) => item.code === "DELIVERED")).toHaveLength(65);
  });

  it("encapsulates and decapsulates an L2VNI while preserving the abstract inner addresses", () => {
    const graph = topology(
      [
        node("leaf1", [networkInterface("lo", "10.1.0.1/32"), networkInterface("svi100"), networkInterface("p1")]),
        node("leaf2", [networkInterface("lo", "172.16.0.2/32"), networkInterface("p1"), networkInterface("p2")]),
        node("host", [networkInterface("eth0", "10.10.0.8/24")]),
      ],
      [link("fabric", "leaf1", "p1", "leaf2", "p1"), link("access", "leaf2", "p2", "host", "eth0")],
    );
    const table = data({
      interfaces: [
        forwardingInterface("leaf1", "svi100", { interfaceType: "svi", forwardingMode: "access", vrf: "blue", vlan: 100 }),
        forwardingInterface("leaf1", "p1", { vrf: "underlay" }),
        forwardingInterface("leaf2", "p2", { forwardingMode: "access", vlan: 100, vrf: "blue" }),
      ],
      routes: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vrf: "blue", destinationCidr: "10.10.0.0/24", action: "connected", outputInterface: "svi100" },
        { row: 3, deviceId: "leaf1", deviceName: "LEAF1", vrf: "underlay", destinationCidr: "172.16.0.2/32", action: "forward", nextHop: "192.0.2.2", outputInterface: "p1" },
      ],
      arpEntries: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vrf: "blue", ip: "10.10.0.8", mac: "00:11:22:33:44:55", interfaceName: "svi100", status: "reachable" },
        { row: 3, deviceId: "leaf1", deviceName: "LEAF1", vrf: "underlay", ip: "192.0.2.2", mac: "00:aa:00:00:00:02", interfaceName: "p1", status: "reachable" },
      ],
      macEntries: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vlan: 100, mac: "00:11:22:33:44:55", action: "remote", vni: 10100, remoteVtep: "172.16.0.2" },
        { row: 3, deviceId: "leaf2", deviceName: "LEAF2", vlan: 100, mac: "00:11:22:33:44:55", action: "interface", outputInterface: "p2" },
      ],
      vxlanEntries: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vni: 10100, mode: "l2", localVtep: "172.16.0.1", vlan: 100, underlayVrf: "underlay", udpDestinationPort: 4789, status: "up" },
        { row: 3, deviceId: "leaf2", deviceName: "LEAF2", vni: 10100, mode: "l2", localVtep: "172.16.0.2", vlan: 100, underlayVrf: "underlay", udpDestinationPort: 4789, status: "up" },
      ],
    });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "leaf1", sourceIp: "10.1.0.1", destinationIp: "10.10.0.8", vrf: "blue" });
    expect(result.transitions.map((item) => item.topologyLinkId)).toEqual(["fabric", "access"]);
    expect(result.states.some((item) => item.packet.vxlan?.vni === 10100 && item.packet.innerSourceIp === "10.1.0.1")).toBe(true);
    expect(result.states.some((item) => item.kind === "decapsulate")).toBe(true);
    expect(result.endpoints.at(-1)?.code).toBe("DELIVERED");
  });

  it("performs symmetric L3VNI decapsulation and resumes lookup in the tenant VRF", () => {
    const graph = topology(
      [
        node("leaf1", [networkInterface("lo", "10.1.0.1/32"), networkInterface("p1")]),
        node("leaf2", [networkInterface("lo", "172.16.0.2/32"), networkInterface("p1"), networkInterface("p2")]),
        node("host", [networkInterface("eth0", "10.20.0.8/24")]),
      ],
      [link("fabric", "leaf1", "p1", "leaf2", "p1"), link("access", "leaf2", "p2", "host", "eth0")],
    );
    const table = data({
      interfaces: [forwardingInterface("leaf1", "p1", { vrf: "underlay" }), forwardingInterface("leaf2", "p2", { vrf: "blue" })],
      routes: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vrf: "blue", destinationCidr: "10.20.0.0/24", action: "vxlan", vni: 50001, remoteVtep: "172.16.0.2" },
        { row: 3, deviceId: "leaf1", deviceName: "LEAF1", vrf: "underlay", destinationCidr: "172.16.0.2/32", action: "forward", nextHop: "192.0.2.2", outputInterface: "p1" },
        { row: 4, deviceId: "leaf2", deviceName: "LEAF2", vrf: "blue", destinationCidr: "10.20.0.0/24", action: "connected", outputInterface: "p2" },
      ],
      arpEntries: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vrf: "underlay", ip: "192.0.2.2", mac: "00:aa:00:00:00:02", interfaceName: "p1", status: "reachable" },
        { row: 3, deviceId: "leaf2", deviceName: "LEAF2", vrf: "blue", ip: "10.20.0.8", mac: "00:11:22:33:44:66", interfaceName: "p2", status: "reachable" },
      ],
      vxlanEntries: [
        { row: 2, deviceId: "leaf1", deviceName: "LEAF1", vni: 50001, mode: "l3", localVtep: "172.16.0.1", tenantVrf: "blue", underlayVrf: "underlay", udpDestinationPort: 4789, status: "up" },
        { row: 3, deviceId: "leaf2", deviceName: "LEAF2", vni: 50001, mode: "l3", localVtep: "172.16.0.2", tenantVrf: "blue", underlayVrf: "underlay", udpDestinationPort: 4789, status: "up" },
      ],
    });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "leaf1", sourceIp: "10.1.0.1", destinationIp: "10.20.0.8", vrf: "blue" });
    expect(result.transitions.map((item) => item.topologyLinkId)).toEqual(["fabric", "access"]);
    expect(result.states.find((item) => item.deviceId === "leaf2")?.packet.vrf).toBe("blue");
    expect(result.endpoints.at(-1)?.code).toBe("DELIVERED");
  });

  it("returns a confirmed partial path and explicit reason when data is missing", () => {
    const graph = topology([node("a", [networkInterface("lo", "10.0.0.1/32"), networkInterface("p1")])], []);
    const table = data({ interfaces: [forwardingInterface("a", "p1")], routes: [{ row: 2, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "0.0.0.0/0", action: "forward", nextHop: "192.0.2.2", outputInterface: "p1" }] });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "a", sourceIp: "10.0.0.1", destinationIp: "203.0.113.9" });
    expect(result.states).toHaveLength(1);
    expect(result.endpoints).toEqual([expect.objectContaining({ code: "NO_ARP" })]);
    expect(result.states[0].evidence?.[0]).toMatchObject({ sheet: "路由表", row: 2 });
  });

  it("terminates a repeated forwarding state instead of expanding forever", () => {
    const graph = topology(
      [node("a", [networkInterface("lo", "10.0.0.1/32"), networkInterface("p1")]), node("b", [networkInterface("p1")])],
      [link("ab", "a", "p1", "b", "p1")],
    );
    const table = data({
      interfaces: [forwardingInterface("a", "p1"), forwardingInterface("b", "p1")],
      routes: [
        { row: 2, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "203.0.113.0/24", action: "forward", nextHop: "192.0.2.2", outputInterface: "p1" },
        { row: 3, deviceId: "b", deviceName: "B", vrf: "default", destinationCidr: "203.0.113.0/24", action: "forward", nextHop: "192.0.2.1", outputInterface: "p1" },
      ],
      arpEntries: [
        { row: 2, deviceId: "a", deviceName: "A", vrf: "default", ip: "192.0.2.2", mac: "00:00:00:00:00:02", interfaceName: "p1", status: "reachable" },
        { row: 3, deviceId: "b", deviceName: "B", vrf: "default", ip: "192.0.2.1", mac: "00:00:00:00:00:01", interfaceName: "p1", status: "reachable" },
      ],
    });
    const result = traceForwarding("topology", "snapshot", graph, table, { sourceDeviceId: "a", sourceIp: "10.0.0.1", destinationIp: "203.0.113.8" });
    expect(result.transitions.length).toBeLessThan(5);
    expect(result.endpoints).toContainEqual(expect.objectContaining({ code: "LOOP_DETECTED" }));
  });
});
