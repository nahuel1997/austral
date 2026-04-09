Botmaker → CRM Bridge – Universidad Austral
API en Node.js que conecta Botmaker con Dynamics 365 CRM.
Cuando el bot finaliza una conversación, envía uno o más webhooks a esta API, que acumula las variables por sesión y luego:

Valida los campos obligatorios (Nombre y Mail)
Busca si ya existe un Lead en CRM con ese email
Crea el Lead si no existe, o actualiza los campos faltantes si ya existe
Crea los registros relacionados (Área, Programa, Facultad) solo si no existen ya en el Lead
Siempre crea un registro de "Origen del cliente potencial" asociado al Lead


Instalación
bashnpm install
cp .env.example .env   # completar las variables
node index.js

Variables de entorno (.env)
VariableDescripciónCRM_BASE_URLURL base de la API de Dynamics 365CRM_TOKEN_URLURL de token OAuth2 de Azure ADCRM_CLIENT_IDClient ID del App Registration en AzureCRM_CLIENT_SECRETSecret del App RegistrationCRM_SCOPEScope de Dynamics (termina en /.default)WEBHOOK_SECRETValor del header auth-bm-token para validar el webhookPORTPuerto del servidor (default: 3000)

Endpoints
POST /webhook/botmaker
Endpoint principal. Botmaker llama a este endpoint (puede ser varias veces por sesión). La API acumula las variables durante 15 segundos tras recibir las variables requeridas, y luego procesa todo junto en CRM.
Header requerido:
auth-bm-token: <WEBHOOK_SECRET>
Body (JSON):
json{
  "sessionId": "session-abc-123",
  "chatPlatform": "whatsapp",
  "contactId": "5491161417175",
  "variables": {
    "Nombre": "Juan",
    "Apellido": "Pérez",
    "Mail": "juan@ejemplo.com",
    "Telefono": "5491161417175",
    "ProgramaSeleccionado": "Maestría en Dirección de Empresas",
    "Area": "Posgrado",
    "Facultad": "Facultad de Ciencias Empresariales",
    "UTM": "https://www.austral.edu.ar/posgrado/?utm_source=google&utm_medium=cpc&utm_campaign=posgrados-2025&gclid=Cj0KCQ...",
    "Campana": "Campaña Posgrados 2025",
    "ActividadCampana": "Actividad Email Mayo",
    "CodigoWA": "UA-1234"
  }
}
Variables reconocidas:
VariableDescripciónNombreNombre del contacto (obligatorio)ApellidoApellido del contactoMailEmail del contacto (obligatorio)TelefonoTeléfono (también busca en telefono_ws, telefono_ws_2, telefono_ws_3)ProgramaSeleccionadoNombre o GUID del programa de interésAreaNombre o GUID del área de interésFacultadNombre o GUID de la facultad (business unit)UTMURL completa con parámetros UTM para parsearCampanaNombre o GUID de la campaña en CRMActividadCampanaNombre o GUID de la actividad de campañaCodigoWACódigo de vinculación para recuperar URL desde el store de URL-TrackingReferralURLURL de la conversación en Botmaker (se construye automáticamente)
Respuestas:
json// Variables incompletas — esperando más mensajes
{ "ok": true, "skipped": true, "reason": "variables incompletas", "faltantes": ["Mail"] }

// Variables completas — procesamiento encolado
{ "ok": true, "queued": true, "vars": { ... } }

// Sin sessionId ni email
{ "ok": true, "skipped": true, "reason": "sin sessionId" }

POST /url-tracking
Llamado desde WordPress cuando el usuario hace clic en el botón de WhatsApp. Asocia una URL con un código único para recuperarla luego desde el webhook.
Headers:
Content-Type: application/json
Body:
json{
  "codigo": "UA-1234",
  "url": "https://www.austral.edu.ar/derecho/posgrados/?utm_source=google&utm_medium=cpc&utm_campaign=llm-2025"
}
Respuesta:
json{ "ok": true, "codigo": "UA-1234" }
Los códigos expiran a las 48 horas de ser registrados.

GET /health
Health check del servidor.
json{ "status": "ok", "sessions": 2, "urlTracking": 5 }

GET /debug/url-tracking
Lista todos los códigos activos en el store de URL-Tracking.
json{
  "total": 1,
  "entries": {
    "UA-1234": {
      "url": "https://www.austral.edu.ar/...",
      "creadoEn": "2025-04-08T14:00:00.000Z"
    }
  }
}

Lógica de acumulación de sesiones
La API no procesa inmediatamente cada webhook. En cambio:

Cada llamada al webhook se identifica por sessionId (o Mail como fallback)
Las variables se acumulan en memoria mientras llegan mensajes de la misma sesión
Cuando se detectan las variables requeridas (Nombre y Mail), se inicia un timer de 15 segundos
Si llega otro mensaje antes de que expire el timer, el timer se reinicia
Al expirar el timer, se procesa la sesión completa contra CRM
Las sesiones se eliminan de memoria a los 30 minutos de inactividad


Lógica de resolución de UTMs
La API intenta obtener UTMs en este orden:

Extrae el código del campo UTM si tiene el formato Código: UA-XXXX
Usa el campo CodigoWA como código de vinculación
Busca la URL real en el store de URL-Tracking con ese código
Si no hay código, busca una URL directa en los campos URL, landing_url, UTM_URL
Parsea los parámetros UTM de la URL encontrada (utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid, campaignid)


Reglas de negocio implementadas
ReglaImplementaciónLead identificado por emailfindLeadByEmail() busca en CRM antes de crearEmail nuevo → crear LeadcreateLead()Email existente → actualizar datos faltantesupdateLead() con merge selectivoTeléfono solo se actualiza si estaba vacío en CRMChequeo !existing.mobilephoneÁrea no se duplicafindAreaByLead() antes de crearPrograma no se duplicafindProgramaByLead() antes de crearFacultad no se duplicafindFacultadByLead() antes de crearOrigen siempre se creacreateOrigenClientePotencial() en todos los casosNombres/GUIDs resueltos dinámicamentefindAreaIdByName(), findCarreraIdByName(), etc.Token CRM cacheado hasta 1 minuto antes de expirargetCrmToken() con crmTokenCache

Ejemplo de curl para pruebas
bashcurl -X POST https://<tu-dominio>/webhook/botmaker \
  -H "Content-Type: application/json" \
  -H "auth-bm-token: <WEBHOOK_SECRET>" \
  -d '{
    "sessionId": "session-test-001",
    "chatPlatform": "whatsapp",
    "contactId": "5491161417175",
    "variables": {
      "Nombre": "Juan",
      "Apellido": "Pérez",
      "Mail": "juan@ejemplo.com",
      "Telefono": "5491161417175",
      "ProgramaSeleccionado": "Maestría en Dirección de Empresas",
      "Area": "Posgrado",
      "Facultad": "Facultad de Ciencias Empresariales",
      "UTM": "https://www.austral.edu.ar/posgrado/?utm_source=google&utm_medium=cpc",
      "Campana": "Campaña Posgrados 2025",
      "ActividadCampana": "Actividad Email Mayo"
    }
  }'

Configurar Botmaker para llamar al webhook
En Botmaker, al finalizar la conversación, configurar una acción de script con rp():

URL: https://<tu-dominio>/webhook/botmaker
Método: POST
Headers:

Content-Type: application/json
auth-bm-token: <WEBHOOK_SECRET>


Body: JSON con sessionId, chatPlatform, contactId y el objeto variables con los campos del formulario