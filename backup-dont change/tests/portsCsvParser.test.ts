import { describe, expect, it } from "vitest";
import { PortsCsvError, parsePortsCsv, parsePortsXlsx } from "../server/portsCsvParser";

describe("Ports CSV parser", () => {
  it("parses optional LIDs, classifies IB devices and deduplicates reciprocal rows", () => {
    const snapshot = parsePortsCsv(`System,Port,LID,Peer Node,Peer Port,Peer LID
MDC-POD1-IBLF-001,1/1,101,MDC-POD1-GPU-001,eth0,201
MDC-POD1-GPU-001,eth0,201,MDC-POD1-IBLF-001,1/1,101
MDC-POD2-IBSP-001,2/1,,MDC-POD2-IBCR-001,3/1,
`, "Ports-test.csv");

    expect(snapshot.sourceType).toBe("ports-csv");
    expect(snapshot.stats).toMatchObject({ configuredDevices: 3, externalDevices: 1, physicalLinks: 2, usedInterfaces: 4 });
    expect(snapshot.links.filter((link) => link.reciprocal)).toHaveLength(1);
    expect(snapshot.nodes.find((node) => node.hostname === "MDC-POD1-IBLF-001")).toMatchObject({ role: "IBLF", pod: "POD1" });
    expect(snapshot.nodes.find((node) => node.hostname === "MDC-POD2-IBSP-001")?.role).toBe("IBSP");
    expect(snapshot.nodes.find((node) => node.hostname === "MDC-POD2-IBCR-001")?.role).toBe("IBCR");
    expect(snapshot.nodes.find((node) => node.hostname === "MDC-POD1-GPU-001")).toMatchObject({ kind: "external", lids: ["201"] });
    expect(snapshot.nodes.find((node) => node.hostname === "MDC-POD1-GPU-001")?.interfaces[0]).toEqual(expect.objectContaining({ name: "eth0" }));
  });

  it("accepts Chinese headers and does not require LID columns", () => {
    const snapshot = parsePortsCsv(`本端主机名,本端端口,对端主机名,对端端口
POD3-IBLF-001,1,POD3-GPU-001,mlx5_0
`);
    expect(snapshot.links).toHaveLength(1);
    expect(snapshot.nodes.every((node) => node.lids === undefined)).toBe(true);
  });

  it("parses relationship-table IP columns and keeps same-device rows as logical interfaces without self-links", () => {
    const snapshot = parsePortsCsv(`本端设备,本端端口,本端IP,对端设备,对端端口,对端IP
SJIDC-D03-203-H05-41U-TEST-CSW01,XGE1/0/5,,CPU Server1,903f-eaf0-701b,10.10.251.5
SJIDC-D03-203-H05-41U-TEST-CSW01,XGE1/0/48,192.168.1.1/24,SJIDC-D03-203-H05-39U-TEST-CSW02,Ten-GigabitEthernet1/0/48,192.168.1.2
SJIDC-D03-203-H05-41U-TEST-CSW01,Vlan-interface239,10.10.239.254/24,SJIDC-D03-203-H05-41U-TEST-CSW01,Vlan-interface239,10.10.239.254/24
`);

    expect(snapshot.stats).toMatchObject({ configuredDevices: 2, externalDevices: 1, physicalLinks: 2, internalLinks: 1, externalLinks: 1, usedInterfaces: 5 });
    expect(snapshot.links.every((link) => link.source !== link.target)).toBe(true);

    const csw = snapshot.nodes.find((node) => node.hostname === "SJIDC-D03-203-H05-41U-TEST-CSW01")!;
    expect(csw).toMatchObject({ kind: "configured", role: "CSW" });
    expect(csw.interfaces.find((item) => item.name === "XGE1/0/48")?.addresses).toEqual([
      { cidr: "192.168.1.1/24", type: "primary" },
    ]);
    expect(csw.interfaces.find((item) => item.name === "Vlan-interface239")).toEqual({
      name: "Vlan-interface239",
      addresses: [{ cidr: "10.10.239.254/24", type: "primary" }],
      logical: true,
      peers: [],
    });

    const server = snapshot.nodes.find((node) => node.hostname === "CPU Server1")!;
    expect(server).toMatchObject({ kind: "external", role: "SERVER", endpointType: "服务器" });
    expect(server.interfaces[0].addresses).toEqual([{ cidr: "10.10.251.5", type: "primary" }]);
  });

  it("rejects tables missing a required endpoint field", () => {
    expect(() => parsePortsCsv("System,Port,Peer Node\na,1,b\n")).toThrow(PortsCsvError);
  });

  it("reports XLSX input sent through the legacy CSV path clearly", async () => {
    expect(() => parsePortsCsv("PK\u0003\u0004binary", "renamed.csv")).toThrow("检测到 XLSX 文件内容");
    await expect(parsePortsXlsx(Buffer.from("not-an-xlsx"), "broken.xlsx")).rejects.toThrow("XLSX 解析失败");
  });
});
