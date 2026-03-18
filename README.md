# Botmaker → CRM Bridge – Universidad Austral

API en Node.js que conecta **Botmaker** con **Dynamics 365 CRM**.  
Cada vez que el bot finaliza una conversación, envía un webhook a esta API, que:

1. Valida los campos del formulario
2. Busca si ya existe un Lead en CRM con ese email
3. **Crea** el Lead si no existe, o **actualiza** los campos faltantes si ya existe
4. **Siempre** crea un registro de "Origen del cliente potencial" asociado al Lead

---

## Instalación

```bash
npm install
cp .env.example .env   # completar las variables
node index.js
```

---

## Variables de entorno (.env)

| Variable | Descripción |
|---|---|
| `CRM_BASE_URL` | URL base de la API de Dynamics 365 |
| `CRM_TOKEN_URL` | URL de token OAuth2 de Azure AD |
| `CRM_CLIENT_ID` | Client ID del App Registration en Azure |
| `CRM_CLIENT_SECRET` | Secret del App Registration |
| `CRM_SCOPE` | Scope de Dynamics (termina en `/.default`) |
| `WEBHOOK_SECRET` | Header secreto para validar el webhook de Botmaker |
| `PORT` | Puerto del servidor (default: 3000) |

---

## Endpoint

### `POST /webhook/botmaker`

**Header requerido:**
```
x-webhook-secret: <WEBHOOK_SECRET>
```

**Body (JSON):**

```json
{
  "firstname": "Juan",
  "lastname": "Pérez",
  "emailaddress1": "juan@ejemplo.com",
  "mobilephone": "+5491122334455",
  "canal": "WhatsApp",

  "new_interesadoposgrado": true,
  "new_origencandidato": "WhatsApp",
  "businessunit": "Facultad de Ingeniería",
  "new_facultaddeorigen": "UBA",

  "new_areadeinteresid": "<GUID del área>",
  "new_programadeinteresid": "<GUID del programa>",

  "new_tema": "Nueva Consulta - BOT - Juan Pérez",
  "description": "Últimos 2000 chars de la conversación...",

  "ownerid": "<GUID del asesor>",
  "owneridtype": "systemuser",

  "new_campanaid": "<GUID de la campaña>",
  "new_actdecampanaid": "<GUID de la actividad>",

  "new_utm_source": "google",
  "new_utm_medium": "cpc",
  "new_utm_campaign": "posgrados-2025",
  "new_utm_term": "maestria contabilidad",
  "new_utm_content": "banner-home",
  "new_googleclickid": "Cj0KCQ...",
  "new_campaignid": "camp_123",
  "new_sourceid": "src_456"
}
```

**Campos obligatorios:**
- `firstname` (mín. 3 letras, solo letras)
- `lastname` (mín. 2 letras, solo letras)
- `emailaddress1` (formato válido de email)
- `new_areadeinteresid` (GUID)
- `new_programadeinteresid` (GUID)
- `mobilephone` (solo si `canal === "Web"`)

**Respuesta exitosa:**
```json
{
  "ok": true,
  "lead_action": "created",
  "leadid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "origen_id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
}
```

---

## Reglas de negocio implementadas

| Regla | Implementación |
|---|---|
| Lead identificado por email | `findLeadByEmail()` busca en CRM antes de crear |
| Email nuevo → crear Lead | `createLead()` |
| Email existente → no crear, actualizar datos faltantes | `updateLead()` con merge selectivo |
| Siempre crear Origen del cliente potencial | `createOrigen()` en todos los casos |
| Teléfono solo se actualiza si estaba vacío | Chequeo `!existing.mobilephone` |
| Facultad / Área / Programa no se duplican en Lead | Chequeo de campos ya existentes |
| Conversación truncada a 2000 chars (últimos) | `description.slice(-2000)` |
| Teléfono no se pide en WhatsApp | Validación por `canal` |
| Emojis: el bot los filtra antes de enviar | (responsabilidad del bot) |
| Si faltan campos obligatorios → no crear Lead | Validación al inicio del webhook |

---

## Configurar Botmaker para llamar al webhook

En Botmaker, al finalizar la conversación, configurar una acción HTTP:

- **URL:** `https://tu-servidor.com/webhook/botmaker`
- **Método:** `POST`
- **Headers:**
  - `Content-Type: application/json`
  - `x-webhook-secret: <tu secreto>`
- **Body:** JSON con los campos del formulario mapeados a los nombres lógicos del CRM

---

## Health check

```
GET /health
→ { "status": "ok" }
```
