// demo.ts — procesa los 6 casos de fixtures/reto-03/solicitudes/ llamando directamente a las herramientas, SIN modelo.
// Uso: bun install && bun run demo.ts        (FECHA_REFERENCIA=YYYY-MM-DD para cambiar la fecha de las OC)
import path from "node:path"
import { readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { registrarHerramientas } from "./src/core/registry"
import { runTool } from "./src/core/run"
import { listDirs, setRaiz } from "./src/core/util"
import { APP } from "./src/config"
import { verificarModulo } from "./scripts/modulo"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
setRaiz(ROOT)
process.env.FECHA_REFERENCIA ||= "2026-09-03"
const tools = new Map(registrarHerramientas(APP.herramientas).map((t) => [t.nombre, t.tool]))

type Data = Record<string, unknown>
async function llamar(nombre: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Data; error?: string }> {
  const tool = tools.get(nombre)
  if (!tool) throw new Error(`herramienta no registrada: ${nombre}`)
  const run = await runTool(nombre, tool, args, { directory: ROOT, sessionId: "demo" })
  return run.resultado.ok ? { ok: true, data: run.resultado.data as Data } : { ok: false, data: {}, error: run.resultado.error }
}
const linea = (s = "") => console.log(s)
const payloads = new Map<string, Data>()

async function procesar(caso: string): Promise<void> {
  linea(`\n━━━ ${caso} ${"━".repeat(56)}`)
  const paq = await llamar("oc_leer_paquete", { caso })
  if (!paq.ok) return linea(`  ✖ ${paq.error}`)
  linea(`  ${String(paq.data.resumen)}`)
  const val = await llamar("oc_validar", { caso, paquete: paq.data })
  if (!val.ok) return linea(`  ✖ ${val.error}`)
  const b = val.data.bloqueos as Data[]
  const c = val.data.confirmaciones as Data[]
  const d = val.data.derivados as Record<string, { valor: string; fuente: string }>
  linea(`  apta: ${val.data.apta ? "sí" : "NO"} · retroactiva: ${val.data.retroactiva ? "SÍ" : "no"}`)
  linea(`  bloqueos: ${b.length ? b.map((x) => `${String(x.codigo)} (${String(x.detalle)})`).join("; ") : "ninguno"}`)
  linea(`  confirmaciones: ${c.length ? c.map((x) => `${String(x.codigo)} (${String(x.detalle)})`).join("; ") : "ninguna"}`)
  if (Object.keys(d).length) linea(`  derivados: ${Object.entries(d).map(([k, v]) => `${k}=${v.valor} ← ${v.fuente}`).join("; ")}`)
  for (const a of val.data.advertencias as string[]) linea(`  ⚠ ${a}`)
  for (const x of b) linea(`  → acción sugerida: ${String(x.accion_sugerida)}`)

  let payload: Data | undefined
  if (val.data.apta) {
    const pay = await llamar("oc_construir_payload", { caso, paquete: paq.data, derivados: val.data.derivados })
    if (!pay.ok) return linea(`  ✖ payload: ${pay.error}`)
    payload = pay.data.payload as Data
    payloads.set(caso, payload)
    linea(`  payload: ${String(pay.data.resumen)} · trazabilidad: ${String(pay.data.ruta_trazabilidad)}`)
    const ev = await llamar("oc_generar_evidencia", { caso })
    linea(`  evidencia: ${ev.ok ? `${String(ev.data.ruta)} + ${String(ev.data.ruta_pdf)} · sha256 ${String(ev.data.sha256).slice(0, 16)}…` : ev.error}`)
  }
  const oc = await llamar("oc_crear", { caso, ...(payload ? { payload } : {}) })
  linea(`  resultado: ${oc.ok ? `OC ${String(oc.data.numero_oc)}${oc.data.idempotente ? " (idempotente)" : ""}` : `sin OC → ${oc.error}`}`)
}

async function main(): Promise<void> {
  await rm(path.join(ROOT, "out"), { recursive: true, force: true })
  linea(`Demo Reto 03 · Órdenes de compra SAP · fecha de referencia ${process.env.FECHA_REFERENCIA} · sin modelo de lenguaje`)
  for (const caso of await listDirs(path.join(ROOT, "fixtures/reto-03/solicitudes"))) await procesar(caso)

  linea("\n━━━ Idempotencia: sol-001 por segunda vez ━━━")
  const otra = await llamar("oc_crear", { caso: "sol-001", payload: payloads.get("sol-001") })
  linea(`  → OC ${String(otra.data.numero_oc)} · idempotente: ${String(otra.data.idempotente)} (no se creó una segunda OC)`)

  linea("\n━━━ Confirmación explícita del usuario ━━━")
  for (const caso of ["sol-004", "sol-005"]) {
    const oc = await llamar("oc_crear", { caso, payload: payloads.get(caso), confirmado: true })
    linea(`  ${caso} con confirmado=true → ${oc.ok ? `OC ${String(oc.data.numero_oc)}${oc.data.retroactiva ? " · retroactiva=true" : ""} · excepciones confirmadas: ${(oc.data.excepciones_confirmadas as string[]).join(", ")}` : oc.error}`)
  }
  linea("  sol-006 queda pendiente: requiere confirmar el IVA derivado (RC6).")

  linea("\n━━━ Errores controlados ━━━")
  const alterado = await llamar("oc_crear", { caso: "sol-006", payload: { ...payloads.get("sol-006"), condiciones_pago: "Z000" }, confirmado: true })
  linea(`  payload alterado por el modelo → ok=${alterado.ok}: ${alterado.error}`)
  const inexistente = await llamar("oc_leer_paquete", { caso: "sol-999" })
  linea(`  caso inexistente → ok=${inexistente.ok}: ${inexistente.error}`)

  linea("\n━━━ out/control.csv ━━━")
  linea((await readFile(path.join(ROOT, "out/control.csv"), "utf8")).trim().split("\n").map((l) => `  ${l}`).join("\n"))
  const mod = await verificarModulo(ROOT)
  linea(`\nMódulo reutilizable (modulo/) sincronizado con la app: ${mod.ok ? "sí" : `NO → ${mod.diferencias.join(", ")} (ejecuta bun run modulo)`}`)
  linea("Salidas: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{payload,trazabilidad,validacion}.json · out/<caso>/aprobacion.{txt,pdf} · out/log.jsonl\n")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e instanceof Error ? e.message : e)
  process.exitCode = 1
})
