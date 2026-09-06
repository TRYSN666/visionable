import fs from "node:fs/promises";
import { Workbook } from "@oai/artifact-tool";

const csvPath = new URL("../../device-config/7月14日服务器SN核对 - Sheet1.csv", import.meta.url);
const csvText = await fs.readFile(csvPath, "utf8");
const workbook = await Workbook.fromCSV(csvText, { sheetName: "Sheet1" });
const overview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 12000,
  tableMaxRows: 15,
  tableMaxCols: 20,
  tableMaxCellChars: 120,
});
console.log(overview.ndjson);

const region = await workbook.inspect({
  kind: "region",
  sheetId: "Sheet1",
  range: "A1:Z30",
  maxChars: 20000,
});
console.log(region.ndjson);

const sheet = workbook.worksheets.getItem("Sheet1");
const values = sheet.getRange("A1:J628").values;
const rows = values.slice(1).filter((row) => row[5]);
const hostnames = rows.map((row) => String(row[5]).trim());
const missingInBand = rows.filter((row) => !row[8]).length;
const missingOutOfBand = rows.filter((row) => !row[7]).length;
const duplicateHostnames = hostnames.length - new Set(hostnames.map((value) => value.toLowerCase())).size;
console.log(JSON.stringify({ rows: rows.length, missingInBand, missingOutOfBand, duplicateHostnames, last: rows.at(-1)?.slice(1, 10) }));
const hostnameCounts = new Map();
for (const hostname of hostnames) hostnameCounts.set(hostname, (hostnameCounts.get(hostname) ?? 0) + 1);
const duplicateNames = [...hostnameCounts].filter(([, count]) => count > 1);
const unusualRows = rows.filter((row) => !/-GPU-\d+$/i.test(String(row[5]).trim())).map((row) => row.slice(1, 10));
const configDir = new URL("../../device-config/", import.meta.url);
const configFiles = (await fs.readdir(configDir)).filter((name) => name.endsWith(".md") && !name.includes("汇总"));
const externalNames = new Set();
for (const file of configFiles) {
  const content = await fs.readFile(new URL(file, configDir), "utf8");
  for (const match of content.matchAll(/^nv set interface \S+ description Link_(.+)_([^_]+)_BW[^_\s]+\s*$/gm)) externalNames.add(match[1].toLowerCase());
}
const unmatched = rows.filter((row) => !externalNames.has(String(row[5]).trim().toLowerCase())).map((row) => row.slice(1, 10));
console.log(JSON.stringify({ duplicateNames, unusualRows, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 10) }));
console.log(JSON.stringify(rows.filter((row) => String(row[5]).trim() === "MDC-DH1E-J25-POD1-GPU-162").map((row) => row.slice(1, 10))));
