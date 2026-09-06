import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
function text(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}
function score(record) {
    return (record.consistent ? 100 : 0) + (record.inBandIp ? 10 : 0) + (record.outOfBandIp ? 10 : 0);
}
export async function loadServerInventory(configDir) {
    const warnings = [];
    const files = (await readdir(configDir, { withFileTypes: true }))
        .filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".csv"))
        .sort((a, b) => Number(b.name.includes("SN核对")) - Number(a.name.includes("SN核对")) || a.name.localeCompare(b.name));
    const source = files[0];
    if (!source)
        return { records: new Map(), warnings };
    const csvText = await readFile(path.join(configDir, source.name), "utf8");
    const rows = parse(csvText, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
    });
    const records = new Map();
    for (const [index, row] of rows.entries()) {
        const hostname = text(row["主机名"]);
        if (!hostname || !/-GPU-\d+$/i.test(hostname)) {
            warnings.push({
                code: "INVENTORY_ROW_SKIPPED",
                sourceFile: source.name,
                message: `第 ${index + 2} 行没有可匹配的正式 GPU 主机名，已跳过`,
            });
            continue;
        }
        const record = {
            hostname,
            outOfBandIp: text(row["带外地址"]),
            inBandIp: text(row["带内地址"]),
            consistent: text(row["是否一致"]) === "一致",
        };
        const key = hostname.toLowerCase();
        const existing = records.get(key);
        if (existing) {
            warnings.push({
                code: "INVENTORY_DUPLICATE",
                sourceFile: source.name,
                message: `${hostname} 存在重复记录，已采用完整度和一致性更高的一条`,
            });
            if (score(record) > score(existing))
                records.set(key, record);
        }
        else {
            records.set(key, record);
        }
    }
    return { records, warnings, sourceFile: source.name };
}
export function applyServerInventory(snapshot, inventory, overrides) {
    let matched = 0;
    let manualOverrides = 0;
    const matchedInventory = new Set();
    const nodes = snapshot.nodes.map((node) => {
        if (node.kind !== "external" || node.endpointType !== "GPU")
            return node;
        const key = node.hostname.toLowerCase();
        const record = inventory.records.get(key);
        const override = overrides.get(key);
        if (!record && !override)
            return node;
        if (record) {
            matched += 1;
            matchedInventory.add(key);
        }
        if (override)
            manualOverrides += 1;
        const serverInfo = {
            inventoryInBandIp: record?.inBandIp,
            inventoryOutOfBandIp: record?.outOfBandIp,
            inBandIp: override ? override.inBandIp : record?.inBandIp,
            outOfBandIp: override ? override.outOfBandIp : record?.outOfBandIp,
            manualOverride: Boolean(override),
            overrideUpdatedAt: override?.updatedAt,
        };
        return { ...node, serverInfo };
    });
    const unmatchedWarnings = [];
    for (const record of inventory.records.values()) {
        if (!matchedInventory.has(record.hostname.toLowerCase())) {
            unmatchedWarnings.push({
                code: "INVENTORY_UNMATCHED",
                sourceFile: inventory.sourceFile,
                message: `${record.hostname} 未在当前拓扑终端中找到`,
            });
        }
    }
    return {
        ...snapshot,
        nodes,
        stats: {
            ...snapshot.stats,
            inventoryRecords: inventory.records.size,
            inventoryMatched: matched,
            manualOverrides,
        },
        warnings: [...snapshot.warnings, ...inventory.warnings, ...unmatchedWarnings],
    };
}
//# sourceMappingURL=inventory.js.map