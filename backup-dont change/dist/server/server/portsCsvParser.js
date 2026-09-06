import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { parse } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";
import { inferPod, inferRack } from "./parser.js";
const MAX_IMPORT_SIZE = 12 * 1024 * 1024;
export class PortsCsvError extends Error {
}
function csvCell(value) {
    const text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export async function parsePortsXlsx(xlsxBytes, sourceFile = "ports.xlsx") {
    if (xlsxBytes.byteLength > MAX_IMPORT_SIZE)
        throw new PortsCsvError("连线表超过 12MiB 限制");
    if (xlsxBytes.byteLength === 0)
        throw new PortsCsvError("XLSX 内容不能为空");
    try {
        const rows = await readSheet(Readable.from([xlsxBytes]));
        if (rows.length === 0)
            throw new PortsCsvError("连线表没有数据行");
        return parsePortsCsv(rows.map((row) => row.map(csvCell).join(",")).join("\n"), sourceFile);
    }
    catch (error) {
        if (error instanceof PortsCsvError)
            throw error;
        throw new PortsCsvError(error instanceof Error ? `XLSX 解析失败：${error.message}` : "XLSX 解析失败");
    }
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 18);
}
function normalizeHeader(value) {
    return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}
function findHeader(headers, aliases, required) {
    const normalizedAliases = new Set(aliases.map(normalizeHeader));
    const result = headers.find((header) => normalizedAliases.has(normalizeHeader(header)));
    if (!result && required)
        throw new PortsCsvError(`缺少必需字段：${aliases[0]}`);
    return result;
}
export function inferImportedRole(hostname) {
    const value = hostname.toUpperCase();
    if (/(?:^|-)CSW(?:-?\d+)?(?:-|$)/.test(value))
        return "CSW";
    if (/(?:^|-)SSW(?:-?\d+)?(?:-|$)/.test(value) || /(?:^|-)SPINE(?:-?\d+)?(?:-|$)/.test(value))
        return "SSW";
    if (/(?:^|-)ASW(?:-?\d+)?(?:-|$)/.test(value))
        return "ASW";
    if (/(?:^|-)MSW(?:-?\d+)?(?:-|$)/.test(value))
        return "MGMT";
    if (/(?:^|-)OAW(?:-?\d+)?(?:-|$)/.test(value))
        return "OOB";
    if (/(?:^|-)IBCR\d*(?:-|$)/.test(value))
        return "IBCR";
    if (/(?:^|-)IBSP\d*(?:-|$)/.test(value))
        return "IBSP";
    if (/(?:^|-)IBLF\d*(?:-|$)/.test(value))
        return "IBLF";
    if (/(?:^|-)GPU(?:-|$)/.test(value))
        return "ENDPOINT";
    if (value.includes("UFM") ||
        value === "HPN" ||
        value.includes("NETOPS") ||
        value.includes("CONNECTX") ||
        /SERVER\d*$/.test(value) ||
        /(?:^|[-_ ])(?:UBUNTU|MAAS)(?:[-_ ]|$)/.test(value) ||
        /(?:CUSTOM-OS|DEPLOY-TEST|CHASSIS ID)/.test(value))
        return "SERVER";
    return "UNKNOWN";
}
function nodeId(hostname) {
    return `imported:${digest(hostname.toLowerCase())}`;
}
export function parsePortsCsv(csvText, sourceFile = "ports.csv") {
    if (Buffer.byteLength(csvText, "utf8") > MAX_IMPORT_SIZE) {
        throw new PortsCsvError("连线表超过 12MiB 限制");
    }
    if (csvText.startsWith("PK\u0003\u0004")) {
        throw new PortsCsvError("检测到 XLSX 文件内容，请以 .xlsx 格式重新上传");
    }
    let rows;
    try {
        rows = parse(csvText, {
            bom: true,
            columns: true,
            skip_empty_lines: true,
            relax_column_count: true,
            trim: true,
        });
    }
    catch (error) {
        throw new PortsCsvError(error instanceof Error ? `CSV 解析失败：${error.message}` : "CSV 解析失败");
    }
    if (rows.length === 0)
        throw new PortsCsvError("连线表没有数据行");
    const headers = Object.keys(rows[0]);
    const localHostKey = findHeader(headers, ["System", "本端主机名", "本端设备", "Local Host", "Local Node"], true);
    const localPortKey = findHeader(headers, ["Port", "本端端口", "Local Port"], true);
    const localLidKey = findHeader(headers, ["LID", "本端LID", "Local LID"], false);
    const localIpKey = findHeader(headers, ["本端IP", "Local IP", "Local Address", "System IP"], false);
    const peerHostKey = findHeader(headers, ["Peer Node", "对端主机名", "Peer Host", "Remote Node", "对端设备"], true);
    const peerPortKey = findHeader(headers, ["Peer Port", "对端端口", "Remote Port"], true);
    const peerLidKey = findHeader(headers, ["Peer LID", "对端LID", "Remote LID"], false);
    const peerIpKey = findHeader(headers, ["对端IP", "Peer IP", "Remote IP", "Peer Address", "Remote Address"], false);
    const warnings = [];
    const nodes = new Map();
    const interfaces = new Map();
    const links = new Map();
    const getNode = (hostname) => {
        const key = hostname.toLowerCase();
        const existing = nodes.get(key);
        if (existing)
            return existing;
        const role = inferImportedRole(hostname);
        const node = {
            id: nodeId(hostname),
            kind: role === "ENDPOINT" || role === "SERVER" ? "external" : "configured",
            hostname,
            label: hostname.length > 34 ? `${hostname.slice(0, 31)}…` : hostname,
            role,
            pod: inferPod(hostname),
            rack: inferRack(hostname),
            endpointType: role === "ENDPOINT" ? "GPU" : role === "SERVER" ? "服务器" : undefined,
            lids: [],
            interfaces: [],
        };
        nodes.set(key, node);
        interfaces.set(key, new Map());
        return node;
    };
    const addNodeLid = (hostname, lid) => {
        if (!lid)
            return;
        const node = getNode(hostname);
        if (!node.lids?.includes(lid))
            node.lids?.push(lid);
    };
    const getInterface = (hostname, port) => {
        const key = hostname.toLowerCase();
        const node = getNode(hostname);
        const byPort = interfaces.get(key);
        let record = byPort.get(port);
        if (!record) {
            record = { name: port, addresses: [], peers: [] };
            byPort.set(port, record);
            node.interfaces.push(record);
        }
        return record;
    };
    const addInterfaceAddress = (record, cidr) => {
        if (!cidr || record.addresses.some((address) => address.cidr === cidr))
            return;
        record.addresses.push({ cidr, type: "primary" });
    };
    for (const [index, row] of rows.entries()) {
        const localHost = String(row[localHostKey] ?? "").trim();
        const localPort = String(row[localPortKey] ?? "").trim();
        const peerHost = String(row[peerHostKey] ?? "").trim();
        const peerPort = String(row[peerPortKey] ?? "").trim();
        const localLid = localLidKey ? String(row[localLidKey] ?? "").trim() : "";
        const peerLid = peerLidKey ? String(row[peerLidKey] ?? "").trim() : "";
        const localIp = localIpKey ? String(row[localIpKey] ?? "").trim() : "";
        const peerIp = peerIpKey ? String(row[peerIpKey] ?? "").trim() : "";
        if (!localHost || !localPort || !peerHost || !peerPort) {
            if (warnings.filter((warning) => warning.code === "IMPORT_ROW_SKIPPED").length < 100) {
                warnings.push({ code: "IMPORT_ROW_SKIPPED", sourceFile, message: `第 ${index + 2} 行缺少主机名或端口，已跳过` });
            }
            continue;
        }
        addNodeLid(localHost, localLid);
        addNodeLid(peerHost, peerLid);
        const localInterface = getInterface(localHost, localPort);
        const peerInterface = getInterface(peerHost, peerPort);
        addInterfaceAddress(localInterface, localIp);
        addInterfaceAddress(peerInterface, peerIp);
        if (localHost.toLowerCase() === peerHost.toLowerCase()) {
            localInterface.logical = true;
            peerInterface.logical = true;
            continue;
        }
        if (!localInterface.peers.some((peer) => peer.device === peerHost && peer.interface === peerPort)) {
            localInterface.peers.push({ device: peerHost, interface: peerPort });
        }
        if (!peerInterface.peers.some((peer) => peer.device === localHost && peer.interface === localPort)) {
            peerInterface.peers.push({ device: localHost, interface: localPort });
        }
        const endpointKeys = [`${localHost.toLowerCase()}\u0000${localPort}`, `${peerHost.toLowerCase()}\u0000${peerPort}`].sort();
        const key = endpointKeys.join("\u0001");
        const existing = links.get(key);
        if (existing)
            existing.count += 1;
        else
            links.set(key, { key, sourceHostname: localHost, sourcePort: localPort, targetHostname: peerHost, targetPort: peerPort, count: 1 });
    }
    for (const node of nodes.values()) {
        node.interfaces.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        node.lids?.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (node.lids?.length === 0)
            delete node.lids;
    }
    const topologyLinks = [...links.values()].map((link) => ({
        id: `import-link:${digest(link.key)}`,
        source: nodes.get(link.sourceHostname.toLowerCase()).id,
        target: nodes.get(link.targetHostname.toLowerCase()).id,
        sourceInterface: link.sourcePort,
        targetInterface: link.targetPort,
        plane: "production",
        confidence: link.count > 1 ? "reciprocal" : "declared",
        reciprocal: link.count > 1,
    }));
    const topologyNodes = [...nodes.values()].sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
    const topologyNodeById = new Map(topologyNodes.map((node) => [node.id, node]));
    const usedInterfaces = topologyNodes.reduce((sum, node) => sum + node.interfaces.length, 0);
    return {
        revision: digest(csvText),
        refreshedAt: new Date().toISOString(),
        stats: {
            configuredDevices: topologyNodes.filter((node) => node.kind === "configured").length,
            externalDevices: topologyNodes.filter((node) => node.kind === "external").length,
            physicalLinks: topologyLinks.length,
            internalLinks: topologyLinks.filter((link) => topologyNodeById.get(link.source)?.kind === "configured" && topologyNodeById.get(link.target)?.kind === "configured").length,
            externalLinks: topologyLinks.filter((link) => topologyNodeById.get(link.source)?.kind === "external" || topologyNodeById.get(link.target)?.kind === "external").length,
            usedInterfaces,
            sourceFiles: 1,
            inventoryRecords: 0,
            inventoryMatched: 0,
            manualOverrides: 0,
        },
        nodes: topologyNodes,
        links: topologyLinks.sort((a, b) => a.id.localeCompare(b.id)),
        clusters: [],
        layoutPositions: {},
        warnings,
        sourceType: "ports-csv",
    };
}
//# sourceMappingURL=portsCsvParser.js.map