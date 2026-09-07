// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardingSnapshotData } from "../shared/forwarding";
import type { TopologyLink, TopologyNode } from "../shared/topology";
import { Inspector, topologyLinkIdsForInterfaces } from "../src/Inspector";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inspector", () => {
  it("shows every configured interface and distinguishes primary and VRR addresses", () => {
    const node: TopologyNode = {
      id: "device:test",
      kind: "configured",
      hostname: "MDC-POD1-ASW-001",
      label: "POD1-ASW-001",
      role: "ASW",
      pod: "POD1",
      lids: ["17", "23"],
      interfaces: [
        { name: "swp1", addresses: [{ cidr: "10.0.0.1/31", type: "primary" }], peers: [] },
        { name: "vlan1000", addresses: [{ cidr: "10.1.0.254/24", type: "vrr" }], logical: true, peers: [] },
        { name: "swp2", addresses: [], peers: [] },
      ],
    };
    render(<Inspector graphNode={{ id: node.id, label: node.label, hostname: node.hostname, kind: "configured", role: node.role, pod: node.pod, interfaceCount: 3, node }} nodeById={new Map()} pinned={false} savingAddress={false} onSaveServerAddresses={vi.fn()} onResetServerAddresses={vi.fn()} onClose={vi.fn()} onMouseEnter={vi.fn()} onMouseLeave={vi.fn()} />);
    expect(screen.getByText("swp1")).toBeInTheDocument();
    expect(screen.getByText("vlan1000")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1/31")).toBeInTheDocument();
    expect(screen.getByText("设备 LID")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
    expect(screen.getByText("VRR 10.1.0.254/24")).toBeInTheDocument();
    expect(screen.getByText("逻辑接口")).toBeInTheDocument();
    expect(screen.getByText("swp2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅查看 IP" }));
    expect(screen.queryByText("swp2")).not.toBeInTheDocument();
  });

  it("shows synchronized GPU addresses and allows editing", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const node: TopologyNode = {
      id: "external:gpu", kind: "external", hostname: "MDC-DH1E-J25-POD1-GPU-001", label: "GPU-001", role: "ENDPOINT", pod: "POD1", endpointType: "GPU", interfaces: [],
      serverInfo: { inBandIp: "10.10.0.1", outOfBandIp: "10.20.0.1", inventoryInBandIp: "10.10.0.1", inventoryOutOfBandIp: "10.20.0.1", manualOverride: false },
    };
    render(<Inspector graphNode={{ id: node.id, label: node.label, hostname: node.hostname, kind: "external", role: node.role, pod: node.pod, interfaceCount: 0, node }} nodeById={new Map()} pinned savingAddress={false} onSaveServerAddresses={save} onResetServerAddresses={vi.fn()} onClose={vi.fn()} onMouseEnter={vi.fn()} onMouseLeave={vi.fn()} />);
    expect(screen.getByText("10.10.0.1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /修改地址/ }));
    fireEvent.change(screen.getByLabelText("带内地址"), { target: { value: "10.10.0.2" } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(save).toHaveBeenCalledWith(node.hostname, { inBandIp: "10.10.0.2", outOfBandIp: "10.20.0.1" });
  });

  it("separates aggregate ports and searchable forwarding tables while highlighting all bond members", async () => {
    const node: TopologyNode = {
      id: "device:test", kind: "configured", hostname: "ASW-001", label: "ASW-001", role: "ASW", pod: "POD1",
      interfaces: [
        { name: "swp1", addresses: [], peers: [] },
        { name: "swp2", addresses: [], peers: [] },
        { name: "bond0", addresses: [], logical: true, peers: [] },
      ],
    };
    const links: TopologyLink[] = [
      { id: "link-1", source: node.id, target: "device:b", sourceInterface: "swp1", targetInterface: "swp1", plane: "production", confidence: "declared", reciprocal: false },
      { id: "link-2", source: node.id, target: "device:c", sourceInterface: "swp2", targetInterface: "swp1", plane: "production", confidence: "declared", reciprocal: false },
    ];
    const data: ForwardingSnapshotData = {
      metadata: { templateVersion: "1.0", batchName: "test", collectedAt: "2026-09-07T00:00:00.000Z" },
      interfaces: [{ row: 2, deviceId: node.id, deviceName: node.hostname, interfaceName: "bond0", interfaceType: "lag", forwardingMode: "routed", vrf: "default", allowedVlans: [], status: "up" }],
      lagMembers: [
        { row: 2, deviceId: node.id, deviceName: node.hostname, aggregateInterface: "bond0", memberInterface: "swp1", status: "up" },
        { row: 3, deviceId: node.id, deviceName: node.hostname, aggregateInterface: "bond0", memberInterface: "swp2", status: "up" },
      ],
      routes: [{ row: 2, deviceId: node.id, deviceName: node.hostname, vrf: "default", destinationCidr: "203.0.113.0/24", action: "forward", nextHop: "192.0.2.2", outputInterface: "bond0" }],
      arpEntries: [{ row: 2, deviceId: node.id, deviceName: node.hostname, vrf: "default", ip: "192.0.2.2", mac: "02:00:00:00:00:02", interfaceName: "bond0", status: "reachable" }],
      macEntries: [], vxlanEntries: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("/snapshot-1")
        ? new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ snapshots: [{ id: "snapshot-1", topologyId: "topology", batchName: "test", templateVersion: "1.0", collectedAt: data.metadata.collectedAt, importedAt: data.metadata.collectedAt, isDefault: true, compatible: true, counts: { interfaces: 1, lagMembers: 2, routes: 1, arpEntries: 1, macEntries: 0, vxlanEntries: 0 } }], defaultSnapshotId: "snapshot-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const highlight = vi.fn();
    render(<Inspector graphNode={{ id: node.id, label: node.label, hostname: node.hostname, kind: "configured", role: node.role, pod: node.pod, interfaceCount: 3, node }} nodeById={new Map()} projectId="project" topologyId="topology" topologyLinks={links} pinned savingAddress={false} onSaveServerAddresses={vi.fn()} onResetServerAddresses={vi.fn()} onHighlightLinks={highlight} onClose={vi.fn()} onMouseEnter={vi.fn()} onMouseLeave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "聚合口" }));
    fireEvent.click(await screen.findByRole("button", { name: /bond0/ }));
    expect([...highlight.mock.calls.at(-1)![0]]).toEqual(["link-1", "link-2"]);
    expect([...topologyLinkIdsForInterfaces(node.id, ["swp2"], links)]).toEqual(["link-2"]);

    fireEvent.click(screen.getByRole("button", { name: "转发表" }));
    expect(await screen.findByText("203.0.113.0/24")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("检索转发表"), { target: { value: "not-present" } });
    expect(screen.getByText("没有匹配的表项")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("检索转发表"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /ARP/ }));
    expect(screen.getByText("192.0.2.2")).toBeInTheDocument();
  });
});
