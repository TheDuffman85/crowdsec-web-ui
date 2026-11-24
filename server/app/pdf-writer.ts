/**
 * A small PDF writer for text, tables and bar charts. It uses the built-in
 * Helvetica fonts and WinAnsi text, so anything outside Latin-1 prints as "?".
 */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

type Color = [number, number, number];

function toLatin1(value: string): string {
  let result = '';
  for (const char of value.normalize('NFC')) {
    const code = char.codePointAt(0)!;
    result += code <= 0xff && code >= 0x20 ? char : code === 0x2013 || code === 0x2014 ? '-' : code === 0x2019 ? "'" : code === 0x2026 ? '...' : '?';
  }
  return result;
}

function escapeText(value: string): string {
  return toLatin1(value).replace(/[\\()]/g, (char) => `\\${char}`);
}

const num = (value: number): string => (Math.round(value * 100) / 100).toString();

// Approximate Helvetica widths (per 1000 em) for the average character; good enough for truncation.
function textWidth(value: string, size: number, bold: boolean): number {
  let units = 0;
  for (const char of toLatin1(value)) {
    if ('iljIt.,:;!|\' '.includes(char)) units += 280;
    else if ('mwMW'.includes(char)) units += 830;
    else if (/[A-Z0-9]/.test(char)) units += 670;
    else units += bold ? 590 : 540;
  }
  return (units / 1000) * size;
}

export function truncateToWidth(value: string, maxWidth: number, size: number, bold = false): string {
  if (textWidth(value, size, bold) <= maxWidth) return value;
  let result = value;
  while (result.length > 1 && textWidth(`${result}...`, size, bold) > maxWidth) result = result.slice(0, -1);
  return `${result}...`;
}

export class PdfDocument {
  private pages: string[][] = [];
  private cursorY = 0;
  private pageNumber = 0;

  constructor(private readonly footer: string) {
    this.addPage();
  }

  get contentWidth(): number {
    return PAGE_WIDTH - MARGIN * 2;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
    this.pageNumber += 1;
    this.cursorY = PAGE_HEIGHT - MARGIN;
  }

  private ensureSpace(height: number): void {
    if (this.cursorY - height < MARGIN + 20) this.addPage();
  }

  private ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  private drawText(x: number, y: number, value: string, size: number, bold: boolean, color: Color = [0.1, 0.1, 0.1]): void {
    this.ops().push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${color.map(num).join(' ')} rg ${num(x)} ${num(y)} Td (${escapeText(value)}) Tj ET`);
  }

  private fillRect(x: number, y: number, width: number, height: number, color: Color): void {
    this.ops().push(`${color.map(num).join(' ')} rg ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`);
  }

  title(value: string, subtitle?: string): void {
    this.ensureSpace(60);
    this.drawText(MARGIN, this.cursorY - 22, value, 22, true);
    this.cursorY -= 30;
    if (subtitle) {
      this.drawText(MARGIN, this.cursorY - 12, subtitle, 10, false, [0.4, 0.4, 0.4]);
      this.cursorY -= 18;
    }
    this.cursorY -= 8;
  }

  heading(value: string): void {
    this.ensureSpace(40);
    this.cursorY -= 10;
    this.drawText(MARGIN, this.cursorY - 14, value, 14, true, [0.12, 0.25, 0.5]);
    this.cursorY -= 22;
  }

  paragraph(value: string, size = 10): void {
    const maxWidth = this.contentWidth;
    const words = toLatin1(value).split(/\s+/).filter(Boolean);
    let line = '';
    const flush = () => {
      if (!line) return;
      this.ensureSpace(size + 4);
      this.drawText(MARGIN, this.cursorY - size, line, size, false);
      this.cursorY -= size + 4;
      line = '';
    };
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, false) > maxWidth) {
        flush();
        line = word;
      } else {
        line = candidate;
      }
    }
    flush();
    this.cursorY -= 4;
  }

  /** Big numbers in a row, for headline figures. */
  keyFigures(figures: Array<{ label: string; value: string }>): void {
    this.ensureSpace(52);
    const width = this.contentWidth / figures.length;
    figures.forEach((figure, index) => {
      const x = MARGIN + index * width;
      this.fillRect(x + 2, this.cursorY - 46, width - 6, 46, [0.94, 0.96, 0.99]);
      this.drawText(x + 10, this.cursorY - 22, truncateToWidth(figure.value, width - 20, 18, true), 18, true, [0.12, 0.25, 0.5]);
      this.drawText(x + 10, this.cursorY - 38, truncateToWidth(figure.label, width - 20, 8), 8, false, [0.4, 0.4, 0.4]);
    });
    this.cursorY -= 56;
  }

  table(headers: string[], rows: string[][], columnWidths?: number[]): void {
    const widths = columnWidths ?? headers.map(() => this.contentWidth / headers.length);
    const rowHeight = 16;
    const drawRow = (cells: string[], bold: boolean, shade: boolean) => {
      this.ensureSpace(rowHeight);
      if (shade) this.fillRect(MARGIN, this.cursorY - rowHeight + 3, this.contentWidth, rowHeight, [0.95, 0.95, 0.95]);
      let x = MARGIN;
      cells.forEach((cell, index) => {
        const align = index === cells.length - 1 && index > 0 ? 'right' : 'left';
        const text = truncateToWidth(cell, widths[index] - 8, 9, bold);
        const textX = align === 'right' ? x + widths[index] - 4 - textWidth(text, 9, bold) : x + 4;
        this.drawText(textX, this.cursorY - 9, text, 9, bold);
        x += widths[index];
      });
      this.cursorY -= rowHeight;
    };
    drawRow(headers, true, true);
    if (rows.length === 0) {
      this.drawText(MARGIN + 4, this.cursorY - 9, '-', 9, false, [0.5, 0.5, 0.5]);
      this.cursorY -= rowHeight;
    }
    rows.forEach((row) => drawRow(row, false, false));
    this.cursorY -= 6;
  }

  barChart(values: Array<{ label: string; value: number }>, height = 90): void {
    this.ensureSpace(height + 26);
    const max = Math.max(1, ...values.map((entry) => entry.value));
    const slot = this.contentWidth / Math.max(1, values.length);
    const baseY = this.cursorY - height;
    values.forEach((entry, index) => {
      const barHeight = (entry.value / max) * (height - 12);
      this.fillRect(MARGIN + index * slot + slot * 0.15, baseY, slot * 0.7, Math.max(barHeight, entry.value > 0 ? 1 : 0), [0.25, 0.45, 0.8]);
    });
    this.drawText(MARGIN, baseY - 11, values[0]?.label ?? '', 8, false, [0.4, 0.4, 0.4]);
    const last = values[values.length - 1]?.label ?? '';
    this.drawText(MARGIN + this.contentWidth - textWidth(last, 8, false), baseY - 11, last, 8, false, [0.4, 0.4, 0.4]);
    this.drawText(MARGIN + this.contentWidth - 60, this.cursorY - 8, `max ${max}`, 8, false, [0.4, 0.4, 0.4]);
    this.cursorY = baseY - 22;
  }

  toBuffer(): Buffer {
    const total = this.pages.length;
    // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then a page and a content stream per page.
    const objects: string[] = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    const kids = this.pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ');
    objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    this.pages.forEach((ops, index) => {
      const pageId = 5 + index * 2;
      const footer = `BT /F1 8 Tf 0.5 0.5 0.5 rg ${num(MARGIN)} 28 Td (${escapeText(this.footer)}) Tj ET BT /F1 8 Tf 0.5 0.5 0.5 rg ${num(PAGE_WIDTH - MARGIN - 40)} 28 Td (${escapeText(`Page ${index + 1} of ${total}`)}) Tj ET`;
      const stream = `${ops.join('\n')}\n${footer}`;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
      objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    });

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets: number[] = [];
    let position = chunks[0].length;
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = position;
      const chunk = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'latin1');
      chunks.push(chunk);
      position += chunk.length;
    }
    const xref = [`xref\n0 ${objects.length}\n0000000000 65535 f \n`];
    for (let id = 1; id < objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`);
    chunks.push(Buffer.from(xref.join(''), 'latin1'));
    return Buffer.concat(chunks);
  }
}
