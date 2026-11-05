// SAP simulado sobre archivos: out/sap/ordenes.jsonl. Numeración secuencial desde 4500000001.
import path from "node:path"
import { appendLine, fechaReferencia, readJson, readText } from "../core/util"
import type { OrdenCompra, SapAdapter } from "./adapter"

type Proveedor = { codigo_sap: string; nit: string; activo: boolean }
type Registro = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private readonly archivo: string
  private readonly maestroProveedores: string

  constructor(
    dir: string,
    private readonly inicial = 4500000001,
  ) {
    this.archivo = path.join(dir, "out", "sap", "ordenes.jsonl")
    this.maestroProveedores = path.join(dir, "fixtures", "reto-03", "maestros", "proveedores.json")
  }

  private async ordenes(): Promise<Registro[]> {
    const texto = (await readText(this.archivo)) ?? ""
    return texto.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const lista = await readJson<Proveedor[]>(this.maestroProveedores, "el maestro de proveedores")
    const p = lista.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const o = (await this.ordenes()).find((r) => r.solicitud_id === solicitud_id)
    return o ? { numero_oc: o.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.ordenes()
    const ultimo = existentes.reduce((max, r) => Math.max(max, Number(r.numero_oc)), this.inicial - 1)
    const numero_oc = String(ultimo + 1)
    const fecha = fechaReferencia()
    await appendLine(this.archivo, { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden } satisfies Registro)
    return { numero_oc, fecha }
  }
}
