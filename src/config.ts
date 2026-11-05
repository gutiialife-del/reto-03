// Configuración de la aplicación: qué herramientas se publican y qué conocimiento recibe el agente.
// Comportamiento → agent/prompt.md · Conocimiento → src/knowledge/ · Ejecución → src/tools/.
import path from "node:path"
import { readText, fechaReferencia } from "./core/util"
import * as agente from "./tools/agente"
import * as oc from "./tools/oc"

export const APP = {
  nombre: "Órdenes de Compra SAP",
  herramientas: { oc, agente } as Record<string, Record<string, unknown>>,
  conocimiento: ["src/knowledge/ordenes-compra.md"],
  ejemplos: [
    'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
    'Procesa la solicitud "sol-001" y crea la OC.',
    'Procesa la solicitud "sol-003".',
  ],
}

export async function cargarSystemPrompt(root: string): Promise<string> {
  const prompt = (await readText(path.join(root, "agent", "prompt.md"))) ?? ""
  const partes = [prompt.trim()]
  for (const archivo of APP.conocimiento) {
    const texto = await readText(path.join(root, archivo))
    if (texto) partes.push(`\n\n---\n# Conocimiento del proceso (${archivo})\n\n${texto.trim()}`)
  }
  let fecha = ""
  try {
    fecha = fechaReferencia()
  } catch {
    fecha = "desconocida (FECHA_REFERENCIA inválida)"
  }
  partes.push(`\n\n---\nFecha actual del sistema: ${fecha}.`)
  return partes.join("")
}

/** Metadatos del módulo reutilizable (modulo/), generado por scripts/modulo.ts desde estas mismas piezas. */
export const MODULO = {
  descripcion: "Agente que valida paquetes de compra contra maestros (RC1–RC10), arma la OC con trazabilidad y la crea en SAP solo con controles superados y confirmación humana.",
  skill: "ordenes-compra",
  descripcionSkill: "Conocimiento del proceso de órdenes de compra de Periferia: controles RC1–RC10, payload SAP, evidencia de aprobación, idempotencia y OC retroactivas.",
  conocimiento: APP.conocimiento,
  herramientas: ["oc", "agente"],
}
