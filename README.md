# Reto 03 — Agente «Órdenes de Compra SAP»

> Proceso de selección Perxia 2.0 · Periferia IT Group. Planteamiento completo en [`SOLUCION.md`](SOLUCION.md).

Agente conversacional que lee el paquete de compra (solicitud, cotización, aprobación y factura si existe), lo valida contra los maestros con los controles **RC1–RC10**, construye el payload de la OC con trazabilidad de cada valor, genera la evidencia de aprobación (txt + PDF con sha256) y crea la OC en un **SAP simulado**, idempotente y con log de control. Los bloqueos no se fuerzan y las confirmaciones las decide el usuario.

## Link de prueba

**URL:** https://reto-03-3u1w.onrender.com  (estado: https://reto-03-3u1w.onrender.com/api/health)
**Clave de acceso:** `periferia2026` (el chat la pide al abrir el link).

Desplegado en Render (plan gratuito) con OpenAI `gpt-4.1-mini`. Si el servicio estaba inactivo, el primer acceso puede tardar alrededor de un minuto en despertar.

## Levantar en local (un comando)

Requisitos: [Bun](https://bun.sh) 1.1 o superior.

```bash
bun install
cp .env.example .env      # completa LLM_API_KEY (y LLM_MODEL si usas openai)
bun run dev               # front + backend en http://localhost:3000
```

Bun carga `.env` automáticamente.

**Windows (PowerShell), con OpenAI y sin escribir la clave en disco:**

```powershell
$env:LLM_PROVIDER = "openai"
$env:LLM_MODEL    = "gpt-4.1-mini"     # o cualquier modelo de chat disponible en tu cuenta
$env:LLM_API_KEY  = "sk-..."           # tu clave; vive solo en esta ventana de PowerShell
bun install
bun run dev
```

Sin clave puedes revisar la interfaz con el proveedor **simulado** (un guion fijo, no un modelo de lenguaje):

```bash
LLM_PROVIDER=simulado bun run dev
```

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `LLM_PROVIDER` | sí | `anthropic` (por defecto), `openai` (cualquier API compatible con OpenAI Chat Completions) o `simulado`. |
| `LLM_API_KEY` | sí, salvo `simulado` | Clave del proveedor. Solo vive en el backend: no llega al front, a la API, a los logs ni al repositorio. |
| `LLM_MODEL` | con `openai` | Modelo a usar. Con `anthropic`, vacío = `claude-sonnet-5-5`. |
| `LLM_BASE_URL` | no | Endpoint de un proveedor compatible con OpenAI distinto de OpenAI. |
| `MAX_ITERACIONES` | no | Tope de ciclos modelo → herramientas por turno (25). |
| `MAX_TOKENS_SESION` | no | Tope de tokens por sesión (500 000). Al alcanzarlo, la sesión deja de llamar al modelo. |
| `MAX_TOKENS_RESPUESTA` | no | Máximo de tokens por respuesta del modelo (4096). |
| `LLM_TIMEOUT_MS` | no | Timeout por llamada al proveedor (60 000 ms). |
| `ACCESS_KEY` | no | Si se define, la API y las descargas exigen esta clave (el front la pide una vez). |
| `FECHA_REFERENCIA` | no | Fecha fija `YYYY-MM-DD`; vacío = fecha actual en Colombia. |
| `PORT` | no | Puerto HTTP (3000). |

## Demo sin modelo (`demo.ts`)

```bash
bun install && bun run demo.ts
```

Llama directamente a las herramientas (sin modelo ni clave), limpia `out/` al inicio e imprime el resumen por caso, los errores controlados y si `modulo/` está sincronizado. La demo usa `FECHA_REFERENCIA=2026-09-03` por defecto para la fecha de las OC simuladas; el servidor usa la fecha actual salvo que la definas.

Salidas: `out/sap/ordenes.jsonl`, `out/control.csv`, `out/<caso>/payload.json`, `out/<caso>/trazabilidad.json`, `out/<caso>/validacion.json`, `out/<caso>/aprobacion.txt` y `aprobacion.pdf`, `out/log.jsonl`.

## Prueba sugerida en el chat

1. Sesión nueva: `Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.`
2. Cuando el agente pida confirmación (recuadro amarillo): `confirmo`

## Herramientas

| Herramienta | Entrada | Salida (`data`) |
|---|---|---|
| `oc_leer_paquete` | `{ caso }` | Paquete normalizado (sección 7.2); adjunto ausente → `null` |
| `oc_validar` | `{ caso, paquete? }` | `{ apta, bloqueos[], confirmaciones[], derivados, retroactiva, controles[] }` |
| `oc_construir_payload` | `{ caso, paquete?, derivados? }` | `OrdenCompra` validada con zod + `out/<caso>/trazabilidad.json` |
| `oc_generar_evidencia` | `{ caso }` | `{ ruta, ruta_pdf, sha256 }` |
| `oc_crear` | `{ caso, payload?, confirmado? }` | `{ numero_oc, fecha, idempotente }` o `{ ok:false, error }` |
| `agente_solicitar_confirmacion` | `{ accion, detalle }` | Marca formal de «confirmación pendiente» (ver SOLUCION.md §3) |

Todas devuelven un string JSON `{ ok: true, data }` o `{ ok: false, error }` y nunca lanzan excepciones. Los argumentos se validan con `zod` antes de ejecutar.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, confirmacion, tokens, error }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (turnos, llamadas a herramientas, tokens, confirmación pendiente) |
| `GET` | `/api/health` | `{ ok, app, provider, model, herramientas, ejemplos }`, sin claves |
| `GET` | `/out/<ruta>` | Descarga de archivos generados en `out/` (no expone `out/sessions/`) |

`sessionId`: 6–64 caracteres `[A-Za-z0-9_-]`. Con `ACCESS_KEY`, enviar el encabezado `x-access-key`.

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo-sesion-1","message":"hola"}'
```

## Estructura

```
agent/prompt.md          comportamiento (system prompt)
src/knowledge/           conocimiento del proceso (.md) y reglas de negocio parametrizables (.json)
src/tools/oc.ts            ejecución: herramientas (cada export → oc_<export>)
src/tools/agente.ts      herramienta transversal agente_solicitar_confirmacion
src/lib/                 lógica de dominio usada por las herramientas
src/sap/                 adapter.ts (interfaz SapAdapter + esquema zod de la OC) y mock.ts (SAP simulado)
src/agent/               ciclo del agente y sesiones
src/llm/                 adaptador propio (adapter.ts) + anthropic.ts, openai.ts, simulado.ts
src/core/                contrato de herramientas, ejecución con log, utilidades
src/server.ts            API HTTP + archivos estáticos (node:http, sin framework)
web/                     front de chat (HTML + JS sin dependencias)
modulo/                  bonus: agente empaquetado (generado desde las mismas piezas)
fixtures/                entregados por Periferia (solo lectura)
demo.ts                  verificación sin modelo
```

Dependencias: `zod`, `pdf-lib` (evidencia en PDF). Sin framework web ni SDK de proveedores (ver SOLUCION.md, decisiones).

## Comprobaciones

```bash
bun run typecheck        # tsc --noEmit, modo estricto y sin any
bun run modulo:check     # verifica que modulo/ sea idéntico a la app
bun run modulo           # regenera modulo/ si cambiaste el prompt, el conocimiento o las herramientas
```

## Despliegue (Render, con Docker)

1. Sube este directorio a un repositorio de GitHub (sin `node_modules/`, `out/` ni `.env`; ya están en `.gitignore`).
2. En [Render](https://render.com): **New → Blueprint** y elige el repositorio (usa `render.yaml`), o **New → Web Service** con runtime Docker.
3. En *Environment*, define `LLM_API_KEY` (y `LLM_MODEL` / `ACCESS_KEY` si aplica).
4. Cuando el servicio esté *Live*, abre `https://<tu-servicio>.onrender.com/api/health` y copia la URL arriba, en «Link de prueba».

Notas: en el plan gratuito de Render el servicio se duerme tras un tiempo sin uso y el primer acceso tarda en despertar; abre el link unos minutos antes de la defensa. `out/` es efímero en ese entorno (se reinicia con cada despliegue). Cualquier otro proveedor que ejecute un `Dockerfile` (Railway, Fly.io, Azure Container Apps) sirve igual.

## Módulo reutilizable (bonus)

`modulo/agent.md` (frontmatter + system prompt), `modulo/tools/oc.ts` (re-export de las mismas herramientas, importables sin servidor) y `modulo/skill/*/SKILL.md` (conocimiento del proceso). Se generan con `bun run modulo` desde `agent/prompt.md`, `src/knowledge/` y `src/tools/`, y `demo.ts` / `bun run modulo:check` verifican que no diverjan.

