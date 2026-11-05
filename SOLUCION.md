# SOLUCIÓN — Reto 03 · Agente «Órdenes de Compra SAP»

## 1. Problema en una frase

Cada compra obliga a la **analista administrativa** a digitar a mano en SAP proveedor, centro de costo, valores, IVA, aprobador y condiciones de pago, validando de memoria si quien aprobó podía aprobar; le duele a ella (tiempo y errores que se corrigen en el cierre) y a **contabilidad/auditoría y la dirección**, que no tienen control sistemático ni saben cuántas OC se crean después de la factura.

## 2. Arquitectura

```
web/  (chat HTML + JS)  ── HTTP JSON ──▶  src/server.ts  (node:http: /api/chat, /api/sessions/:id, /api/health, /out/*)
  · historial                               └─ src/agent/loop.ts   ciclo · topes · compuerta de confirmación
  · cada llamada a herramienta                   ├─ system prompt = agent/prompt.md + src/knowledge/*.md
  · confirmación resaltada (⚠)                   ├─ src/llm/adapter.ts ──▶ anthropic.ts | openai.ts | simulado.ts
                                                 └─ src/core/run.ts (zod + log) ──▶ src/tools/oc.ts ──▶ src/lib/* + src/sap/mock.ts
                                                                                         │                  │
                                                                              fixtures/ (solo lectura)   out/ (escritura)
sesiones: memoria + out/sessions/<id>.json · registro: out/log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, reglas inquebrantables, flujo estándar y formato de respuesta. |
| **Conocimiento** | `src/knowledge/*.md` y `src/knowledge/reglas-*.json` | El proceso de negocio en Markdown (se inyecta al system prompt) y los parámetros que leen las herramientas (umbrales, tablas por país, tolerancias). Cambiar una regla no toca el servidor. |
| **Ejecución** | `src/tools/oc.ts` (+ `src/lib/`) | Herramientas tipadas con `zod`, separadas del servidor e importables desde `demo.ts` y `modulo/`. |
| **Orquestación** | `src/agent/loop.ts` | Ciclo, topes, compuerta de confirmación, registro. No conoce el negocio. |
| **Proveedor** | `src/llm/` | Interfaz propia `LlmAdapter.enviar(mensajes, herramientas, opciones)` y una implementación por proveedor. |
| **Front** | `web/` | Chat sin dependencias: muestra cada herramienta (nombre, argumentos, resultado), resalta la confirmación pendiente y enlaza los archivos de `out/`. |

`src/sap/adapter.ts` define la interfaz obligatoria `SapAdapter` y el esquema `zod` de la `OrdenCompra`; `src/sap/mock.ts` la implementa sobre `out/sap/ordenes.jsonl`. Las herramientas solo conocen la interfaz: cambiar el simulador por SAP real no toca `src/tools/oc.ts`.

## 3. Ciclo del agente

Implementado en `src/agent/loop.ts` (`ejecutarTurno`):

1. Se agrega el mensaje del usuario al historial y se llama al modelo con el system prompt (prompt + conocimiento + fecha) y el esquema JSON de cada herramienta (generado desde `zod` con `z.toJSONSchema`).
2. Si el modelo pide herramientas, cada llamada pasa por `runTool` (`src/core/run.ts`): valida los argumentos con `zod` (si no cumplen, el error vuelve al modelo como `{ ok:false }`), ejecuta la herramienta dentro de `try/catch` y escribe `{ ts, sesion, herramienta, ok, resumen }` en `out/log.jsonl` (CA4). El resultado vuelve al modelo y se repite.
3. El turno termina cuando el modelo responde sin pedir herramientas.

**Topes (CA1 y costo).** `MAX_ITERACIONES` (25 por defecto) limita las vueltas modelo → herramientas por turno; si se alcanza, el agente responde con lo que tiene (últimas llamadas y su resultado) y lo que falta, sin otra llamada al modelo. `MAX_TOKENS_SESION` corta la sesión al superar el presupuesto, `MAX_TOKENS_RESPUESTA` limita cada respuesta y `LLM_TIMEOUT_MS` aborta una llamada colgada. `ACCESS_KEY` evita que un tercero gaste la clave desde el link público.

**Confirmación humana (CA3 / regla de "confirmación en el turno inmediatamente anterior").** No depende de que el modelo se porte bien; la hace cumplir el servidor:

- Para pedir confirmación, el agente llama `agente_solicitar_confirmacion({ accion, detalle })` y termina el turno con la pregunta. También queda pendiente, sin depender del modelo, cuando una herramienta lo declara en su resultado (`pendiente_confirmacion`: campos en revisión, OC con excepciones, paquete listo para enviar) o responde `requiere confirmación` / `requiere revisión`. La sesión guarda esa marca y el front pinta el mensaje en amarillo con botones **Confirmo / No confirmo**.
- En el turno siguiente, el servidor clasifica el mensaje del usuario (`esAfirmativo` / `esNegativo`). Solo si había una marca pendiente **y** el mensaje es afirmativo, ese turno queda habilitado para llamadas con `confirmado: true`; el modelo recibe una nota explícita indicando qué se confirmó.
- Cualquier llamada con `confirmado: true` en un turno no habilitado se bloquea **antes** de ejecutar la herramienta y vuelve al modelo como error. Una pregunta escrita sin la marca formal se resalta en el front, pero no habilita nada.

**Errores (CA5).** Un error de herramienta llega al modelo como `{ ok:false, error }` legible; un error del proveedor (clave inválida, 429, timeout) se traduce a un mensaje claro en el chat y la sesión sigue viva (se reintenta una vez ante 429/5xx).

En este reto la acción con confirmación es `oc_crear`: si `oc_validar` devolvió confirmaciones (RC5, RC6, RC8, RC9), sin `confirmado: true` responde `requiere confirmación explícita de: …` y queda una fila `pendiente_confirmacion` en `out/control.csv`. Los bloqueos (RC1–RC4, RC10) nunca se pueden confirmar.

## 4. Elección del modelo

- **Proveedor y modelo usados en la prueba:** OpenAI, modelo `gpt-4.1-mini` (`LLM_PROVIDER=openai`, `LLM_MODEL=gpt-4.1-mini`). Lo elegí porque ya tenía créditos en la API de OpenAI, tiene buen soporte de llamadas a herramientas (incluidas varias en paralelo) y es barato por token. El código también trae un adaptador para Anthropic (Claude); cambiar de proveedor es cambiar dos variables de entorno, sin tocar el ciclo del agente. Para un modelo pequeño como este el diseño es clave: las reglas y los valores los calculan las herramientas, así que el modelo solo orquesta y explica.
- **Aviso:** la documentación de OpenAI marca `gpt-4.1-mini` como *deprecated* (al 2026-11-05). Funciona hoy, pero si OpenAI lo retira basta con cambiar `LLM_MODEL` por otro modelo de chat disponible en la cuenta.
- **Costo medido (no estimado).** Precio de `gpt-4.1-mini` según la página del modelo en OpenAI: USD 0,40 por millón de tokens de entrada y USD 1,60 por millón de salida. Tokens reales registrados por el servidor (`out/sessions/`) en mi prueba:

  | Sesión | Turnos | Tokens entrada | Tokens salida | Costo aprox. |
  |---|---|---|---|---|
  | `sol-004` con confirmación y creación de la OC + `sol-003` bloqueada | 3 | 57 699 | 1 712 | ≈ USD 0,026 |

  **Costo por caso procesado: ≈ USD 0,013** (dos casos en la sesión). La mayor parte es entrada, porque cada vuelta reenvía el historial y el payload viaja dos veces.

## 5. Matriz de controles

Todo control vive en `validarPaquete` (`src/lib/dominio.ts`), lee los maestros y deja un registro por regla en `controles[]` (ok, bloqueo, confirmación, derivado o no aplica) con un detalle legible. Cada bloqueo o confirmación incluye una **acción sugerida** (qué pedir y a quién).

| Regla | Implementación | Resultado en los fixtures |
|---|---|---|
| RC1 | Con NIT: `SapAdapter.consultarProveedor(nit)` (en producción, consulta a SAP); sin NIT: nombre normalizado (sin tildes ni sufijo societario). Debe estar `activo`. Además advierte si el NIT de la cotización no coincide. | sol-002 **bloqueo** (NIT 901999000 no existe) · sol-006 identificado por nombre (advertencia) |
| RC2 | Aprobación presente, contiene «Aprobado» (sin negación tipo «no aprobado») y el remitente es aprobador del centro de costo. | sol-003 **bloqueo** (fvargas aprueba CC-3030, no CC-2020) |
| RC3 | `valor_total` ≤ tope del aprobador en ese centro. Si el aprobador no pertenece al centro, no hay tope evaluable y también bloquea; la acción sugerida lista quién sí puede aprobar o indica escalar si nadie tiene tope suficiente. | sol-003 **bloqueo**: el tope máximo de CC-2020 es 30 000 000 y la solicitud es de 74 000 000 → escalar |
| RC4 | `subarea` ∈ `subareas` del centro. | Todos pasan |
| RC5 | `abs(cotización − solicitud) / solicitud` > 2 % → confirmación con ambos valores; sin cotización → confirmación. | sol-004 **confirmación** (26 500 000 vs 25 000 000, 6 %) |
| RC6 | Sin `indicador_iva` → `derivados.indicador_iva` del proveedor + confirmación. Código inexistente → bloqueo. | sol-006 **confirmación** (C1 del maestro) |
| RC7 | Sin `condiciones_pago` → `derivados.condiciones_pago` del proveedor, solo se informa. Código inexistente → bloqueo. | sol-006 deriva Z030 |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true` + confirmación; se registra en `control.csv`. | sol-005 **retroactiva** (factura 2026-08-10, solicitud 2026-08-27) |
| RC9 | Fecha de aprobación ≥ fecha de solicitud; si no, confirmación. | Todos pasan |
| RC10 | `abs(cantidad × valor_unitario − valor_total)` ≤ 1; si no, bloqueo. | Todos pasan |

**La más difícil: RC2/RC3 juntas.** El PRD las define por separado, pero en sol-003 el aprobador no pertenece al centro, así que su tope «no existe»: hubo que decidir que RC3 también bloquea (no evaluable ≠ aprobado) y, sobre todo, que la respuesta fuera útil. Por eso el agente calcula quién del centro tiene tope suficiente y, si nadie lo tiene (como aquí), sugiere escalar. Un segundo punto delicado fue RC1 sin NIT (sol-006): identificar por nombre es razonable, pero se deja una advertencia porque dos razones sociales parecidas podrían confundirse.

**Valor de la OC:** se crea con los valores de la **solicitud** (lo aprobado), no de la cotización; la diferencia queda como excepción RC5 con `confirmado_por`. Si el negocio prefiere el valor cotizado, debe venir con una aprobación por ese monto.

## 6. Diseño del adaptador SAP real (solo documentación)

**Decisión condicionada a la viabilidad, en este orden:**

1. **Primero confirmar con TI:** versión de SAP (ECC o S/4HANA), despliegue (on-premise o cloud), si existe SAP BTP / Integration Suite o un middleware corporativo, y quién habilita usuarios técnicos.
2. **S/4HANA → OData `API_PURCHASEORDER_PROCESS_SRV`** (creación profunda de cabecera + posiciones + imputación en una sola llamada, atómica), expuesto por Cloud Connector / API Management. Es la opción preferida: estándar, REST y transaccional.
3. **ECC (o S/4 sin OData habilitado) → `BAPI_PO_CREATE1` vía RFC**, preferiblemente envuelta por Integration Suite o un servicio intermedio que exponga REST, para no instalar el SDK RFC en el servidor del agente.
4. **Si nada de lo anterior es viable a corto plazo → plan B** (abajo).

**Mapeo del payload (7.4) a `BAPI_PO_CREATE1`** (nombres de la BAPI estándar; verificar contra la configuración de Periferia):

| Payload | BAPI | Nota |
|---|---|---|
| `sociedad` | `POHEADER-COMP_CODE` | 1000 |
| `organizacion_compras` | `POHEADER-PURCH_ORG` | 1000; además se necesita `PUR_GROUP` (grupo de compras) y `DOC_TYPE` (p. ej. NB), que no están en el payload: se parametrizan |
| `proveedor.codigo_sap` | `POHEADER-VENDOR` | |
| `moneda` | `POHEADER-CURRENCY` | |
| `condiciones_pago` | `POHEADER-PMNTTRMS` | |
| `referencia.solicitud_id` | Campo de referencia de cabecera (p. ej. `POHEADER-OUR_REF`) | Clave de idempotencia; confirmar qué campo usa Periferia |
| `posiciones[].numero` | `POITEM-PO_ITEM` | 00010 |
| `posiciones[].descripcion` | `POITEM-SHORT_TEXT` | Máx. 40 caracteres (por eso se trunca) |
| `posiciones[].cantidad` / `unidad` | `POITEM-QUANTITY` / `PO_UNIT` | UN/H/MES se traducen con una tabla a las unidades internas de SAP |
| `posiciones[].precio_unitario` | `POITEM-NET_PRICE` | Verificar si el precio se maneja con o sin IVA en la configuración |
| `posiciones[].indicador_iva` | `POITEM-TAX_CODE` | |
| `posiciones[].centro_costo` | `POACCOUNT-COSTCENTER` con `POITEM-ACCTASSCAT = K` | Falta la cuenta contable (`GL_ACCOUNT`): se deriva por categoría de compra |
| `posiciones[].subarea` | Campo de seguimiento (p. ej. `POITEM-TRACKINGNO`) o texto de posición | SAP no tiene «subárea» estándar: decisión con contabilidad |
| `aprobador` + evidencia | Texto de cabecera + adjunto del PDF (servicio de adjuntos / GOS) | El sha256 viaja en el texto para auditoría |
| `excepciones` | Texto de cabecera | Quién confirmó qué |

En OData el mapeo es equivalente sobre las entidades de cabecera, posición e imputación de la API (verificar nombres exactos en SAP Business Accelerator Hub para la versión instalada).

**Autenticación y credenciales:** usuario técnico de comunicación con rol mínimo (crear OC, leer proveedores), OAuth 2.0 o certificado cliente vía Cloud Connector / API Management. Las credenciales viven en un gestor de secretos (p. ej. Azure Key Vault) y las lee **solo el adaptador** en el backend; nunca el modelo, el prompt, el front ni los logs.

**Idempotencia y errores parciales:**
- Clave de idempotencia = `solicitud_id`. Antes de crear: `buscarOrdenPorReferencia` en SAP y en una tabla local de salida (*outbox*) con estado `pendiente → enviada → confirmada | fallida`.
- BAPI: la OC solo existe si se llama `BAPI_TRANSACTION_COMMIT` cuando la tabla `RETURN` no trae errores (tipo E/A); si los trae, `BAPI_TRANSACTION_ROLLBACK` y se devuelve el mensaje SAP traducido. OData con creación profunda es atómica: o se crea todo o nada.
- **Timeout o respuesta perdida:** el estado queda «incierto»; antes de reintentar se consulta por referencia para no duplicar. Reintentos con espera exponencial y máximo 3; luego, a la cola de revisión humana.
- Si el adjunto de evidencia falla después de crear la OC, la OC no se revierte: queda marcada «evidencia pendiente» en control y se reintenta solo el adjunto.

**Plan B si la conexión no es viable:** el agente sigue ahorrando la parte de criterio y verificación: 1) valida RC1–RC10 igual que hoy; 2) genera una **hoja «lista para pegar»** con los campos en el orden de la transacción ME21N y la evidencia PDF lista para adjuntar; 3) genera un **archivo de carga masiva** (CSV con la estructura de la BAPI, para un programa Z o LSMW / cockpit de migración, según lo que TI acepte); 4) la analista crea la OC y registra el número en el chat, que lo guarda en `control.csv`. La medición de retroactivas funciona igual.

## 7. Lectura del proceso: OC retroactivas

En los fixtures, sol-005 muestra el patrón: la factura es del 10 de agosto, la solicitud del 27 y la aprobación dice «Ya llegó la factura, por favor crear la OC para poder radicarla». La OC deja de ser un control previo y se vuelve un trámite para poder pagar: el gasto se comprometió sin validar proveedor, precio ni autoridad de aprobación, y la cotización se volvió irrelevante.

**Qué le diría a la dirección:** hoy no sabemos cuánto pasa; desde ahora el agente lo mide en cada OC (`retroactiva` en `out/control.csv`, por solicitante, aprobador y centro de costo). Propongo mirar un mes de datos antes de endurecer la política y, en paralelo:

1. **Política «sin OC no se paga» (No PO, No Pay)** con transición: cuentas por pagar no radica facturas sin número de OC, salvo excepciones aprobadas por finanzas; se comunica a proveedores que la factura debe citar la OC.
2. **Compras recurrentes con acuerdos marco u OC abiertas** (papelería, licencias, suscripciones) para que la urgencia no obligue a saltarse el proceso.
3. **Excepción formal:** una OC retroactiva requiere una aprobación adicional (finanzas) por encima de un umbral, y queda en un reporte mensual por área.
4. **Meta:** bajar mes a mes el porcentaje de OC retroactivas que reporte `control.csv`; la política de tolerarlas con marca o rechazarlas la decide la dirección con esos datos (pregunta abierta del PRD).

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **recalculan** paquete, validación y payload desde los archivos; `oc_crear` compara el payload recibido con el validado y rechaza diferencias. | Confiar en el payload que reenvía el modelo. | Cumple «el modelo no puede alterar el payload validado»; `demo.ts` lo prueba alterando las condiciones de pago. |
| 2 | La OC usa los **valores de la solicitud** y la diferencia con la cotización queda como excepción confirmada. | Usar el valor de la cotización. | La aprobación del líder es por el valor solicitado («Aprobado por 25 millones»); crear por 26,5 M excedería lo aprobado. |
| 3 | **RC3 bloquea también cuando el aprobador no pertenece al centro** y sugiere quién puede aprobar. | Marcar RC3 como «no aplica». | Una regla no evaluable no debe pasar como aprobada; la sugerencia ahorra la ida y vuelta. |
| 4 | **Idempotencia antes que validación** en `oc_crear` (si la OC ya existe, se devuelve aunque cambie algo). | Validar primero. | Un reintento nunca debe crear una segunda OC; si cambió el paquete, es una nueva solicitud. |
| 5 | Controles parametrizados en `src/knowledge/reglas-oc.json` (tolerancias, sociedad, numeración, unidades). | Constantes en el código. | Cambiar una tolerancia no toca el servidor ni las herramientas. |
| 6 | `node:http` + `fetch`, sin framework ni SDK. | Express/Hono + SDK. | Menos dependencias; el adaptador es explícito; corre en Bun y Node. |

## 9. Supuestos

- La evidencia `aprobacion.txt` contiene De, Para, CC, Fecha, Asunto y cuerpo; el **sha256 se calcula sobre ese contenido** (sin la línea del hash) y es el mismo que va en `aprobador.evidencia_sha256`. `aprobacion.pdf` reproduce el contenido.
- `unidad`: `H` si la descripción menciona horas, `MES` si es mensual, si no `UN` (regla en `reglas-oc.json`, trazada como derivado).
- La descripción se trunca a 40 caracteres (límite del texto breve de SAP; puede cortar una palabra); la descripción completa queda en la solicitud.
- La fecha de aprobación se compara solo por día (la hora se ignora).
- `fecha` de la OC simulada = fecha de referencia (actual o `FECHA_REFERENCIA`).
- Además de las reglas del PRD se agregan advertencias que no bloquean: NIT de la cotización distinto al del proveedor, cotización vencida antes de la solicitud y adjuntos ausentes.
- Leer `.xlsx` reales (`oc_leer_excel`, P1) no se implementó: los fixtures traen la solicitud en JSON.

## 10. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el paquete | Hecho | `oc_leer_paquete` normaliza (7.2); adjunto ausente → `null` y `faltantes[]`. | Leer `.xlsx`, `.pdf` y `.eml` reales (`oc_leer_excel` P1 no implementado). |
| HU-2 Validar | Hecho | RC1–RC10 con `apta`, `bloqueos`, `confirmaciones`, `derivados`, `retroactiva` y acción sugerida. | Maestros consultados en SAP en tiempo real. |
| HU-3 Payload | Hecho | `OrdenCompra` validada con `zod`; `trazabilidad.json` con la fuente de cada valor. | Grupo de compras, clase de documento y cuenta contable parametrizados. |
| HU-4 Evidencia | Hecho (P0 txt + P1 pdf) | `aprobacion.txt` con sha256 y `aprobacion.pdf` con `pdf-lib`. | Adjuntar a la OC en SAP; firma digital si auditoría la exige. |
| HU-5 Crear en SAP simulado | Hecho | Numeración desde 4500000001, idempotencia por `solicitud_id`, `control.csv` con cada intento (creada, bloqueada, pendiente, idempotente, payload alterado). | Adaptador real (sección 6). |
| HU-6 Errores | Hecho | Caso inexistente, JSON o montos inválidos (validados con zod), payload alterado: `{ ok:false }` con qué pedir al solicitante. | Alertas operativas. |
| Bonus módulo | Hecho | `modulo/` generado desde las mismas piezas y verificado. | Publicación en la plataforma de agentes. |

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic), en una sesión agéntica, para leer los tres PRD y los fixtures, proponer la arquitectura, escribir el código TypeScript, el front, `demo.ts`, los scripts y esta documentación, y para probar todo (demos, `tsc --noEmit`, pruebas del chat de punta a punta con el proveedor simulado y capturas del front con Playwright).
- **Qué se descartó durante la construcción y por qué:**
  - *SDKs de los proveedores y un framework web (Express/Hono):* se prefirió `fetch` y `node:http` para que el adaptador fuera explícito, no hubiera dependencias que justificar y el mismo código corriera con Bun o con Node.
  - *Dejar que el modelo valide o calcule:* toda regla vive en herramientas deterministas; el modelo orquesta y explica. Por eso las herramientas recalculan desde los fixtures lo que el modelo les devuelve y rechazan valores alterados.
  - *Habilitar `confirmado: true` cuando el modelo "pregunta algo":* se descartó porque una pregunta cualquiera ("¿proceso otro caso?") seguida de "sí" habría autorizado acciones externas; solo la marca formal habilita.
  - *Crear la OC por el valor cotizado cuando difiere:* descartado porque excede lo aprobado; se crea por lo aprobado y se documenta la excepción.
- **Lo que hice yo:** corrí la demo y el chat en mi computadora (Windows, Bun) con OpenAI `gpt-4.1-mini`; probé `sol-004` (confirmación por RC5 y creación de la OC 4500000001) y `sol-003` (bloqueo por RC2/RC3 con sugerencia de escalamiento), y revisé `control.csv`, `trazabilidad.json` y la evidencia en PDF. Elegí OpenAI como proveedor porque ya tenía créditos.
- **Lo que detecté probando (en los retos 01 y 02) y se aplicó también aquí:** si el modelo pide confirmación solo en texto, el servidor bloquea el "confirmo" por seguridad. Para no depender del modelo, `oc_validar` declara la confirmación pendiente (`pendiente_confirmacion`) cuando la OC es apta pero tiene excepciones.

## 12. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| La integración con SAP no es viable a corto plazo. | Plan B (hoja lista para pegar y archivo de carga masiva); el valor de la validación y la medición se mantiene. |
| El modelo «ajusta» un monto para cuadrar con la cotización. | Montos solo desde herramientas; `oc_crear` rechaza payloads alterados. |
| OC duplicadas por reintentos o timeouts. | Idempotencia por `solicitud_id` en SAP + outbox local; consulta por referencia antes de reintentar. |
| Maestros desactualizados (topes, aprobadores, proveedores inactivos). | Consultar SAP en tiempo real; dueño de la matriz de aprobación; revisión trimestral. |
| Suplantación del correo de aprobación. | Validar el remitente con el servidor de correo (SPF/DKIM) y, si auditoría lo exige, aprobación dentro de un flujo con firma o SSO. |
| Credenciales SAP expuestas. | Usuario técnico de rol mínimo, secretos en un gestor, nunca en el agente ni en logs. |
| Costo del modelo. | Topes de iteraciones y tokens por sesión, clave de acceso al link y límites de gasto en el proveedor. |

