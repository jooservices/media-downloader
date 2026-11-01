// Packages the extension (only the files the manifest needs) into build/media-downloader-<version>.zip.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestFiles } from "./validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (2026 - 1980) * 512 + 1 * 32 + 1; // a fixed date keeps the archive reproducible

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The files that make up the extension: the manifest plus everything it references and imports. */
export function extensionFiles(manifest, readText) {
  const files = new Set(["manifest.json", ...manifestFiles(manifest)]);
  const workerDirectory = path.posix.dirname(manifest.background?.service_worker ?? ".");
  const worker = manifest.background?.service_worker;
  if (worker) {
    for (const match of readText(worker).matchAll(/importScripts\(([^)]*)\)/g)) {
      for (const name of match[1].matchAll(/["']([^"']+)["']/g)) {
        files.add(path.posix.normalize(path.posix.join(workerDirectory, name[1])));
      }
    }
  }
  return [...files].sort();
}

function zipEntry(name, data, offset) {
  const nameBuffer = Buffer.from(name);
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(FIXED_DOS_TIME, 10);
  local.writeUInt16LE(FIXED_DOS_DATE, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 30);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(offset, 42);
  return {
    local: Buffer.concat([local, nameBuffer, compressed]),
    central: Buffer.concat([central, nameBuffer])
  };
}

/** A zip archive (as a Buffer) holding the given { name, data } entries. */
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const entry = zipEntry(name, data, offset);
    locals.push(entry.local);
    centrals.push(entry.central);
    offset += entry.local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function main() {
  const read = file => readFileSync(path.join(ROOT, file));
  const manifest = JSON.parse(read("manifest.json").toString("utf8"));
  const files = extensionFiles(manifest, file => read(file).toString("utf8"));
  const zip = createZip(files.map(name => ({ name, data: read(name) })));
  const output = path.join(ROOT, "build", `media-downloader-${manifest.version}.zip`);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, zip);
  console.log(`✔ ${path.relative(ROOT, output)} (${files.length} files, ${zip.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
