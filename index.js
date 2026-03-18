/**
 * API Bridge: Botmaker → CRM (Dynamics 365)
 * Universidad Austral
 *
 * Flujo:
 *  1. Recibe webhook de Botmaker al finalizar conversación
 *  2. Valida campos obligatorios y formatos
 *  3. Busca si el Lead ya existe en CRM por email
 *  4. Crea o actualiza el Lead según las reglas de negocio
 *  5. Crea siempre un registro "Origen del cliente potencial"
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ─── Configuración desde variables de entorno ────────────────────────────────
const {
  CRM_BASE_URL,       // ej: https://<org>.crm.dynamics.com/api/data/v9.2
  CRM_TOKEN_URL,      // ej: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
  CRM_CLIENT_ID,
  CRM_CLIENT_SECRET,
  CRM_SCOPE,          // ej: https://<org>.crm.dynamics.com/.default
  WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

// ─── Cache del token CRM ─────────────────────────────────────────────────────
let crmTokenCache = { token: null, expiresAt: 0 };

async function getCrmToken() {
  if (crmTokenCache.token && Date.now() < crmTokenCache.expiresAt - 60_000) {
    return crmTokenCache.token;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CRM_CLIENT_ID,
    client_secret: CRM_CLIENT_SECRET,
    scope: CRM_SCOPE,
  });

  const { data } = await axios.post(CRM_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  crmTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

function crmHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Prefer: "return=representation",
  };
}

// ─── Validaciones ────────────────────────────────────────────────────────────
function validatePayload(body) {
  const errors = [];

  // Campos obligatorios
  if (!body.firstname?.trim())       errors.push("firstname es obligatorio");
  if (!body.lastname?.trim())        errors.push("lastname es obligatorio");
  if (!body.emailaddress1?.trim())   errors.push("emailaddress1 es obligatorio");
  if (!body.new_areadeinteresid)     errors.push("new_areadeinteresid es obligatorio");
  if (!body.new_programadeinteresid) errors.push("new_programadeinteresid es obligatorio");

  // Teléfono obligatorio solo en canal Web
  if (body.canal === "Web" && !body.mobilephone) {
    errors.push("mobilephone es obligatorio en canal Web");
  }

  // Formato nombre (solo letras, mínimo 3 chars)
  if (body.firstname && (
    body.firstname.trim().length < 3 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.firstname.trim())
  )) {
    errors.push("firstname: mínimo 3 letras, sin números ni caracteres especiales");
  }

  // Formato apellido (solo letras, mínimo 2 chars)
  if (body.lastname && (
    body.lastname.trim().length < 2 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.lastname.trim())
  )) {
    errors.push("lastname: mínimo 2 letras, sin números ni caracteres especiales");
  }

  // Formato email básico
  if (body.emailaddress1 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailaddress1)) {
    errors.push("emailaddress1: formato de correo inválido");
  }

  // Formato teléfono
  if (body.mobilephone) {
    const cleaned = body.mobilephone.replace(/[\s\-()]/g, "");
    if (!/^\+?[0-9]{7,15}$/.test(cleaned)) {
      errors.push("mobilephone: formato inválido (ej: +5491122334455)");
    }
  }

  return errors;
}

// ─── Buscar Lead por email ───────────────────────────────────────────────────
async function findLeadByEmail(email, token) {
  const url =
    `${CRM_BASE_URL}/leads` +
    `?$filter=emailaddress1 eq '${encodeURIComponent(email)}'` +
    `&$select=leadid,firstname,lastname,mobilephone,` +
    `_new_areadeinteresid_value,_new_programadeinteresid_value` +
    `&$top=1`;

  const { data } = await axios.get(url, { headers: crmHeaders(token) });
  return data.value?.[0] ?? null;
}

// ─── Construir body del Lead ─────────────────────────────────────────────────
function buildLeadBody(payload, existing = null) {
  const body = {
    firstname: payload.firstname.trim(),
    lastname: payload.lastname.trim(),
    emailaddress1: payload.emailaddress1.trim(),
  };

  // Teléfono: actualizar solo si el existente está vacío
  if (payload.mobilephone) {
    const cleaned = payload.mobilephone.replace(/[\s\-()]/g, "");
    if (!existing || !existing.mobilephone) {
      body.mobilephone = cleaned;
    }
  }

  if (payload.new_interesadoposgrado !== undefined) {
    body.new_interesadoposgrado = payload.new_interesadoposgrado;
  }

  if (payload.new_origencandidato) {
    body.new_origencandidato = payload.new_origencandidato;
  }

  if (payload.businessunit) {
    body.businessunit = payload.businessunit;
  }

  // ⚠️  new_facultaddeorigen: campo pendiente de verificar en Dynamics
  // Descomentar cuando se confirme el nombre exacto del campo en el CRM:
  // if (payload.new_facultaddeorigen && (!existing || !existing.new_facultaddeorigen)) {
  //   body.new_facultaddeorigen = payload.new_facultaddeorigen;
  // }

  // Lookups: no duplicar área ni programa en el Lead
  if (payload.new_areadeinteresid && (!existing || !existing._new_areadeinteresid_value)) {
    body["new_areadeinteresid@odata.bind"] = `/new_intereses(${payload.new_areadeinteresid})`;
  }

  if (payload.new_programadeinteresid && (!existing || !existing._new_programadeinteresid_value)) {
    body["new_programadeinteresid@odata.bind"] = `/new_carreras(${payload.new_programadeinteresid})`;
  }

  // Propietario
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }

  return body;
}

// ─── Construir body del Origen del cliente potencial ────────────────────────
function buildOrigenBody(payload, leadId) {
  const nombreCompleto = `${payload.firstname.trim()} ${payload.lastname.trim()}`;
  const tema = payload.new_tema || `Nueva Consulta - BOT - ${nombreCompleto}`;

  // Últimos 2000 caracteres de la conversación
  const consulta = payload.description
    ? payload.description.length > 2000
      ? payload.description.slice(-2000)
      : payload.description
    : undefined;

  const body = {
    new_tema: tema,
    "regardingobjectid_lead@odata.bind": `/leads(${leadId})`,
  };

  if (consulta)                       body.description = consulta;
  if (payload.new_origencandidato)    body.new_origencandidato = payload.new_origencandidato;

  if (payload.new_areadeinteresid) {
    body["new_areadeinteresid@odata.bind"] = `/new_intereses(${payload.new_areadeinteresid})`;
  }

  if (payload.new_programadeinteresid) {
    body["new_relacionclientecarrera@odata.bind"] = `/new_carreras(${payload.new_programadeinteresid})`;
  }

  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }

  if (payload.new_campanaid) {
    body["new_campanaid@odata.bind"] = `/campaigns(${payload.new_campanaid})`;
  }

  if (payload.new_actdecampanaid) {
    body["new_actdecampanaid@odata.bind"] = `/campaignactivities(${payload.new_actdecampanaid})`;
  }

  // UTMs
  const utmFields = [
    "new_utm_source", "new_utm_term", "new_utm_medium", "new_googleclickid",
    "new_utm_content", "new_campaignid", "new_utm_campaign", "new_sourceid",
  ];
  for (const field of utmFields) {
    if (payload[field]) body[field] = payload[field];
  }

  return body;
}

// ─── Operaciones CRM ─────────────────────────────────────────────────────────
async function createLead(body, token) {
  const { data, headers } = await axios.post(`${CRM_BASE_URL}/leads`, body, {
    headers: crmHeaders(token),
  });
  // El leadid viene en el body (Prefer: return=representation) o en el header
  return data?.leadid ?? headers["odata-entityid"]?.match(/\((.+)\)/)?.[1];
}

async function updateLead(leadId, body, token) {
  await axios.patch(`${CRM_BASE_URL}/leads(${leadId})`, body, {
    headers: crmHeaders(token),
  });
}

async function createOrigen(body, token) {
  const { data } = await axios.post(
    `${CRM_BASE_URL}/new_origenclientepotenciales`,
    body,
    { headers: crmHeaders(token) }
  );
  return data?.new_origenclientepotencialid;
}

// ─── Webhook principal ───────────────────────────────────────────────────────
app.post("/webhook/botmaker", async (req, res) => {
  console.log("\n============================================================");
  console.log("📨 [1/6] CONEXIÓN RECIBIDA DESDE BOTMAKER");
  console.log(`   Fecha/Hora : ${new Date().toLocaleString("es-AR")}`);
  console.log(`   IP origen  : ${req.ip}`);
  console.log("============================================================");

  // 1. Validar secret del webhook
  if (req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    console.error("❌ [AUTH] Webhook secret inválido – solicitud rechazada");
    return res.status(401).json({ ok: false, error: "Webhook secret inválido" });
  }
  console.log("✅ [AUTH] Webhook secret validado correctamente");

  const payload = req.body;

  // 2. Mostrar datos recibidos
  console.log("\n------------------------------------------------------------");
  console.log("📋 [2/6] DATOS RECIBIDOS DEL BOT:");
  console.log(`   Nombre       : ${payload.firstname} ${payload.lastname}`);
  console.log(`   Email        : ${payload.emailaddress1}`);
  console.log(`   Teléfono     : ${payload.mobilephone ?? "(no enviado)"}`);
  console.log(`   Canal        : ${payload.canal ?? "(no especificado)"}`);
  console.log(`   Área         : ${payload.new_areadeinteresid ?? "(no enviado)"}`);
  console.log(`   Programa     : ${payload.new_programadeinteresid ?? "(no enviado)"}`);
  console.log(`   Facultad     : ${payload.new_facultaddeorigen ?? "(no enviado)"}`);
  console.log(`   UTM Source   : ${payload.new_utm_source ?? "-"}`);
  console.log(`   UTM Campaign : ${payload.new_utm_campaign ?? "-"}`);
  console.log(`   Descripción  : ${payload.description ? payload.description.slice(0, 80) + "..." : "(vacía)"}`);
  console.log("------------------------------------------------------------");

  // 3. Validar payload
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    console.error("❌ [VALIDACIÓN] Campos inválidos o faltantes:");
    errors.forEach(e => console.error(`   • ${e}`));
    return res.status(422).json({ ok: false, errors });
  }
  console.log("✅ [VALIDACIÓN] Todos los campos obligatorios son correctos");

  try {
    // 4. Obtener token y buscar Lead
    console.log("\n------------------------------------------------------------");
    console.log("🔄 [3/6] ENVIANDO DATOS A DYNAMICS 365...");
    console.log(`   CRM URL : ${CRM_BASE_URL}`);

    const token = await getCrmToken();
    console.log("✅ [TOKEN] Autenticación con Azure AD exitosa");

    console.log(`   Buscando Lead con email: ${payload.emailaddress1.trim()}`);
    const existingLead = await findLeadByEmail(payload.emailaddress1.trim(), token);

    let leadId, leadAction;

    if (existingLead) {
      console.log(`   ⚠️  Lead YA EXISTE en CRM (ID: ${existingLead.leadid})`);
      console.log("   → Se actualizarán solo los campos vacíos (no se duplicará)");
      leadId = existingLead.leadid;
      const updateBody = buildLeadBody(payload, existingLead);
      console.log("   Campos a actualizar:", Object.keys(updateBody).join(", "));
      await updateLead(leadId, updateBody, token);
      leadAction = "updated";
    } else {
      console.log("   Lead NO encontrado → se creará uno nuevo");
      const createBody = buildLeadBody(payload);
      console.log("   Campos a enviar:", Object.keys(createBody).join(", "));
      leadId = await createLead(createBody, token);
      leadAction = "created";
    }

    console.log("   Creando registro Origen del cliente potencial...");
    const origenBody = buildOrigenBody(payload, leadId);
    const origenId = await createOrigen(origenBody, token);

    // 5. Confirmar recepción en Dynamics
    console.log("\n------------------------------------------------------------");
    console.log("📥 [4/6] DATOS RECIBIDOS Y GUARDADOS EN DYNAMICS 365:");
    console.log(`   Lead ID     : ${leadId}`);
    console.log(`   Acción Lead : ${leadAction === "created" ? "✅ CREADO" : "🔄 ACTUALIZADO"}`);
    console.log(`   Origen ID   : ${origenId}`);
    console.log("------------------------------------------------------------");

    // 6. Validación final
    console.log("\n------------------------------------------------------------");
    console.log("🔍 [5/6] VALIDACIÓN FINAL:");
    console.log(`   ✅ Lead ${leadAction === "created" ? "creado" : "actualizado"} correctamente`);
    console.log(`   ✅ Origen del cliente potencial registrado`);
    console.log(`   ✅ UTMs guardados: ${[
      payload.new_utm_source,
      payload.new_utm_medium,
      payload.new_utm_campaign
    ].filter(Boolean).join(" | ") || "ninguno"}`);
    console.log("------------------------------------------------------------");

    // 7. Confirmación final
    console.log("\n============================================================");
    console.log("🎉 [6/6] PROCESO COMPLETADO EXITOSAMENTE");
    console.log(`   Lead ${leadAction === "created" ? "creado" : "actualizado"}: ${leadId}`);
    console.log(`   Origen creado : ${origenId}`);
    console.log("============================================================\n");

    return res.status(200).json({
      ok: true,
      lead_action: leadAction,
      leadid: leadId,
      origen_id: origenId,
    });

  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("\n============================================================");
    console.error("💥 [ERROR] Fallo al comunicarse con Dynamics 365:");
    console.error("   ", JSON.stringify(detail, null, 2));
    console.error("============================================================\n");
    return res.status(502).json({ ok: false, error: "Error al comunicarse con el CRM", detail });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Botmaker→CRM bridge corriendo en puerto ${PORT}`));