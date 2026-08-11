import { buildPDFDoc, buildExcelWorkbook, filenameBase, type ExportableFinding, type ExportMeta } from './reportBuilders'

export type { ExportableFinding, ExportMeta }

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function exportFindingsAsExcel(findings: ExportableFinding[], meta: ExportMeta) {
  const workbook = await buildExcelWorkbook(findings, meta)
  const buffer = await workbook.xlsx.writeBuffer()
  triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filenameBase(meta)}.xlsx`)
}

export function exportFindingsAsPDF(findings: ExportableFinding[], meta: ExportMeta) {
  const doc = buildPDFDoc(findings, meta)
  doc.save(`${filenameBase(meta)}.pdf`)
}
