import { createHash } from "node:crypto";
export function topologyStructureFingerprint(topology) {
    const nodes = topology.nodes.map((node) => ({
        id: node.id,
        hostname: node.hostname,
        interfaces: node.interfaces.map((item) => item.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const links = topology.links.map((link) => ({
        id: link.id,
        source: link.source,
        target: link.target,
        sourceInterface: link.sourceInterface,
        targetInterface: link.targetInterface,
    })).sort((a, b) => a.id.localeCompare(b.id));
    return createHash("sha256").update(JSON.stringify({ nodes, links })).digest("hex");
}
//# sourceMappingURL=topologyFingerprint.js.map