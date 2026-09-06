import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ForwardingSnapshotData } from "../shared/forwarding";
import type { TopologySnapshot } from "../shared/topology";
import { ForwardingWorkbookError, parseForwardingWorkbook } from "../server/forwardingWorkbookParser";
import { ServerAddressStore } from "../server/serverAddressStore";

function batch(index: number): ForwardingSnapshotData {
  return {
    metadata: { templateVersion: "1.0", batchName: `batch-${index}`, collectedAt: new Date(1_780_000_000_000 + index * 1000).toISOString() },
    interfaces: [{ row: 2, deviceId: "a", deviceName: "A", interfaceName: "p1", interfaceType: "physical", forwardingMode: "routed", vrf: "default", allowedVlans: [], status: "up" }],
    lagMembers: [],
    routes: [{ row: 2, deviceId: "a", deviceName: "A", vrf: "default", destinationCidr: "0.0.0.0/0", action: "forward", nextHop: `192.0.2.${index + 1}`, outputInterface: "p1" }],
    arpEntries: [], macEntries: [], vxlanEntries: [],
  };
}

const emptyTopology: TopologySnapshot = {
  revision: "one", refreshedAt: "2026-09-04T00:00:00.000Z", sourceType: "ports-csv", nodes: [], links: [], clusters: [], layoutPositions: {}, warnings: [],
  stats: { configuredDevices: 0, externalDevices: 0, physicalLinks: 0, internalLinks: 0, externalLinks: 0, usedInterfaces: 0, sourceFiles: 1, inventoryRecords: 0, inventoryMatched: 0, manualOverrides: 0 },
};

describe("forwarding snapshot persistence", () => {
  it("retains only five successful snapshots and never leaks records between snapshot IDs", () => {
    const store = new ServerAddressStore(":memory:");
    store.ensureDefaultCatalog(1, 0);
    const saved = Array.from({ length: 6 }, (_, index) => store.saveForwardingSnapshot("metta-roce", "fingerprint", batch(index)));
    const summaries = store.listForwardingSnapshots("metta-roce", "fingerprint");
    expect(summaries).toHaveLength(5);
    expect(summaries[0]).toMatchObject({ batchName: "batch-5", isDefault: true, compatible: true });
    expect(summaries.some((item) => item.batchName === "batch-0")).toBe(false);
    expect(store.forwardingSnapshot("metta-roce", saved[0].id)).toBeUndefined();
    expect(store.forwardingSnapshot("metta-roce", saved[4].id)?.routes[0].nextHop).toBe("192.0.2.5");
    expect(store.forwardingSnapshot("metta-roce", saved[5].id)?.routes[0].nextHop).toBe("192.0.2.6");
    expect(store.forwardingSnapshot("another-topology", saved[5].id)).toBeUndefined();
    store.close();
  });

  it("marks snapshots incompatible when only the structural fingerprint changes", () => {
    const store = new ServerAddressStore(":memory:");
    store.ensureDefaultCatalog(1, 0);
    store.saveForwardingSnapshot("metta-roce", "old-structure", batch(1));
    expect(store.listForwardingSnapshots("metta-roce", "new-structure")[0]).toMatchObject({ compatible: false, isDefault: true });
    store.close();
  });

  it("loads the delivered workbook and reports strict row-level errors before storage", async () => {
    const bytes = await readFile("public/templates/forwarding-state-template.xlsx");
    let failure: ForwardingWorkbookError | undefined;
    try {
      await parseForwardingWorkbook(bytes, emptyTopology);
    } catch (error) {
      if (error instanceof ForwardingWorkbookError) failure = error;
      else throw error;
    }
    expect(failure?.issues).toContainEqual(expect.objectContaining({ sheet: "接口属性", row: 2, column: "设备" }));
    expect(failure?.issues.some((item) => item.sheet === "工作簿")).toBe(false);
  });
});
