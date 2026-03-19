/**
 * API Bridge: Botmaker → CRM (Dynamics 365)
 * Universidad Austral
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  CRM_BASE_URL,
  CRM_TOKEN_URL,
  CRM_CLIENT_ID,
  CRM_CLIENT_SECRET,
  CRM_SCOPE,
  WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

// ─── Acumulador de sesiones ───────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos

function getOrCreateSession(sessionId, body) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      vars: {},
      meta: {
        chatPlatform: body.chatPlatform,
        contactId: body.contactId,
        customerId: body.customerId,
        sessionId,
      },
      processed: false,
      timer: null,
    });
  }
  return sessions.get(sessionId);
}

function scheduleSessionCleanup(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    console.log(`🧹 Sesión expirada: ${sessionId}`);
    sessions.delete(sessionId);
  }, SESSION_TTL);
}

// Variables mínimas para disparar el proceso
const REQUIRED_VARS = ["Nombre", "Mail"];

function hasRequiredVars(vars) {
  return REQUIRED_VARS.every(k => vars[k]?.trim());
}

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

// ─── Mapear variables acumuladas al formato interno ──────────────────────────
function mapVarsToPayload(vars, meta) {
  const canal = meta.chatPlatform === "whatsapp" ? "WhatsApp" : "Web";
  const telefono = canal === "WhatsApp"
    ? meta.contactId
    : vars["Telefono"] || vars["Teléfono"] || null;

  return {
    firstname:               vars["Nombre"]             || null,
    lastname:                vars["Apellido"]           || null,
    emailaddress1:           vars["Mail"]               || vars["Email"] || null,
    mobilephone:             telefono,
    canal,
    new_areadeinteresid:     vars["Area ID"]            || vars["AreaID"] || null,
    new_programadeinteresid: vars["Programa ID"]        || vars["ProgramaID"] || vars["Programa Seleccionado"] || null,
    new_utm_source:          vars["utm_source"]         || null,
    new_utm_medium:          vars["utm_medium"]         || null,
    new_utm_campaign:        vars["utm_campaign"]       || null,
    new_utm_term:            vars["utm_term"]           || null,
    new_utm_content:         vars["utm_content"]        || null,
    new_googleclickid:       vars["gclid"]              || null,
    new_sourceid:            vars["source_id"]          || null,
    new_campaignid:          vars["campaign_id"]        || null,
    new_origencandidato:     vars["origen_candidato"]   || null,
    description:             vars["Consulta"]           || null,
  };
}

// ─── Validaciones ────────────────────────────────────────────────────────────
function validatePayload(body) {
  const errors = [];

  // Solo bloqueamos si firstname o email vienen con formato incorrecto
  if (!body.firstname?.trim()) errors.push("firstname es obligatorio");
  if (!body.emailaddress1?.trim()) errors.push("emailaddress1 es obligatorio");

  if (body.firstname && (
    body.firstname.trim().length < 3 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.firstname.trim())
  )) {
    errors.push("firstname: mínimo 3 letras, sin números ni caracteres especiales");
  }
  if (body.lastname && (
    body.lastname.trim().length < 2 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.lastname.trim())
  )) {
    errors.push("lastname: mínimo 2 letras, sin números ni caracteres especiales");
  }
  if (body.emailaddress1 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailaddress1)) {
    errors.push("emailaddress1: formato de correo inválido");
  }
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
    `&$select=leadid,firstname,lastname,mobilephone` +
    `&$top=1`;
  const { data } = await axios.get(url, { headers: crmHeaders(token) });
  return data.value?.[0] ?? null;
}

// ─── Construir body del Lead ─────────────────────────────────────────────────
function buildLeadBody(payload, existing = null) {
  const body = {
    firstname: payload.firstname.trim(),
    emailaddress1: payload.emailaddress1.trim(),
  };

  // Apellido solo si viene
  if (payload.lastname?.trim()) {
    body.lastname = payload.lastname.trim();
  }

  if (payload.mobilephone) {
    const cleaned = payload.mobilephone.replace(/[\s\-()]/g, "");
    if (!existing || !existing.mobilephone) body.mobilephone = cleaned;
  }
  if (payload.new_origencandidato) {
    body.new_origencandidato = payload.new_origencandidato;
  }
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Construir body del Interés del contacto (área) ─────────────────────────
function buildInteresBody(payload, leadId) {
  const body = { "new_clientepotencial@odata.bind": `/leads(${leadId})` };
  if (payload.new_areadeinteresid) {
    body["new_interes@odata.bind"] = `/new_intereses(${payload.new_areadeinteresid})`;
  }
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Construir body de Relación cliente carrera (programa) ──────────────────
function buildRelacionCarreraBody(payload, leadId) {
  const body = { "new_clientepotencial@odata.bind": `/leads(${leadId})` };
  if (payload.new_programadeinteresid) {
    body["new_carrera@odata.bind"] = `/new_carreras(${payload.new_programadeinteresid})`;
  }
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Operaciones CRM ─────────────────────────────────────────────────────────
async function createLead(body, token) {
  const { data, headers } = await axios.post(`${CRM_BASE_URL}/leads`, body, {
    headers: crmHeaders(token),
  });
  return data?.leadid ?? headers["odata-entityid"]?.match(/\((.+)\)/)?.[1];
}

async function updateLead(leadId, body, token) {
  await axios.patch(`${CRM_BASE_URL}/leads(${leadId})`, body, {
    headers: crmHeaders(token),
  });
}

async function createInteresDelContacto(body, token) {
  const { data } = await axios.post(
    `${CRM_BASE_URL}/new_interesdelcontactos`, body, { headers: crmHeaders(token) }
  );
  return data?.new_interesdelcontactoid;
}

async function createRelacionCarrera(body, token) {
  const { data } = await axios.post(
    `${CRM_BASE_URL}/new_relacionclientecarreras`, body, { headers: crmHeaders(token) }
  );
  return data?.new_relacionclientecarreraid;
}

// ─── Webhook principal ───────────────────────────────────────────────────────
app.post("/webhook/botmaker", async (req, res) => {
  console.log("\n============================================================");
  console.log("📨 MENSAJE RECIBIDO DE BOTMAKER");
  console.log(`   Fecha/Hora : ${new Date().toLocaleString("es-AR")}`);
  console.log("============================================================");

  // Auth
  if (WEBHOOK_SECRET && req.headers["auth-bm-token"]) {
    if (req.headers["auth-bm-token"] !== WEBHOOK_SECRET) {
      console.error("❌ [AUTH] Token inválido");
      return res.status(401).json({ ok: false, error: "Token inválido" });
    }
  }

  const body = req.body;
  const sessionId = body.sessionId;
  const newVars = body.variables || {};

  if (!sessionId) {
    return res.status(200).json({ ok: true, skipped: true, reason: "sin sessionId" });
  }

  // Acumular variables
  const session = getOrCreateSession(sessionId, body);
  Object.assign(session.vars, newVars);
  scheduleSessionCleanup(sessionId);

  console.log(`📌 Sesión  : ${sessionId}`);
  console.log(`   Vars    : ${JSON.stringify(session.vars)}`);

  // Si ya fue procesada esta sesión no volver a procesar
  if (session.processed) {
    console.log("✅ Sesión ya procesada — ignorando");
    return res.status(200).json({ ok: true, skipped: true, reason: "ya procesado" });
  }

  // Esperar hasta tener Nombre y Mail como mínimo
  if (!hasRequiredVars(session.vars)) {
    console.log("⏳ Esperando más variables...");
    return res.status(200).json({ ok: true, skipped: true, reason: "variables incompletas" });
  }

  // Marcar como procesada
  session.processed = true;

  const payload = mapVarsToPayload(session.vars, session.meta);

  console.log("\n📋 DATOS PARA CRM:");
  console.log(`   Nombre    : ${payload.firstname} ${payload.lastname ?? "(sin apellido)"}`);
  console.log(`   Email     : ${payload.emailaddress1}`);
  console.log(`   Teléfono  : ${payload.mobilephone ?? "(no enviado)"}`);
  console.log(`   Canal     : ${payload.canal}`);
  console.log(`   Área ID   : ${payload.new_areadeinteresid ?? "(no enviado)"}`);
  console.log(`   Programa  : ${payload.new_programadeinteresid ?? "(no enviado)"}`);

  const errors = validatePayload(payload);
  if (errors.length > 0) {
    session.processed = false;
    console.error("❌ [VALIDACIÓN]:", errors);
    return res.status(422).json({ ok: false, errors });
  }
  console.log("✅ [VALIDACIÓN] OK");

  try {
    const token = await getCrmToken();
    console.log("✅ [TOKEN] Azure AD OK");

    const existingLead = await findLeadByEmail(payload.emailaddress1.trim(), token);
    let leadId, leadAction;

    if (existingLead) {
      console.log(`   ⚠️  Lead YA EXISTE (ID: ${existingLead.leadid}) → actualizando`);
      leadId = existingLead.leadid;
      await updateLead(leadId, buildLeadBody(payload, existingLead), token);
      leadAction = "updated";
    } else {
      console.log("   Lead NO encontrado → creando");
      leadId = await createLead(buildLeadBody(payload), token);
      leadAction = "created";
    }

    console.log("   Creando Interés del contacto...");
    const interesId = await createInteresDelContacto(buildInteresBody(payload, leadId), token);

    console.log("   Creando Relación cliente carrera...");
    const relacionId = await createRelacionCarrera(buildRelacionCarreraBody(payload, leadId), token);

    console.log("\n============================================================");
    console.log("🎉 PROCESO COMPLETADO");
    console.log(`   Lead ${leadAction === "created" ? "CREADO" : "ACTUALIZADO"}: ${leadId}`);
    console.log(`   Interés  : ${interesId ?? "(no creado)"}`);
    console.log(`   Relación : ${relacionId ?? "(no creado)"}`);
    console.log("============================================================\n");

    return res.status(200).json({
      ok: true,
      lead_action: leadAction,
      leadid: leadId,
      interes_id: interesId,
      relacion_id: relacionId,
    });

  } catch (err) {
    session.processed = false;
    const detail = err.response?.data ?? err.message;
    console.error("💥 [ERROR CRM]:", JSON.stringify(detail, null, 2));
    return res.status(502).json({ ok: false, error: "Error al comunicarse con el CRM", detail });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  sessions: sessions.size,
}));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Botmaker→CRM bridge corriendo en puerto ${PORT}`));