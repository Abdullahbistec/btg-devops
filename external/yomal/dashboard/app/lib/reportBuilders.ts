import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import ExcelJS from 'exceljs'

// Environment-agnostic report construction — both jsPDF and exceljs work in
// Node as well as the browser, so this same code builds the PDF/Excel used
// for the Export button's download (browser) AND the Share email's
// attachments (server, see app/api/utils/reportAttachments.ts). Only the
// "what do I do with the finished document" step differs by environment —
// that logic lives in the two respective callers, not here.

export interface ExportableFinding {
  severity: string
  category: string
  resource_type: string
  resource_name: string
  issue: string
  evidence?: string | null
  recommendation: string
}

export interface ExportMeta {
  auditId: string
  scopeLabel: string
  summary: string
  generatedAt: string
}

export const BRAND_PURPLE_RGB: [number, number, number] = [124, 58, 237]
const BRAND_PURPLE_HEX = '7c3aed'
const SEVERITY_FILL: Record<string, string> = { Critical: 'FEE2E2', Warning: 'FEF3C7', Info: 'DBEAFE' }
const SEVERITY_TEXT: Record<string, string> = { Critical: 'B91C1C', Warning: '92400E', Info: '1D4ED8' }
const SEVERITY_RGB: Record<string, [number, number, number]> = {
  Critical: [254, 226, 226], Warning: [254, 243, 199], Info: [219, 234, 254],
}

export function filenameBase(meta: ExportMeta): string {
  return `audit-${meta.auditId.slice(0, 8)}-${meta.scopeLabel.replace(/\s+/g, '-')}`
}

// A real formatted .xlsx (not plain CSV) — branded title row, styled header,
// severity-tinted rows, wrapped text, auto-filter, frozen header.
export async function buildExcelWorkbook(findings: ExportableFinding[], meta: ExportMeta): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'BTG DevOps · Azure Audit Console'
  workbook.created = new Date(meta.generatedAt)

  const sheet = workbook.addWorksheet('Findings', { views: [{ state: 'frozen', ySplit: 4 }] })
  sheet.columns = [
    { width: 12 }, { width: 20 }, { width: 20 }, { width: 26 }, { width: 45 }, { width: 40 }, { width: 45 },
  ]

  sheet.mergeCells('A1:G1')
  const title = sheet.getCell('A1')
  title.value = `Azure Audit Analysis — ${meta.scopeLabel}`
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND_PURPLE_HEX}` } }
  title.alignment = { vertical: 'middle' }
  sheet.getRow(1).height = 26

  sheet.mergeCells('A2:G2')
  const metaCell = sheet.getCell('A2')
  metaCell.value = `Audit ${meta.auditId} · Generated ${new Date(meta.generatedAt).toLocaleString()}`
  metaCell.font = { italic: true, size: 9, color: { argb: 'FF64748B' } }

  const headerRow = sheet.getRow(4)
  headerRow.values = ['Severity', 'Category', 'Resource Type', 'Resource Name', 'Issue', 'Evidence', 'Recommendation']
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  headerRow.height = 20
  sheet.autoFilter = { from: 'A4', to: 'G4' }

  findings.forEach(f => {
    const row = sheet.addRow([f.severity, f.category, f.resource_type, f.resource_name, f.issue, f.evidence || '', f.recommendation])
    row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true } })
    const fill = SEVERITY_FILL[f.severity]
    if (fill) {
      const sevCell = row.getCell(1)
      sevCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
      sevCell.font = { bold: true, color: { argb: `FF${SEVERITY_TEXT[f.severity]}` } }
    }
  })

  return workbook
}

// Branded PDF report — header bar, severity-tinted table cells, footer with
// page numbers, matching the dashboard's own visual identity.
export function buildPDFDoc(findings: ExportableFinding[], meta: ExportMeta): jsPDF {
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()

  doc.setFillColor(...BRAND_PURPLE_RGB)
  doc.rect(0, 0, pageWidth, 22, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(9)
  doc.text('BTG DEVOPS · AZURE AUDIT CONSOLE', 14, 9)
  doc.setFontSize(13)
  doc.text(`Azure Audit Analysis — ${meta.scopeLabel}`, 14, 17)

  doc.setTextColor(100)
  doc.setFontSize(8)
  doc.text(`Audit ${meta.auditId} · Generated ${new Date(meta.generatedAt).toLocaleString()}`, 14, 28)

  let y = 34
  if (meta.summary) {
    doc.setFontSize(10)
    doc.setTextColor(30)
    const lines = doc.splitTextToSize(meta.summary, pageWidth - 28)
    doc.text(lines, 14, y)
    y += lines.length * 5 + 6
  }

  autoTable(doc, {
    startY: y,
    head: [['Severity', 'Resource Type', 'Resource Name', 'Issue', 'Evidence', 'Recommendation']],
    body: findings.map(f => [f.severity, f.resource_type, f.resource_name, f.issue, f.evidence || '', f.recommendation]),
    styles: { fontSize: 8, cellWidth: 'wrap', lineColor: [226, 232, 240], lineWidth: 0.3 },
    columnStyles: { 2: { cellWidth: 28 }, 3: { cellWidth: 36 }, 4: { cellWidth: 36 }, 5: { cellWidth: 36 } },
    headStyles: { fillColor: BRAND_PURPLE_RGB, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didParseCell: data => {
      if (data.section === 'body' && data.column.index === 0) {
        const sev = String(data.cell.raw)
        const rgb = SEVERITY_RGB[sev]
        if (rgb) {
          data.cell.styles.fillColor = rgb
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.textColor = sev === 'Critical' ? [185, 28, 28] : sev === 'Warning' ? [146, 64, 14] : [29, 78, 216]
        }
      }
    },
  })

  // Footer added in a second pass, after the table is fully laid out — the
  // total page count isn't known yet during didDrawPage (only pages
  // rendered so far), so writing "page X of Y" there would show a wrong Y
  // on every page except the last.
  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFontSize(7.5)
    doc.setTextColor(148, 163, 184)
    doc.text(`BTG DevOps Azure Audit Console — page ${i} of ${totalPages}`, 14, doc.internal.pageSize.getHeight() - 8)
  }

  return doc
}
