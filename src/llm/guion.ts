// Guion del proveedor SIMULADO (no es un LLM). Reproduce el flujo del prompt de ejemplo para probar
// el ciclo, la compuerta de confirmación y el front sin clave de API.
import type { ChatMessage } from "./adapter"
import type { EstadoTurno, Guion, PasoGuion } from "./simulado"

type Data = Record<string, unknown>
const llamar = (name: string, args: Record<string, unknown>): PasoGuion => ({ text: "", toolCalls: [{ id: "", name, args }] })
const decir = (text: string): PasoGuion => ({ text: text + "\n\n_Respuesta del proveedor simulado (guion de pruebas, sin LLM)._", toolCalls: [] })

function dato(e: EstadoTurno, name: string): { ok: boolean; data: Data } | null {
  const r = [...e.resultados].reverse().find((x) => x.name === name)
  return r ? { ok: r.ok, data: (r.data ?? {}) as Data } : null
}

function ultimoPayload(h: ChatMessage[]): { caso: string; payload: Data } | null {
  let caso: string | null = null
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i]
    if (m?.role === "assistant") for (const tc of m.toolCalls) if (tc.name === "oc_construir_payload" && typeof tc.args.caso === "string") caso = tc.args.caso
    if (m?.role === "tool" && m.name === "oc_construir_payload") {
      try {
        const d = (JSON.parse(m.content) as { data?: Data }).data
        if (d?.payload && caso === null) {
          // el caso se resuelve en la llamada del asistente que precede a este resultado
          for (let j = i - 1; j >= 0; j--) {
            const a = h[j]
            if (a?.role === "assistant") {
              const tc = a.toolCalls.find((t) => t.name === "oc_construir_payload")
              if (tc && typeof tc.args.caso === "string") return { caso: tc.args.caso, payload: d.payload as Data }
            }
          }
        }
      } catch {
        // contenido no JSON: se ignora
      }
    }
  }
  return null
}

export const guion: Guion = (e) => {
  const t = e.usuario.toLowerCase()
  const caso = t.match(/\bsol-\d{3}\b/)?.[0] ?? null

  if (!caso && /confirmo|procede|cr[eé]ala/.test(t)) {
    const p = ultimoPayload(e.historial)
    if (!p) return decir("No tengo una OC pendiente de confirmar.")
    const c = dato(e, "oc_crear")
    if (!c) return llamar("oc_crear", { caso: p.caso, payload: p.payload, confirmado: true })
    return decir(c.ok ? `OC **${String(c.data.numero_oc)}** creada (${String(c.data.fecha)}). Evidencia: \`${String(c.data.evidencia)}\` y \`${String(c.data.evidencia_pdf)}\`.` : `No se creó la OC: ${JSON.stringify(c.data)}`)
  }
  if (!caso) return decir('Indícame la solicitud, por ejemplo: *Procesa la solicitud "sol-004"*.')

  const paq = dato(e, "oc_leer_paquete")
  if (!paq) return llamar("oc_leer_paquete", { caso })
  if (!paq.ok) return decir(`No pude leer el paquete: ${JSON.stringify(paq.data)}`)
  const val = dato(e, "oc_validar")
  if (!val) return llamar("oc_validar", { caso, paquete: paq.data })
  const v = val.data
  const bloqueos = (v.bloqueos as Data[]) ?? []
  const confs = (v.confirmaciones as Data[]) ?? []
  const controles = ((v.controles as Data[]) ?? []).map((c) => `| ${String(c.regla)} | ${String(c.resultado)} | ${String(c.detalle)} |`)

  if (!v.apta) {
    const c = dato(e, "oc_crear")
    if (!c) return llamar("oc_crear", { caso })
    return decir(["**No apta** — la OC no se crea.", "", "| Regla | Resultado | Detalle |", "|---|---|---|", ...controles, "", ...bloqueos.map((b) => `- **${String(b.codigo)}**: ${String(b.detalle)} → *${String(b.accion_sugerida)}*`)].join("\n"))
  }
  const pay = dato(e, "oc_construir_payload")
  if (!pay) return llamar("oc_construir_payload", { caso, paquete: paq.data, derivados: v.derivados })
  if (!dato(e, "oc_generar_evidencia")) return llamar("oc_generar_evidencia", { caso })
  const o = pay.data.payload as Data
  const pos = ((o.posiciones as Data[]) ?? [])[0] ?? {}
  const prov = o.proveedor as Data
  const tabla = [
    "| Campo | Valor |",
    "|---|---|",
    `| Proveedor | ${String(prov.nombre)} (${String(prov.codigo_sap)}) |`,
    `| Posición 10 | ${String(pos.descripcion)} |`,
    `| Cantidad × precio | ${String(pos.cantidad)} ${String(pos.unidad)} × ${String(o.moneda)} ${String(pos.precio_unitario)} |`,
    `| Centro / subárea | ${String(pos.centro_costo)} / ${String(pos.subarea)} |`,
    `| IVA · pago | ${String(pos.indicador_iva)} · ${String(o.condiciones_pago)} |`,
    `| Aprobador | ${String((o.aprobador as Data).email)} |`,
  ]
  const esperar = confs.length > 0 || /no la crees|no crees|hasta que/.test(t)
  if (esperar) {
    if (!dato(e, "agente_solicitar_confirmacion")) {
      return llamar("agente_solicitar_confirmacion", { accion: `crear la OC de ${caso}`, detalle: confs.map((c) => `${String(c.codigo)}: ${String(c.detalle)}`).join(" | ") || "creación de la OC" })
    }
    return decir(["**Apta**, pendiente de tu confirmación." + (v.retroactiva ? " **OC retroactiva.**" : ""), "", ...tabla, "", "| Regla | Resultado | Detalle |", "|---|---|---|", ...controles, "", ...confs.map((c) => `- **${String(c.codigo)}**: ${String(c.detalle)}`), "", "¿Confirmas que cree la OC con estos valores?"].join("\n"))
  }
  const c = dato(e, "oc_crear")
  if (!c) return llamar("oc_crear", { caso, payload: o })
  return decir([c.ok ? `OC **${String(c.data.numero_oc)}** creada${c.data.idempotente ? " (ya existía: idempotente)" : ""}.` : `No se creó: ${JSON.stringify(c.data)}`, "", ...tabla].join("\n"))
}
