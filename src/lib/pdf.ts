// PDF simple con pdf-lib: título, metadatos y una lista ordenada de pares etiqueta/valor.
// Fuente estándar Helvetica (WinAnsi): los caracteres fuera de ese juego se sustituyen por "?".
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"

export type LineaPdf = { etiqueta: string; valor: string; marca?: string }

const ANCHO = 595.28
const ALTO = 841.89
const MARGEN = 50

function winAnsi(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "?")
}

function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const palabras = winAnsi(texto).split(/\s+/)
  const lineas: string[] = []
  let actual = ""
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p
    if (fuente.widthOfTextAtSize(prueba, tam) > ancho && actual) {
      lineas.push(actual)
      actual = p
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

export async function crearPdf(opts: {
  titulo: string
  subtitulos: string[]
  lineas: LineaPdf[]
  pie: string[]
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  // Metadatos fijos: dos ejecuciones producen el mismo contenido.
  const fijo = new Date("2026-01-01T00:00:00Z")
  doc.setCreationDate(fijo)
  doc.setModificationDate(fijo)
  doc.setProducer("Agente Perxia (pdf-lib)")
  doc.setTitle(winAnsi(opts.titulo))
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  let page: PDFPage = doc.addPage([ANCHO, ALTO])
  let y = ALTO - MARGEN

  const escribir = (texto: string, fuente: PDFFont, tam: number, x = MARGEN, color = rgb(0.1, 0.1, 0.15)) => {
    for (const l of partir(texto, fuente, tam, ANCHO - x - MARGEN)) {
      if (y < MARGEN + 20) {
        page = doc.addPage([ANCHO, ALTO])
        y = ALTO - MARGEN
      }
      page.drawText(l, { x, y, size: tam, font: fuente, color })
      y -= tam + 4
    }
  }

  escribir(opts.titulo, negrita, 16)
  y -= 4
  for (const s of opts.subtitulos) escribir(s, normal, 10, MARGEN, rgb(0.35, 0.38, 0.45))
  y -= 10
  opts.lineas.forEach((l, i) => {
    escribir(`${i + 1}. ${l.etiqueta}${l.marca ? ` ${l.marca}` : ""}`, negrita, 11)
    escribir(l.valor || "-", normal, 11, MARGEN + 16)
    y -= 6
  })
  y -= 10
  for (const p of opts.pie) escribir(p, normal, 9, MARGEN, rgb(0.35, 0.38, 0.45))
  return doc.save({ useObjectStreams: false })
}
