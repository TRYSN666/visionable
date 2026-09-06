// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TopologyNode } from "../shared/topology";
import { Inspector } from "../src/Inspector";

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
});
