// Lógica de órdenes de compra: lectura del paquete, controles RC1–RC10, payload y evidencia.
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod/v4"
import { ToolError } from "../core/tool"
import { esFechaISO, exists, listDirs, normalizar, readJson, readText, safeId } from "../core/util"
import type { OrdenCompra, SapAdapter } from "../sap/adapter"

export type Reglas = {
  sociedad: "1000"
  organizacion_compras: "1000"
  monedas: string[]
  tolerancia_cotizacion_pct: number
  tolerancia_valor_total: number
  max_descripcion: number
  numero_oc_inicial: number
  palabra_aprobacion: string
  unidades: Record<string, string[]>
  unidad_por_defecto: string
}

const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser un número" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario debe ser un número" }).nonnegative(),
  valor_total: z.number({ error: "valor_total debe ser un número" }).positive(),
  moneda: z.string(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().refine(esFechaISO, "fecha_solicitud debe ser YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: { referencia: string | null; proveedor: string; nit: string | null; total: number; moneda: string; validez_hasta: string | null; texto: string } | null
  aprobacion: { de: string; para: string; fecha: string; asunto: string; aprobado: boolean; texto: string } | null
  factura: { numero: string; fecha: string; total: number } | null
  faltantes: string[]
}

type Proveedor = { codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean }
type CentroCosto = { centro_costo: string; nombre: string; subareas: string[]; aprobadores: Array<{ email: string; nombre: string; tope: number }> }
type Codigo = { codigo: string; descripcion: string }

export const rutas = (dir: string) => {
  const base = path.join(dir, "fixtures", "reto-03")
  return {
    solicitudes: path.join(base, "solicitudes"),
    caso: (c: string) => path.join(base, "solicitudes", c),
    proveedores: path.join(base, "maestros", "proveedores.json"),
    centros: path.join(base, "maestros", "centros-costo.json"),
    iva: path.join(base, "maestros", "indicadores-iva.json"),
    pagos: path.join(base, "maestros", "condiciones-pago.json"),
    reglas: path.join(dir, "src", "knowledge", "reglas-oc.json"),
    out: (c: string) => path.join(dir, "out", c),
    control: path.join(dir, "out", "control.csv"),
  }
}

export async function cargarReglas(dir: string): Promise<Reglas> {
  return readJson<Reglas>(rutas(dir).reglas, "las reglas de control")
}

const fecha10 = (s: string): string => s.slice(0, 10)

/** "COP 11.400.000" → 11400000 (formato colombiano: punto de miles, coma decimal). */
export function parseMontoCo(s: string): number | null {
  const t = s.trim()
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."))
  if (/^\d+$/.test(t)) return Number(t)
  return null
}

const sinDv = (nit: string): string => nit.replace(/-\d$/, "").replace(/[.\s-]/g, "")

function parseCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const proveedor = texto.match(/Proveedor:\s*(.+)/)?.[1]?.trim() ?? ""
  const nit = texto.match(/^NIT:\s*([\d.\-]+)/m)?.[1]
  const total = texto.match(/TOTAL[^:\n]*:\s*(COP|USD)\s*([\d.,]+)/)
  if (!total) throw new ToolError("la cotización no tiene un TOTAL legible (se espera 'TOTAL ...: COP 1.234.567')")
  const monto = parseMontoCo(total[2] ?? "")
  if (monto === null) throw new ToolError(`el total de la cotización no es numérico: "${total[2]}"`)
  const fecha = texto.match(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null
  const dias = Number(texto.match(/Validez de la oferta:\s*(\d+)\s*d[ií]as/i)?.[1] ?? "NaN")
  let validez: string | null = null
  if (fecha && Number.isFinite(dias)) {
    const d = new Date(`${fecha}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + dias)
    validez = d.toISOString().slice(0, 10)
  }
  return {
    referencia: texto.match(/COTIZACI[OÓ]N\s+([A-Z0-9-]+)/)?.[1] ?? null,
    proveedor,
    nit: nit ? sinDv(nit) : null,
    total: monto,
    moneda: total[1] ?? "",
    validez_hasta: validez,
    texto,
  }
}

function parseFactura(texto: string): NonNullable<Paquete["factura"]> {
  const numero = texto.match(/No\.\s*([A-Z0-9-]+)/)?.[1] ?? ""
  const fecha = texto.match(/Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/)?.[1]
  const total = texto.match(/^TOTAL:\s*(?:COP|USD)\s*([\d.,]+)/m)?.[1]
  if (!fecha) throw new ToolError("la factura no tiene fecha de emisión legible")
  const monto = total ? parseMontoCo(total) : null
  if (monto === null) throw new ToolError("la factura no tiene un TOTAL numérico legible")
  return { numero, fecha, total: monto }
}

async function jsonOpcional<T>(archivo: string, etiqueta: string): Promise<T | null> {
  if (!(await exists(archivo))) return null
  return readJson<T>(archivo, etiqueta)
}

export async function leerPaquete(dir: string, caso: string, reglas: Reglas): Promise<Paquete> {
  safeId(caso, "caso")
  const carpeta = rutas(dir).caso(caso)
  if (!(await exists(carpeta))) {
    const disponibles = await listDirs(rutas(dir).solicitudes)
    throw new ToolError(`el caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ")}`)
  }
  const faltantes: string[] = []
  const correo = await jsonOpcional<Paquete["correo"]>(path.join(carpeta, "correo.json"), "correo.json")
  if (!correo) faltantes.push("correo")
  const solicitudRaw = await jsonOpcional<unknown>(path.join(carpeta, "solicitud.json"), "solicitud.json (Excel de solicitud)")
  if (!solicitudRaw) throw new ToolError("el paquete no trae la solicitud (solicitud.xlsx / solicitud.json): pídela al solicitante")
  const parsed = SolicitudSchema.safeParse(solicitudRaw)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new ToolError(`la solicitud tiene datos inválidos (${detalle}). Pide al solicitante que corrija el Excel.`)
  }
  const cotTexto = await readText(path.join(carpeta, "cotizacion.txt"))
  if (cotTexto === null) faltantes.push("cotizacion")
  const ap = await jsonOpcional<{ de: string; para: string; fecha: string; asunto: string; cuerpo: string }>(path.join(carpeta, "aprobacion.json"), "aprobacion.json")
  if (!ap) faltantes.push("aprobacion")
  const facTexto = await readText(path.join(carpeta, "factura.txt"))
  const palabra = new RegExp(`\\b${reglas.palabra_aprobacion}\\b`, "i")
  const negacion = new RegExp(`\\bno\\s+(est[aá]\\s+)?${reglas.palabra_aprobacion}`, "i")
  return {
    correo: correo ? { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha } : { id: "", de: "", asunto: "", fecha: "" },
    solicitud: parsed.data,
    cotizacion: cotTexto === null ? null : parseCotizacion(cotTexto),
    aprobacion: ap
      ? { de: ap.de, para: ap.para, fecha: fecha10(ap.fecha), asunto: ap.asunto, aprobado: palabra.test(ap.cuerpo) && !negacion.test(ap.cuerpo), texto: ap.cuerpo }
      : null,
    factura: facTexto === null ? null : parseFactura(facTexto),
    faltantes,
  }
}

export type Hallazgo = { codigo: string; detalle: string; accion_sugerida: string }
export type Control = { regla: string; resultado: "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"; detalle: string }
export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: { indicador_iva?: { valor: string; fuente: string }; condiciones_pago?: { valor: string; fuente: string } }
  retroactiva: boolean
  controles: Control[]
  advertencias: string[]
  proveedor: Proveedor | null
}

const pesos = (n: number): string => n.toLocaleString("es-CO", { maximumFractionDigits: 2 })
const sinSufijo = (s: string): string => normalizar(s.replace(/\s*(S\.?\s?A\.?\s?S\.?|S\.?\s?A\.?|LTDA\.?)\s*$/i, ""))

export async function validarPaquete(dir: string, p: Paquete, sap: SapAdapter, reglas: Reglas): Promise<Validacion> {
  const r = rutas(dir)
  const proveedores = await readJson<Proveedor[]>(r.proveedores, "el maestro de proveedores")
  const centros = await readJson<CentroCosto[]>(r.centros, "el maestro de centros de costo")
  const ivas = await readJson<Codigo[]>(r.iva, "el maestro de indicadores de IVA")
  const pagos = await readJson<Codigo[]>(r.pagos, "el maestro de condiciones de pago")
  const s = p.solicitud
  const v: Validacion = { apta: false, bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false, controles: [], advertencias: [], proveedor: null }
  const bloqueo = (codigo: string, detalle: string, accion: string) => {
    v.bloqueos.push({ codigo, detalle, accion_sugerida: accion })
    v.controles.push({ regla: codigo, resultado: "bloqueo", detalle })
  }
  const confirmar = (codigo: string, detalle: string, accion: string) => {
    v.confirmaciones.push({ codigo, detalle, accion_sugerida: accion })
    v.controles.push({ regla: codigo, resultado: "confirmacion", detalle })
  }
  const okc = (regla: string, detalle: string) => v.controles.push({ regla, resultado: "ok", detalle })

  // RC1 · proveedor existe y está activo (por NIT vía SAP; sin NIT, por nombre normalizado).
  let prov: Proveedor | undefined
  if (s.proveedor_nit) {
    const enSap = await sap.consultarProveedor(sinDv(s.proveedor_nit))
    prov = enSap ? proveedores.find((x) => x.codigo_sap === enSap.codigo_sap) : undefined
  } else {
    prov = proveedores.find((x) => sinSufijo(x.nombre) === sinSufijo(s.proveedor_nombre))
    if (prov) v.advertencias.push(`la solicitud no trae NIT: el proveedor se identificó por nombre (${prov.nombre}, NIT ${prov.nit})`)
  }
  if (!prov) {
    bloqueo("RC1", `el proveedor "${s.proveedor_nombre}"${s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""} no existe en el maestro de proveedores`, "solicitar el alta del proveedor en SAP (RUT y certificación bancaria) o cambiar a un proveedor registrado")
  } else if (!prov.activo) {
    bloqueo("RC1", `el proveedor ${prov.nombre} (${prov.codigo_sap}) está inactivo`, "pedir a compras reactivar el proveedor o elegir otro")
  } else {
    v.proveedor = prov
    okc("RC1", `${prov.nombre} · código SAP ${prov.codigo_sap} · activo`)
    if (p.cotizacion?.nit && p.cotizacion.nit !== prov.nit) v.advertencias.push(`el NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor (${prov.nit})`)
  }

  // RC2 / RC3 · aprobación válida, de un aprobador del centro, dentro de su tope.
  const centro = centros.find((c) => c.centro_costo === s.centro_costo)
  const topeMax = centro ? Math.max(...centro.aprobadores.map((a) => a.tope)) : 0
  const autorizados = centro ? centro.aprobadores.filter((a) => a.tope >= s.valor_total).map((a) => `${a.nombre} <${a.email}> (tope ${pesos(a.tope)})`) : []
  const sugerencia = autorizados.length ? `reenviar la solicitud a un aprobador autorizado de ${s.centro_costo}: ${autorizados.join(", ")}` : `ningún aprobador de ${s.centro_costo} tiene tope para ${pesos(s.valor_total)} (máximo ${pesos(topeMax)}): escalar a la dirección financiera`
  if (!p.aprobacion) {
    bloqueo("RC2", "el paquete no trae el correo de aprobación", `pedir al solicitante el correo de aprobación; ${sugerencia}`)
  } else if (!p.aprobacion.aprobado) {
    bloqueo("RC2", `el correo de ${p.aprobacion.de} no contiene "Aprobado"`, "pedir una aprobación explícita")
  } else {
    const aprobador = centro?.aprobadores.find((a) => a.email.toLowerCase() === p.aprobacion?.de.toLowerCase())
    if (!centro) bloqueo("RC2", `el centro de costo ${s.centro_costo} no existe`, "corregir el centro de costo en la solicitud")
    else if (!aprobador) {
      bloqueo("RC2", `${p.aprobacion.de} no es aprobador del centro ${s.centro_costo} (${centro.nombre})`, sugerencia)
      v.controles.push({ regla: "RC3", resultado: "bloqueo", detalle: `sin tope evaluable: ${p.aprobacion.de} no tiene tope en ${s.centro_costo}` })
      v.bloqueos.push({ codigo: "RC3", detalle: `${p.aprobacion.de} no tiene tope en ${s.centro_costo}; el tope máximo del centro es ${pesos(topeMax)} y la solicitud es por ${pesos(s.valor_total)}`, accion_sugerida: sugerencia })
    } else {
      okc("RC2", `aprobado por ${aprobador.nombre} <${aprobador.email}>, aprobador de ${s.centro_costo}`)
      if (s.valor_total > aprobador.tope) bloqueo("RC3", `el valor ${pesos(s.valor_total)} supera el tope de ${aprobador.nombre} (${pesos(aprobador.tope)})`, sugerencia)
      else okc("RC3", `${pesos(s.valor_total)} ≤ tope ${pesos(aprobador.tope)}`)
    }
  }

  // RC4 · la subárea pertenece al centro de costo.
  if (!centro) bloqueo("RC4", `el centro de costo ${s.centro_costo} no existe`, "corregir el centro de costo")
  else if (!centro.subareas.includes(s.subarea)) bloqueo("RC4", `la subárea "${s.subarea}" no pertenece a ${s.centro_costo} (${centro.subareas.join(", ")})`, "corregir la subárea en la solicitud")
  else okc("RC4", `${s.subarea} ∈ ${s.centro_costo}`)

  // RC5 · cotización vs solicitud (±2 %).
  if (!p.cotizacion) confirmar("RC5", "el paquete no trae cotización", "confirmar que se crea sin cotización o pedirla al proveedor")
  else {
    const dif = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    const pct = Math.round(dif * 10000) / 100
    if (dif > reglas.tolerancia_cotizacion_pct) {
      confirmar("RC5", `la cotización (${p.cotizacion.moneda} ${pesos(p.cotizacion.total)}) difiere ${pct} % de la solicitud (${s.moneda} ${pesos(s.valor_total)}); tolerancia ${reglas.tolerancia_cotizacion_pct * 100} %`, "confirmar crear la OC por el valor de la solicitud (lo aprobado) o pedir al solicitante que ajuste la solicitud y la aprobación")
    } else okc("RC5", `cotización ${pesos(p.cotizacion.total)} vs solicitud ${pesos(s.valor_total)} (${pct} %)`)
    if (p.cotizacion.validez_hasta && p.cotizacion.validez_hasta < s.fecha_solicitud) v.advertencias.push(`la cotización venció el ${p.cotizacion.validez_hasta}, antes de la solicitud`)
  }

  // RC6 · indicador de IVA (derivado del proveedor si falta → confirmación).
  if (!s.indicador_iva) {
    if (prov) {
      v.derivados.indicador_iva = { valor: prov.indicador_iva_default, fuente: `maestro.proveedores.indicador_iva_default (${prov.codigo_sap})` }
      confirmar("RC6", `la solicitud no informa indicador de IVA; se propone ${prov.indicador_iva_default} (${ivas.find((i) => i.codigo === prov?.indicador_iva_default)?.descripcion ?? "?"}) del maestro del proveedor`, "confirmar el indicador de IVA propuesto")
    } else v.controles.push({ regla: "RC6", resultado: "no_aplica", detalle: "sin proveedor válido para derivar el IVA" })
  } else if (!ivas.some((i) => i.codigo === s.indicador_iva)) bloqueo("RC6", `el indicador de IVA ${s.indicador_iva} no existe`, "corregir el indicador de IVA")
  else okc("RC6", `${s.indicador_iva} informado en la solicitud`)

  // RC7 · condiciones de pago (derivadas del proveedor si faltan, solo se informa).
  if (!s.condiciones_pago) {
    if (prov) {
      v.derivados.condiciones_pago = { valor: prov.condiciones_pago_default, fuente: `maestro.proveedores.condiciones_pago_default (${prov.codigo_sap})` }
      v.controles.push({ regla: "RC7", resultado: "derivado", detalle: `${prov.condiciones_pago_default} (${pagos.find((x) => x.codigo === prov?.condiciones_pago_default)?.descripcion ?? "?"}) desde el maestro del proveedor` })
    } else v.controles.push({ regla: "RC7", resultado: "no_aplica", detalle: "sin proveedor válido para derivar condiciones de pago" })
  } else if (!pagos.some((x) => x.codigo === s.condiciones_pago)) bloqueo("RC7", `la condición de pago ${s.condiciones_pago} no existe`, "corregir la condición de pago")
  else okc("RC7", `${s.condiciones_pago} informado en la solicitud`)

  // RC8 · factura anterior a la solicitud → OC retroactiva.
  if (p.factura && p.factura.fecha < s.fecha_solicitud) {
    v.retroactiva = true
    confirmar("RC8", `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud})`, "confirmar la creación; quedará marcada retroactiva = true en el log de control")
  } else okc("RC8", p.factura ? `factura ${p.factura.numero} posterior a la solicitud` : "sin factura en el paquete")

  // RC9 · la aprobación no puede ser anterior a la solicitud.
  if (p.aprobacion) {
    if (p.aprobacion.fecha < s.fecha_solicitud) confirmar("RC9", `la aprobación (${p.aprobacion.fecha}) es anterior a la solicitud (${s.fecha_solicitud})`, "confirmar que la aprobación corresponde a esta solicitud")
    else okc("RC9", `aprobación ${p.aprobacion.fecha} ≥ solicitud ${s.fecha_solicitud}`)
  }

  // RC10 · cantidad × valor unitario = valor total (± 1).
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > reglas.tolerancia_valor_total) {
    bloqueo("RC10", `cantidad × valor unitario = ${pesos(calculado)} ≠ valor total ${pesos(s.valor_total)}`, "pedir al solicitante corregir cantidades o valores en el Excel")
  } else okc("RC10", `${s.cantidad} × ${pesos(s.valor_unitario)} = ${pesos(s.valor_total)}`)

  if (!reglas.monedas.includes(s.moneda)) bloqueo("MONEDA", `moneda ${s.moneda} no soportada por la OC (${reglas.monedas.join(", ")})`, "corregir la moneda")
  if (p.faltantes.length) v.advertencias.push(`adjuntos ausentes: ${p.faltantes.join(", ")}`)
  v.apta = v.bloqueos.length === 0
  v.controles.sort((a, b) => Number(a.regla.replace(/\D/g, "") || 99) - Number(b.regla.replace(/\D/g, "") || 99))
  return v
}

/** Texto canónico de la evidencia de aprobación; el sha256 se calcula sobre este contenido exacto. */
export function textoAprobacion(ap: NonNullable<Paquete["aprobacion"]>, original: { cc?: string[]; fecha: string }): string {
  return [`De: ${ap.de}`, `Para: ${ap.para}`, ...(original.cc?.length ? [`CC: ${original.cc.join(", ")}`] : []), `Fecha: ${original.fecha}`, `Asunto: ${ap.asunto}`, "", ap.texto, ""].join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

export async function evidenciaDelCaso(dir: string, caso: string, p: Paquete): Promise<{ contenido: string; hash: string } | null> {
  if (!p.aprobacion) return null
  const original = await readJson<{ cc?: string[]; fecha: string }>(path.join(rutas(dir).caso(caso), "aprobacion.json"), "aprobacion.json")
  const contenido = textoAprobacion(p.aprobacion, original)
  return { contenido, hash: sha256(contenido) }
}

export type Traza = Record<string, string>

export function unidadDe(descripcion: string, reglas: Reglas): { unidad: "UN" | "H" | "MES"; regla: string } {
  const d = normalizar(descripcion)
  for (const [unidad, palabras] of Object.entries(reglas.unidades)) {
    const hit = palabras.find((w) => new RegExp(`\\b${normalizar(w)}\\b`).test(d))
    if (hit && (unidad === "H" || unidad === "MES")) return { unidad, regla: `derivado: la descripción contiene "${hit}"` }
  }
  return { unidad: "UN", regla: "derivado: unidad por defecto (UN)" }
}

export function construirOrden(p: Paquete, v: Validacion, hash: string, reglas: Reglas): { orden: OrdenCompra; traza: Traza } {
  const s = p.solicitud
  const prov = v.proveedor
  if (!v.apta || !prov) throw new ToolError(`no se puede construir la OC: hay bloqueos (${v.bloqueos.map((b) => b.codigo).join(", ")})`)
  if (!p.aprobacion) throw new ToolError("no se puede construir la OC sin aprobación")
  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor
  if (!iva || !pago) throw new ToolError("faltan indicador de IVA o condiciones de pago y no se pudieron derivar")
  const desc = s.descripcion.length > reglas.max_descripcion ? s.descripcion.slice(0, reglas.max_descripcion).trimEnd() : s.descripcion
  const unidad = unidadDe(s.descripcion, reglas)
  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: reglas.sociedad,
    organizacion_compras: reglas.organizacion_compras,
    proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
    moneda: s.moneda as "COP" | "USD",
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: hash },
    posiciones: [
      {
        numero: 10,
        descripcion: desc,
        cantidad: s.cantidad,
        unidad: unidad.unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }
  const traza: Traza = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": p.cotizacion ? "cotizacion (encabezado COTIZACIÓN)" : "derivado: sin cotización",
    sociedad: "derivado: constante de reglas-oc.json",
    organizacion_compras: "derivado: constante de reglas-oc.json",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: s.condiciones_pago ? "solicitud.condiciones_pago" : `derivado: ${v.derivados.condiciones_pago?.fuente ?? ""}`,
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado: sha256 de out/<caso>/aprobacion.txt",
    "posiciones[0].numero": "derivado: primera posición (10)",
    "posiciones[0].descripcion": desc === s.descripcion ? "solicitud.descripcion" : `derivado: solicitud.descripcion truncada a ${reglas.max_descripcion} caracteres`,
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": unidad.regla,
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : `derivado: ${v.derivados.indicador_iva?.fuente ?? ""}`,
    excepciones: "derivado: confirmaciones de oc_validar",
  }
  return { orden, traza }
}

/** Compara el payload que envía el modelo con el construido por la herramienta (el modelo no puede alterar montos). */
export function diferenciasPayload(propuesto: unknown, real: OrdenCompra): string[] {
  const difs: string[] = []
  const comparar = (ruta: string, a: unknown, b: unknown) => {
    if (a === undefined) return
    if (JSON.stringify(a) !== JSON.stringify(b)) difs.push(ruta)
  }
  const p = (propuesto ?? {}) as Partial<OrdenCompra>
  comparar("proveedor.codigo_sap", p.proveedor?.codigo_sap, real.proveedor.codigo_sap)
  comparar("moneda", p.moneda, real.moneda)
  comparar("condiciones_pago", p.condiciones_pago, real.condiciones_pago)
  comparar("aprobador.email", p.aprobador?.email, real.aprobador.email)
  const pos = p.posiciones?.[0]
  const rpos = real.posiciones[0]
  if (pos && rpos) {
    comparar("posiciones[0].cantidad", pos.cantidad, rpos.cantidad)
    comparar("posiciones[0].precio_unitario", pos.precio_unitario, rpos.precio_unitario)
    comparar("posiciones[0].centro_costo", pos.centro_costo, rpos.centro_costo)
    comparar("posiciones[0].subarea", pos.subarea, rpos.subarea)
    comparar("posiciones[0].indicador_iva", pos.indicador_iva, rpos.indicador_iva)
  }
  if (p.posiciones && p.posiciones.length !== real.posiciones.length) difs.push("posiciones (cantidad de líneas)")
  return difs
}
