import { createHash, type Hash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type BackupPart = { file: string; bytes: number; sha256: string; rowCount: number };
type Table = { schema: string; name: string; rows: number; segmentRows: number; open: boolean };

/** Writes bounded, independently valid JSON files without buffering the database. */
export class BackupJsonWriter {
  readonly parts: BackupPart[] = [];
  private handle?: FileHandle;
  private hash?: Hash;
  private bytes = 0;
  private segments = 0;
  private rows = 0;
  private table?: Table;
  constructor(
    private directory: string,
    private header: Record<string, unknown>,
    private maxBytes = Infinity,
  ) {}

  private async write(text: string) {
    await this.handle!.writeFile(text, "utf8");
    this.hash!.update(text, "utf8");
    this.bytes += Buffer.byteLength(text);
  }
  private async openPart() {
    if (this.handle) return;
    this.handle = await open(join(this.directory, `data-${String(this.parts.length + 1).padStart(4, "0")}.json`), "wx", 0o600);
    this.hash = createHash("sha256");
    this.bytes = this.segments = this.rows = 0;
    await this.write(JSON.stringify({ ...this.header, part: this.parts.length + 1 }).slice(0, -1) + ',"tables":[\n');
  }
  private segmentHeader() {
    const table = this.table!;
    return (this.segments ? ",\n" : "") +
      JSON.stringify({ schema: table.schema, name: table.name, rowOffset: table.rows }).slice(0, -1) + ',"rows":[\n';
  }
  private async openSegment() {
    if (this.table!.open) return;
    await this.write(this.segmentHeader());
    this.table!.open = true;
    this.table!.segmentRows = 0;
    this.segments++;
  }
  private async closeSegment() {
    if (!this.table?.open) return;
    await this.write(`\n],"rowCount":${this.table.segmentRows}}`);
    this.table.open = false;
  }
  private async closePart() {
    if (!this.handle) return;
    await this.closeSegment();
    await this.write('\n],"partComplete":true}\n');
    await this.handle.sync();
    await this.handle.close();
    this.handle = undefined;
    this.parts.push({
      file: `data-${String(this.parts.length + 1).padStart(4, "0")}.json`,
      bytes: this.bytes, sha256: this.hash!.digest("hex"), rowCount: this.rows,
    });
  }
  async beginTable(schema: string, name: string) {
    if (this.table) throw new Error("Previous backup table is still open");
    this.table = { schema, name, rows: 0, segmentRows: 0, open: false };
  }
  private async makeRoom(rowJson?: string) {
    await this.openPart();
    const required = () => Buffer.byteLength(
      (this.table!.open ? (this.table!.segmentRows ? ",\n" : "") : this.segmentHeader()) + (rowJson ?? ""),
    ) + 512; // Reserve closing JSON and row counts.
    if (this.bytes + required() > this.maxBytes && this.segments) {
      await this.closePart();
      await this.openPart();
    }
    if (this.bytes + required() > this.maxBytes) {
      throw new Error("A single database row or table header exceeds the JSON part limit");
    }
    await this.openSegment();
  }
  async row(json: string) {
    await this.makeRoom(json);
    if (this.table!.segmentRows) await this.write(",\n");
    await this.write(json);
    this.table!.rows++;
    this.table!.segmentRows++;
    this.rows++;
  }
  async endTable() {
    if (!this.table!.open) await this.makeRoom();
    await this.closeSegment();
    this.table = undefined;
  }
  async finish() {
    await this.openPart(); // An empty database still produces valid JSON.
    await this.closePart();
    return this.parts;
  }
  async abort() {
    await this.handle?.close().catch(() => {});
    this.handle = undefined;
  }
}
