import fs from "node:fs/promises";
import { Workbook } from "@oai/artifact-tool";

const source = "C:/Users/liangchao/Downloads/Ports-20260827.csv";
const csvText = await fs.readFile(source, "utf8");
const workbook = await Workbook.fromCSV(csvText, { sheetName: "Ports" });
const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 16000,
  tableMaxRows: 12,
  tableMaxCols: 16,
  tableMaxCellChars: 120,
});
process.stdout.write(summary.ndjson);

const sheet = workbook.worksheets.getItem("Ports");
const values = sheet.getUsedRange(true).values;
const rows = values.slice(1).map((row) => row.map((value) => String(value ?? "").trim()));
const nodes = new Set();
const canonicalLinks = new Set();
let blankRequired = 0;
let reciprocalRows = 0;
let rowsWithBothLids = 0;
const podCounts = new Map();
const roleCounts = new Map();
for (const [system, port, lid, peer, peerPort, peerLid] of rows) {
  if (!system || !port || !peer || !peerPort) blankRequired += 1;
  if (system) nodes.add(system);
  if (peer) nodes.add(peer);
  if (lid && peerLid) rowsWithBothLids += 1;
  const ends = [`${system}\u0000${port}`, `${peer}\u0000${peerPort}`].sort();
  const key = ends.join("\u0001");
  if (canonicalLinks.has(key)) reciprocalRows += 1;
  else canonicalLinks.add(key);
}
for (const node of nodes) {
  const pod = node.match(/POD\d+/i)?.[0]?.toUpperCase() ?? "UNKNOWN";
  podCounts.set(pod, (podCounts.get(pod) ?? 0) + 1);
  const role = node.match(/-(GPU|IBLF|IBSP|IBSW|HCA|SW)-?\d*$/i)?.[1]?.toUpperCase() ?? (node.toLowerCase() === "hpn" ? "HPN" : "UNKNOWN");
  roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
}
process.stdout.write(`\n${JSON.stringify({
  dataRows: rows.length,
  uniqueNodes: nodes.size,
  physicalLinks: canonicalLinks.size,
  reciprocalOrDuplicateRows: reciprocalRows,
  blankRequired,
  rowsWithBothLids,
  pods: Object.fromEntries([...podCounts].sort()),
  roles: Object.fromEntries([...roleCounts].sort()),
  lastRows: rows.slice(-3),
})}`);
