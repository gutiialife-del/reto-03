// Herramientas del agente "Órdenes de Compra SAP". Cada export se publica como oc_<export>.
// Son la única fuente de valores que el agente puede afirmar: montos y códigos salen de aquí.
import path from "node:path"
import { appendFile } from "node:fs/promises"
import { z } from "zod/v4"
import { defineTool, fail, guard, ok } from "../core/tool"
import { ahora, exists, rel, writeJson, writeText } from "../core/util"
import {
  type Paquete,
  type Reglas,
  type Validacion,
  cargarReglas,
  construirOrden,
  diferenciasPayload,
  evidenciaDelCaso,
  leerPaquete,
  rutas,
  validarPaquete,
} from "../lib/dominio"
import { crearPdf } from "../lib/pdf"
import { OrdenCompraSchema } from "../sap/adapter"
import { SapMock } from "../sap/mock"

const casoArg = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. 'sol-004'")
const objetoArg = (desc: string) => z.record(z.string(), z.unknown()).describe(desc)

/** Recalcula todo desde los archivos: la herramienta nunca confía en objetos que le devuelve el modelo. */
async function contexto(dir: string, caso: string): Promise<{ reglas: Reglas; paquete: Paquete; validacion: Validacion; sap: SapMock }> {
  const reglas = await cargarReglas(dir)
  const sap = new SapMock(dir, reglas.numero_oc_inicial)
  const paquete = await leerPaquete(dir, caso, reglas)
  const validacion = await validarPaquete(dir, paquete, sap, reglas)
  return { reglas, paquete, validacion, sap }
}

function contradicciones(propuesto: Record<string, unknown> | undefined, real: Paquete): string[] {
  if (!propuesto) return []
  const s = (propuesto.solicitud ?? {}) as Record<string, unknown>
  const difs: string[] = []
  for (const k of ["solicitud_id", "proveedor_nit", "centro_costo", "subarea", "cantidad", "valor_unitario", "valor_total", "moneda", "indicador_iva", "condiciones_pago"] as const) {
    if (k in s && JSON.stringify(s[k]) !== JSON.stringify(real.solicitud[k])) difs.push(`solicitud.${k}`)
  }
  return difs
}

export const leer_paquete = defineTool({
  description: "Lee correo, solicitud, cotización, aprobación y factura (si existe) del caso y los devuelve normalizados; un adjunto ausente queda en null.",
  args: { caso: casoArg },
  async execute(args, ctx) {
    return guard(async () => {
      const reglas = await cargarReglas(ctx.directory)
      const p = await leerPaquete(ctx.directory, args.caso, reglas)
      const { texto: _t, ...cot } = p.cotizacion ?? { texto: "" }
      return ok({
        ...p,
        cotizacion: p.cotizacion ? cot : null,
        resumen: `${p.solicitud.solicitud_id} · ${p.solicitud.proveedor_nombre} · ${p.solicitud.moneda} ${p.solicitud.valor_total.toLocaleString("es-CO")}${p.faltantes.length ? ` · faltan: ${p.faltantes.join(", ")}` : ""}${p.factura ? ` · con factura ${p.factura.numero}` : ""}`,
      })
    })
  },
})

export const validar = defineTool({
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones (con acción sugerida), derivados y si la OC es retroactiva.",
  args: { caso: casoArg, paquete: objetoArg("data devuelto por oc_leer_paquete; se verifica contra los archivos").optional() },
  async execute(args, ctx) {
    return guard(async () => {
      const { paquete, validacion } = await contexto(ctx.directory, args.caso)
      const difs = contradicciones(args.paquete, paquete)
      if (difs.length) return fail(`el paquete recibido no coincide con los archivos del caso (${difs.join(", ")}); usa la salida de oc_leer_paquete sin modificar`)
      const { proveedor: _p, ...visible } = validacion
      await writeJson(path.join(rutas(ctx.directory).out(args.caso), "validacion.json"), { caso: args.caso, ts: ahora(), ...visible })
      return ok({
        ...visible,
        ...(validacion.apta && validacion.confirmaciones.length
          ? { pendiente_confirmacion: { accion: `crear la OC de ${args.caso} aceptando ${validacion.confirmaciones.map((c) => c.codigo).join(", ")}`, detalle: validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" | ") } }
          : {}),
        resumen: `${validacion.apta ? "apta" : "NO apta"} · bloqueos: ${validacion.bloqueos.map((b) => b.codigo).join(", ") || "ninguno"} · confirmaciones: ${validacion.confirmaciones.map((c) => c.codigo).join(", ") || "ninguna"}${validacion.retroactiva ? " · RETROACTIVA" : ""}`,
      })
    })
  },
})

export const construir_payload = defineTool({
  description: "Construye la OC exactamente como quedaría en SAP (validada con zod) y guarda la trazabilidad de cada valor en out/<caso>/trazabilidad.json.",
  args: {
    caso: casoArg,
    paquete: objetoArg("data de oc_leer_paquete").optional(),
    derivados: objetoArg("data.derivados de oc_validar (informativo; se recalcula)").optional(),
  },
  async execute(args, ctx) {
    return guard(async () => {
      const { paquete, validacion, reglas } = await contexto(ctx.directory, args.caso)
      const difs = contradicciones(args.paquete, paquete)
      if (difs.length) return fail(`el paquete recibido no coincide con los archivos del caso (${difs.join(", ")})`)
      const ev = await evidenciaDelCaso(ctx.directory, args.caso, paquete)
      if (!validacion.apta || !ev) {
        return fail(`no se puede construir la OC: ${validacion.bloqueos.map((b) => `${b.codigo} ${b.detalle} → ${b.accion_sugerida}`).join(" | ") || "falta la aprobación"}`)
      }
      const { orden, traza } = construirOrden(paquete, validacion, ev.hash, reglas)
      OrdenCompraSchema.parse(orden)
      const salida = rutas(ctx.directory).out(args.caso)
      await writeJson(path.join(salida, "payload.json"), orden)
      await writeJson(path.join(salida, "trazabilidad.json"), { caso: args.caso, generado: ahora(), campos: traza })
      return ok({
        payload: orden,
        trazabilidad: traza,
        ruta_trazabilidad: rel(path.join(salida, "trazabilidad.json")),
        confirmaciones_pendientes: validacion.confirmaciones.map((c) => c.codigo),
        resumen: `OC ${orden.proveedor.nombre} · ${orden.posiciones[0]?.cantidad} × ${orden.moneda} ${orden.posiciones[0]?.precio_unitario.toLocaleString("es-CO")} · ${orden.posiciones[0]?.centro_costo}/${orden.posiciones[0]?.subarea} · IVA ${orden.posiciones[0]?.indicador_iva} · pago ${orden.condiciones_pago}`,
      })
    })
  },
})

async function escribirEvidencia(dir: string, caso: string, p: Paquete): Promise<{ ruta: string; ruta_pdf: string; sha256: string } | null> {
  const ev = await evidenciaDelCaso(dir, caso, p)
  if (!ev) return null
  const salida = rutas(dir).out(caso)
  const txt = path.join(salida, "aprobacion.txt")
  await writeText(txt, `${ev.contenido}\n---\nsha256 (del contenido anterior a esta línea): ${ev.hash}\n`)
  const lineas = ev.contenido.split("\n")
  const pdf = await crearPdf({
    titulo: `Evidencia de aprobación · ${p.solicitud.solicitud_id}`,
    subtitulos: lineas.slice(0, lineas.indexOf("")).filter(Boolean),
    lineas: [{ etiqueta: "Cuerpo del correo", valor: p.aprobacion?.texto ?? "" }],
    pie: [`sha256 del contenido: ${ev.hash}`, "Generado por el agente de órdenes de compra para sustentar la OC."],
  })
  const rutaPdf = path.join(salida, "aprobacion.pdf")
  await writeText(rutaPdf, pdf)
  return { ruta: rel(txt), ruta_pdf: rel(rutaPdf), sha256: ev.hash }
}

export const generar_evidencia = defineTool({
  description: "Genera la evidencia de aprobación en out/<caso>/aprobacion.txt y aprobacion.pdf con encabezados, cuerpo y sha256 del contenido.",
  args: { caso: casoArg },
  async execute(args, ctx) {
    return guard(async () => {
      const reglas = await cargarReglas(ctx.directory)
      const p = await leerPaquete(ctx.directory, args.caso, reglas)
      const r = await escribirEvidencia(ctx.directory, args.caso, p)
      if (!r) return fail("el paquete no trae correo de aprobación: no hay evidencia que generar")
      return ok({ ...r, resumen: `evidencia ${r.ruta} (sha256 ${r.sha256.slice(0, 12)}…)` })
    })
  },
})

const CONTROL_CABECERA = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

async function registrarControl(dir: string, fila: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] }): Promise<void> {
  const archivo = rutas(dir).control
  if (!(await exists(archivo))) await writeText(archivo, CONTROL_CABECERA)
  const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const linea = [fila.solicitud_id, fila.resultado, fila.numero_oc, String(fila.retroactiva), fila.bloqueos.join(";"), fila.confirmaciones.join(";"), ahora()].map(csv).join(",")
  await appendFile(archivo, linea + "\n")
}

export const crear = defineTool({
  description: "Crea la OC en el SAP simulado solo si es apta y, cuando hay confirmaciones, con confirmado=true; es idempotente por solicitud_id y registra cada intento en out/control.csv.",
  args: {
    caso: casoArg,
    payload: objetoArg("data.payload de oc_construir_payload, sin modificar").optional(),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async execute(args, ctx) {
    return guard(async () => {
      const dir = ctx.directory
      const { paquete, validacion, reglas, sap } = await contexto(dir, args.caso)
      const s = paquete.solicitud
      const bloqueos = validacion.bloqueos.map((b) => b.codigo)
      const confirmaciones = validacion.confirmaciones.map((c) => c.codigo)
      const base = { solicitud_id: s.solicitud_id, retroactiva: validacion.retroactiva, bloqueos, confirmaciones }

      const existente = await sap.buscarOrdenPorReferencia(s.solicitud_id)
      if (existente) {
        await registrarControl(dir, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, resumen: `ya existía la OC ${existente.numero_oc} para ${s.solicitud_id}: no se creó otra` })
      }
      if (!validacion.apta) {
        await registrarControl(dir, { ...base, resultado: "bloqueada", numero_oc: "" })
        return fail(`OC bloqueada: ${validacion.bloqueos.map((b) => `${b.codigo} ${b.detalle} → acción sugerida: ${b.accion_sugerida}`).join(" | ")}`)
      }
      if (confirmaciones.length && args.confirmado !== true) {
        await registrarControl(dir, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
        return fail(`requiere confirmación explícita de: ${validacion.confirmaciones.map((c) => `${c.codigo} ${c.detalle}`).join(" | ")}`)
      }
      const evidencia = await escribirEvidencia(dir, args.caso, paquete)
      if (!evidencia) return fail("no hay evidencia de aprobación")
      const { orden } = construirOrden(paquete, validacion, evidencia.sha256, reglas)
      const difs = diferenciasPayload(args.payload, orden)
      if (difs.length) {
        await registrarControl(dir, { ...base, resultado: "rechazada_payload_alterado", numero_oc: "" })
        return fail(`el payload enviado no coincide con el validado en: ${difs.join(", ")}. Usa exactamente la salida de oc_construir_payload.`)
      }
      if (args.confirmado) orden.excepciones = orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (chat, sesión ${ctx.sessionId})` }))
      OrdenCompraSchema.parse(orden)
      const r = await sap.crearOrden(orden)
      await writeJson(path.join(rutas(dir).out(args.caso), "payload.json"), orden)
      await registrarControl(dir, { ...base, resultado: "creada", numero_oc: r.numero_oc })
      return ok({
        numero_oc: r.numero_oc,
        fecha: r.fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        excepciones_confirmadas: confirmaciones,
        evidencia: evidencia.ruta,
        evidencia_pdf: evidencia.ruta_pdf,
        resumen: `OC ${r.numero_oc} creada para ${s.solicitud_id}${validacion.retroactiva ? " (retroactiva)" : ""}`,
      })
    })
  },
})
