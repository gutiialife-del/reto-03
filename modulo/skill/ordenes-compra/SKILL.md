---
name: ordenes-compra
description: "Conocimiento del proceso de órdenes de compra de Periferia: controles RC1–RC10, payload SAP, evidencia de aprobación, idempotencia y OC retroactivas."
---

<!-- Generado desde src/knowledge/ por scripts/modulo.ts. No editar a mano. -->

# Proceso: órdenes de compra en SAP

## Contexto
- Cada compra llega por correo con tres piezas: Excel de solicitud, cotización del proveedor y correo de aprobación del líder.
- La analista digitaba en SAP: proveedor, descripción, centro de costos y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjuntaba la aprobación en PDF.
- Hallazgo: muchas OC se crean **después** de la factura (OC retroactivas). La dirección quiere medirlo.
- Los maestros viven en `fixtures/reto-03/maestros/` (en producción se consultan en SAP). SAP está simulado en `out/sap/`.

## Matriz de controles
| Regla | Control | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | La aprobación existe, contiene "Aprobado" y viene de un aprobador del centro de costo. | Bloqueo |
| RC3 | `valor_total` ≤ tope del aprobador para ese centro. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | Diferencia cotización vs. solicitud ≤ 2 %; si excede, o no hay cotización: confirmación con ambos valores. | Confirmación |
| RC6 | Sin indicador de IVA → se deriva del proveedor y se pide confirmación. | Confirmación + derivado |
| RC7 | Sin condiciones de pago → se derivan del proveedor; solo se informa. | Derivado |
| RC8 | Factura con fecha anterior a la solicitud → `retroactiva = true`, confirmación y registro en control. | Confirmación |
| RC9 | La aprobación no puede ser anterior a la solicitud; si lo es: confirmación. | Confirmación |
| RC10 | `cantidad × valor_unitario = valor_total` (± 1). Si no: bloqueo. | Bloqueo |

- **Bloqueos** impiden crear la OC. **Confirmaciones** la permiten solo con `confirmado = true`. **Derivados** son valores que el agente completó desde maestros y debe informar.
- Si el aprobador no tiene autoridad, se sugiere a quién reenviar (aprobadores del centro con tope suficiente) o escalar si nadie tiene tope.

## Payload de la OC
- Sociedad y organización de compras: `1000`.
- Una posición (número 10) con descripción de máximo 40 caracteres (texto breve SAP), cantidad, unidad (`H` si la descripción habla de horas, `MES` si es mensual, si no `UN`), precio unitario, centro de costo, subárea e indicador de IVA.
- La OC se crea con los valores **de la solicitud** (lo aprobado), no de la cotización.
- Cada valor tiene fuente: `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado` (en `out/<caso>/trazabilidad.json`).
- `aprobador.evidencia_sha256` es el sha256 del contenido de `out/<caso>/aprobacion.txt`.

## Creación en SAP
- Solo si `apta = true` y (sin confirmaciones o `confirmado = true`).
- Numeración desde `4500000001`. Crear dos veces la misma `solicitud_id` devuelve el número existente (idempotencia).
- Cada intento (creada, bloqueada, pendiente, idempotente) agrega una fila a `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`.

## Qué pedir al solicitante según el problema
- Proveedor inexistente o inactivo → alta del proveedor en SAP (RUT, certificación bancaria) o usar uno registrado.
- Aprobador sin autoridad → reenviar a un aprobador del centro con tope suficiente.
- Diferencia con la cotización → ajustar la solicitud y la aprobación, o confirmar crear por el valor aprobado.
- Error aritmético o JSON inválido → corregir el Excel de solicitud.
