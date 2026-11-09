import { Readable } from "node:stream";
import Papa from "papaparse";

export interface CsvTable {
  headers: string[];
  rows: Record<string, unknown>[];
}

/** Parse CSV incrementally so large exports do not create a second full text copy. */
export async function parseCsvBuffer(buffer: Buffer): Promise<CsvTable> {
  const rows: Record<string, unknown>[] = [];
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: header => header.replace(/^\uFEFF/, "").trim(),
  }) as unknown as NodeJS.ReadWriteStream;

  await new Promise<void>((resolve, reject) => {
    parser.on("data", row => rows.push(row as Record<string, unknown>));
    parser.once("error", reject);
    parser.once("end", resolve);
    Readable.from((function* () {
      const chunkBytes = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkBytes)
        yield buffer.subarray(offset, Math.min(buffer.length, offset + chunkBytes));
    })()).on("error", reject).pipe(parser);
  });

  let headers = rows.length ? Object.keys(rows[0]) : [];
  if (!headers.length && buffer.length) {
    const firstChunk = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString("utf8");
    headers = Papa.parse<Record<string, unknown>>(firstChunk, {
      header: true, preview: 1, skipEmptyLines: true, dynamicTyping: false,
      transformHeader: header => header.replace(/^\uFEFF/, "").trim(),
    }).meta.fields ?? [];
  }
  return { headers, rows };
}
