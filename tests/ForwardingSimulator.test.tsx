// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForwardingSnapshotSummary, ForwardingTraceResult } from "../shared/forwarding";
import type { TopologySnapshot } from "../shared/topology";
import { ForwardingSimulator } from "../src/ForwardingSimulator";

const topology: TopologySnapshot = {
  revision: "test-revision",
  refreshedAt: "2026-09-06T08:00:00.000Z",
  sourceType: "nvue",
  stats: { configuredDevices: 2, externalDevices: 0, physicalLinks: 1, internalLinks: 1, externalLinks: 0, usedInterfaces: 2, sourceFiles: 2, inventoryRecords: 0, inventoryMatched: 0, manualOverrides: 0 },
  nodes: [
    { id: "a", kind: "configured", hostname: "SW-A", label: "SW-A", role: "CSW", pod: "POD1", interfaces: [{ name: "eth0", addresses: [{ cidr: "10.0.0.1/32", type: "primary" }], peers: [{ device: "SW-B", interface: "eth0" }] }] },
    { id: "b", kind: "configured", hostname: "SW-B", label: "SW-B", role: "CSW", pod: "POD1", interfaces: [{ name: "eth0", addresses: [{ cidr: "10.0.0.2/32", type: "primary" }], peers: [{ device: "SW-A", interface: "eth0" }] }] },
  ],
  links: [{ id: "link-a-b", source: "a", target: "b", sourceInterface: "eth0", targetInterface: "eth0", plane: "production", confidence: "reciprocal", reciprocal: true }],
  clusters: [],
  layoutPositions: {},
  warnings: [],
};

const snapshot: ForwardingSnapshotSummary = {
  id: "snapshot-1",
  topologyId: "topology-1",
  batchName: "直连路由验收",
  templateVersion: "1.0",
  collectedAt: "2026-09-06T08:00:00.000Z",
  importedAt: "2026-09-06T08:01:00.000Z",
  isDefault: true,
  compatible: true,
  counts: { interfaces: 2, lagMembers: 0, routes: 1, arpEntries: 1, macEntries: 0, vxlanEntries: 0 },
};

const trace: ForwardingTraceResult = {
  snapshotId: snapshot.id,
  topologyId: snapshot.topologyId,
  source: { sourceDeviceId: "a", sourceIp: "10.0.0.1", destinationIp: "10.0.0.2", sourceInterface: "eth0", vrf: "default" },
  states: [
    { id: "state-1", deviceId: "a", deviceName: "SW-A", kind: "egress", packet: { innerSourceIp: "10.0.0.1", innerDestinationIp: "10.0.0.2", vrf: "default" }, summary: "经 eth0 转发" },
    { id: "state-2", deviceId: "b", deviceName: "SW-B", ingressInterface: "eth0", kind: "terminal", packet: { innerSourceIp: "10.0.0.1", innerDestinationIp: "10.0.0.2", vrf: "default" }, summary: "目的地址已到达" },
  ],
  transitions: [{ id: "transition-1", fromStateId: "state-1", toStateId: "state-2", fromDeviceId: "a", toDeviceId: "b", outputInterface: "eth0", inputInterface: "eth0", topologyLinkId: "link-a-b", summary: "经 eth0 转发" }],
  endpoints: [{ stateId: "state-2", deviceId: "b", code: "DELIVERED", message: "目的地址 10.0.0.2 已到达 SW-B" }],
  rootStateId: "state-1",
  createdAt: "2026-09-06T08:02:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches, media: "(prefers-reduced-motion: reduce)", onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ForwardingSimulator", () => {
  it("loads a snapshot, traces a path in reduced-motion mode and clears the simulation", async () => {
    mockReducedMotion(true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? jsonResponse(trace)
      : jsonResponse({ snapshots: [snapshot], defaultSnapshotId: snapshot.id }));
    vi.stubGlobal("fetch", fetchMock);
    const onSimulationChange = vi.fn();

    render(<ForwardingSimulator projectId="project-1" topologyId="topology-1" topology={topology} simulationDevice={{ deviceId: "a", sourceIp: "10.0.0.1" }} onClose={vi.fn()} onSimulationChange={onSimulationChange} />);
    await screen.findByText("直连路由验收");
    expect(screen.getByRole("button", { name: "导入转发表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始仿真" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "结束仿真" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "退出仿真" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始仿真" }));
    fireEvent.change(screen.getByPlaceholderText("例如：10.0.0.2"), { target: { value: "10.0.0.2" } });
    fireEvent.click(screen.getByRole("button", { name: "确认开始" }));

    expect(await screen.findByText("1 条链路决策 · 1 个终点")).toBeInTheDocument();
    expect(screen.getByText("到达：目的地址 10.0.0.2 已到达 SW-B")).toBeInTheDocument();
    await waitFor(() => {
      const simulationCall = onSimulationChange.mock.calls.find(([value]) => value?.trace?.snapshotId === snapshot.id);
      expect(simulationCall?.[0].visibleTransitionIds).toEqual(new Set(["transition-1"]));
      expect(simulationCall?.[1]).toEqual(new Set(["a", "b"]));
    });

    fireEvent.click(screen.getByRole("button", { name: "结束仿真" }));
    expect(screen.queryByText("1 条链路决策 · 1 个终点")).not.toBeInTheDocument();
    await waitFor(() => expect(onSimulationChange).toHaveBeenLastCalledWith(undefined, new Set()));
  });

  it("shows structured row errors from a rejected workbook upload", async () => {
    mockReducedMotion(false);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? jsonResponse({ error: "转发表工作簿校验失败，共 1 项错误", issues: [{ sheet: "接口属性", row: 2, column: "设备", message: "拓扑中不存在设备 UNKNOWN" }] }, 422)
      : jsonResponse({ snapshots: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ForwardingSimulator projectId="project-1" topologyId="topology-1" topology={topology} onClose={vi.fn()} onSimulationChange={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const workbook = new File([new Uint8Array([1, 2, 3])], "snapshot.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    Object.defineProperty(workbook, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
    fireEvent.change(input, { target: { files: [workbook] } });

    expect(await screen.findByText("转发表工作簿校验失败，共 1 项错误")).toBeInTheDocument();
    expect(screen.getByText("接口属性 2行 / 设备")).toBeInTheDocument();
    expect(screen.getByText("拓扑中不存在设备 UNKNOWN")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1/topologies/topology-1/forwarding-snapshots", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Content-Type": "application/json" }) }));
  });
});
