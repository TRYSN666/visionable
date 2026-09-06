import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const MAX_CLUSTER_SIZE = 48;
const ROLE_PATTERN = /-(CSW|SSW|ASW|HSS|MGMT|LSW|SOOB|OOB)-(\d+)(?:$|\b)/i;
const POD_PATTERN = /-POD([123])(?:-|$)/i;
const RACK_PATTERN = /-DH1[EW]-([A-Z]\d{2})(?:-|$)/i;
const LINK_PATTERN = /^Link_(.+)_([^_]+)_BW([^_\s]+)$/i;
export class NvueParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "NvueParseError";
    }
}
export function inferRole(hostname) {
    const match = hostname.match(ROLE_PATTERN);
    return match?.[1]?.toUpperCase() ?? "UNKNOWN";
}
export function inferPod(hostname) {
    const match = hostname.match(POD_PATTERN);
    return match ? `POD${match[1]}` : "SHARED";
}
export function inferRack(hostname) {
    return hostname.match(RACK_PATTERN)?.[1]?.toUpperCase();
}
export function inferEndpointType(hostname) {
    const value = hostname.toUpperCase();
    if (value.includes("GPU"))
        return "GPU";
    if (/(?:^|-)BMC(?:-|$)/.test(value))
        return "BMC";
    if (value.includes("FW"))
        return "防火墙";
    if (value.includes("DDN") || value.includes("STOR"))
        return "存储";
    if (value.includes("UFM"))
        return "UFM";
    if (value.startsWith("CON"))
        return "控制台";
    if (value.includes("SERVER") || value.includes("SRV"))
        return "服务器";
    return "其他终端";
}
function compactLabel(hostname, role, pod) {
    const match = hostname.match(ROLE_PATTERN);
    const sequence = match?.[2]?.padStart(3, "0");
    if (match && sequence)
        return pod.startsWith("POD") ? `${pod}-${role}-${sequence}` : `${role}-${sequence}`;
    return hostname.length > 28 ? `${hostname.slice(0, 25)}…` : hostname;
}
function isExplicitInterface(name) {
    if (name.includes(","))
        return false;
    if (/^swp\d+-\d+$/i.test(name))
        return false;
    if (/^swp\d+s\d+-\d+$/i.test(name))
        return false;
    return !/\s/.test(name);
}
function getOrCreateInterface(interfaces, name) {
    const existing = interfaces.get(name);
    if (existing)
        return existing;
    const value = { name, addresses: [], peers: [] };
    interfaces.set(name, value);
    return value;
}
export function parseNvueDocument(content, _sourceFile) {
    void _sourceFile;
    const hostname = content.match(/^nv set system hostname (\S+)\s*$/m)?.[1];
    if (!hostname)
        throw new NvueParseError("未找到 NVUE system hostname");
    const interfaces = new Map();
    const links = [];
    for (const match of content.matchAll(/^nv set interface (\S+) description (.+?)\s*$/gm)) {
        const [, name, description] = match;
        if (!isExplicitInterface(name))
            continue;
        const record = getOrCreateInterface(interfaces, name);
        record.description = description;
        const link = description.match(LINK_PATTERN);
        if (link) {
            const [, targetHostname, targetInterface, bandwidth] = link;
            const peer = { device: targetHostname, interface: targetInterface, bandwidth };
            if (!record.peers.some((item) => item.device === peer.device && item.interface === peer.interface)) {
                record.peers.push(peer);
            }
            links.push({
                sourceHostname: hostname,
                sourceInterface: name,
                targetHostname,
                targetInterface,
                bandwidth,
            });
        }
    }
    for (const match of content.matchAll(/^nv set interface (\S+) ip address (\S+)\s*$/gm)) {
        const [, name, cidr] = match;
        if (!isExplicitInterface(name))
            continue;
        const record = getOrCreateInterface(interfaces, name);
        if (!record.addresses.some((item) => item.cidr === cidr && item.type === "primary")) {
            record.addresses.push({ cidr, type: "primary" });
        }
    }
    for (const match of content.matchAll(/^nv set interface (\S+) ip vrr address (\S+)\s*$/gm)) {
        const [, name, cidr] = match;
        if (!isExplicitInterface(name))
            continue;
        const record = getOrCreateInterface(interfaces, name);
        if (!record.addresses.some((item) => item.cidr === cidr && item.type === "vrr")) {
            record.addresses.push({ cidr, type: "vrr" });
        }
    }
    const role = inferRole(hostname);
    const pod = inferPod(hostname);
    const sortedInterfaces = [...interfaces.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const managementIp = sortedInterfaces
        .find((item) => item.name === "eth0")
        ?.addresses.find((item) => item.type === "primary")
        ?.cidr.split("/")[0];
    return {
        node: {
            id: deviceId(hostname),
            kind: "configured",
            hostname,
            label: compactLabel(hostname, role, pod),
            role,
            pod,
            rack: inferRack(hostname),
            managementIp,
            interfaces: sortedInterfaces,
        },
        links,
    };
}
function deviceId(hostname) {
    return `device:${hostname.toLowerCase()}`;
}
function externalId(hostname) {
    return `external:${hostname.toLowerCase()}`;
}
function digest(value) {
    return createHash("sha1").update(value).digest("hex").slice(0, 14);
}
function endpointKey(hostname, interfaceName) {
    return `${hostname.toLowerCase()}\u0000${interfaceName.toLowerCase()}`;
}
function inferPlane(sourceRole, targetRole, sourceInterface) {
    if ([sourceRole, targetRole].some((role) => role === "OOB" || role === "SOOB") || sourceInterface === "eth0") {
        return "management";
    }
    return "production";
}
function buildClusters(nodes) {
    const buckets = new Map();
    for (const node of nodes.filter((item) => item.kind === "external")) {
        const rack = node.rack?.match(/^[A-Z]+/)?.[0] ? `${node.rack.match(/^[A-Z]+/)?.[0]}区` : "UNKNOWN";
        const type = node.endpointType ?? "其他终端";
        const key = `${node.pod}|${rack}|${type}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(node);
        buckets.set(key, bucket);
    }
    const clusters = [];
    for (const [key, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        bucket.sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
        const [pod, rack, endpointType] = key.split("|");
        for (let offset = 0; offset < bucket.length; offset += MAX_CLUSTER_SIZE) {
            const chunk = bucket.slice(offset, offset + MAX_CLUSTER_SIZE);
            const chunkNumber = Math.floor(offset / MAX_CLUSTER_SIZE) + 1;
            const suffix = bucket.length > MAX_CLUSTER_SIZE ? ` · ${chunkNumber}` : "";
            const id = `cluster:${digest(`${key}|${chunkNumber}`)}`;
            for (const node of chunk)
                node.clusterId = id;
            clusters.push({
                id,
                label: `${pod === "SHARED" ? "共享" : pod} · ${rack} · ${endpointType}${suffix}`,
                pod,
                rack,
                endpointType,
                nodeIds: chunk.map((node) => node.id),
            });
        }
    }
    return clusters;
}
export async function parseConfigDirectory(configDir) {
    const dirents = await readdir(configDir, { withFileTypes: true });
    const sourceFiles = dirents
        .filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".md") && !item.name.includes("汇总报告"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const warnings = [];
    const devices = [];
    for (const source of sourceFiles) {
        try {
            const filePath = path.join(configDir, source.name);
            const content = await readFile(filePath, "utf8");
            if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
                warnings.push({ code: "FILE_SKIPPED", sourceFile: source.name, message: "文件超过 2 MiB，已跳过" });
                continue;
            }
            devices.push(parseNvueDocument(content, source.name));
        }
        catch (error) {
            warnings.push({
                code: "PARSE_ERROR",
                sourceFile: source.name,
                message: error instanceof Error ? error.message : "无法解析配置文件",
            });
        }
    }
    if (devices.length === 0)
        throw new NvueParseError("配置目录中没有可用的 NVUE 设备配置");
    const configuredByHostname = new Map(devices.map((item) => [item.node.hostname.toLowerCase(), item]));
    const externalByHostname = new Map();
    const physicalLinks = new Map();
    for (const device of devices) {
        for (const declaration of device.links) {
            const ends = [
                endpointKey(declaration.sourceHostname, declaration.sourceInterface),
                endpointKey(declaration.targetHostname, declaration.targetInterface),
            ].sort();
            const key = ends.join("<->");
            const current = physicalLinks.get(key) ?? { declarations: [] };
            current.declarations.push(declaration);
            physicalLinks.set(key, current);
            const targetKey = declaration.targetHostname.toLowerCase();
            if (!configuredByHostname.has(targetKey)) {
                let external = externalByHostname.get(targetKey);
                if (!external) {
                    const pod = inferPod(declaration.targetHostname);
                    external = {
                        id: externalId(declaration.targetHostname),
                        kind: "external",
                        hostname: declaration.targetHostname,
                        label: declaration.targetHostname.length > 30 ? `${declaration.targetHostname.slice(0, 27)}…` : declaration.targetHostname,
                        role: "ENDPOINT",
                        pod,
                        rack: inferRack(declaration.targetHostname),
                        endpointType: inferEndpointType(declaration.targetHostname),
                        interfaces: [],
                    };
                    externalByHostname.set(targetKey, external);
                }
                let targetInterface = external.interfaces.find((item) => item.name === declaration.targetInterface);
                if (!targetInterface) {
                    targetInterface = { name: declaration.targetInterface, addresses: [], peers: [] };
                    external.interfaces.push(targetInterface);
                }
                if (!targetInterface.peers.some((peer) => peer.device === declaration.sourceHostname && peer.interface === declaration.sourceInterface)) {
                    targetInterface.peers.push({
                        device: declaration.sourceHostname,
                        interface: declaration.sourceInterface,
                        bandwidth: declaration.bandwidth,
                    });
                }
            }
        }
    }
    const allNodes = [...devices.map((item) => item.node), ...externalByHostname.values()];
    const nodeByHostname = new Map(allNodes.map((node) => [node.hostname.toLowerCase(), node]));
    const links = [];
    for (const [key, value] of physicalLinks) {
        const declaration = value.declarations[0];
        const sourceNode = nodeByHostname.get(declaration.sourceHostname.toLowerCase());
        const targetNode = nodeByHostname.get(declaration.targetHostname.toLowerCase());
        if (!sourceNode || !targetNode)
            continue;
        const reciprocal = value.declarations.some((item) => item.sourceHostname.toLowerCase() === declaration.targetHostname.toLowerCase() &&
            item.sourceInterface.toLowerCase() === declaration.targetInterface.toLowerCase());
        if (targetNode.kind === "configured" && !reciprocal) {
            warnings.push({
                code: "UNPAIRED_LINK",
                message: `${declaration.sourceHostname}/${declaration.sourceInterface} 的对端声明不完整`,
            });
        }
        links.push({
            id: `link:${digest(key)}`,
            source: sourceNode.id,
            target: targetNode.id,
            sourceInterface: declaration.sourceInterface,
            targetInterface: declaration.targetInterface,
            bandwidth: declaration.bandwidth,
            plane: inferPlane(sourceNode.role, targetNode.role, declaration.sourceInterface),
            confidence: reciprocal ? "reciprocal" : targetNode.kind === "external" ? "inferred" : "declared",
            reciprocal,
        });
    }
    for (const node of externalByHostname.values()) {
        node.interfaces.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    const clusters = buildClusters(allNodes);
    const configuredIds = new Set(devices.map((item) => item.node.id));
    const countedInternalLinks = links.filter((link) => configuredIds.has(link.source) && configuredIds.has(link.target)).length;
    return {
        revision: digest(`${Date.now()}|${sourceFiles.map((item) => item.name).join("|")}|${links.length}`),
        refreshedAt: new Date().toISOString(),
        stats: {
            configuredDevices: devices.length,
            externalDevices: externalByHostname.size,
            physicalLinks: links.length,
            internalLinks: countedInternalLinks,
            externalLinks: links.length - countedInternalLinks,
            usedInterfaces: devices.reduce((sum, item) => sum + item.node.interfaces.length, 0),
            sourceFiles: sourceFiles.length,
            inventoryRecords: 0,
            inventoryMatched: 0,
            manualOverrides: 0,
        },
        nodes: allNodes.sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true })),
        links: links.sort((a, b) => a.id.localeCompare(b.id)),
        clusters,
        layoutPositions: {},
        warnings,
        sourceType: "nvue",
    };
}
//# sourceMappingURL=parser.js.map