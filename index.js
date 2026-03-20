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
const SESSION_TTL = 30 * 60 * 1000;
const PROCESS_DELAY = 15 * 1000;

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
      processTimer: null,
      cleanupTimer: null,
    });
  }
  return sessions.get(sessionId);
}

function scheduleCleanup(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    console.log(`🧹 Sesión expirada: ${sessionId}`);
    sessions.delete(sessionId);
  }, SESSION_TTL);
}

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

// ─── Buscar GUID de área por nombre ─────────────────────────────────────────
async function findAreaIdByName(name, token) {
  if (!name?.trim()) return null;
  // Si ya es un GUID válido lo devolvemos directamente
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  try {
    const url = `${CRM_BASE_URL}/new_intereses?$filter=new_name eq '${encodeURIComponent(name)}'&$select=new_interesid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.new_interesid ?? null;
    console.log(`   🔍 Área "${name}" → ${id ?? "no encontrada"}`);
    return id;
  } catch (e) {
    console.error(`   ⚠️ Error buscando área "${name}":`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Buscar GUID de carrera por nombre ──────────────────────────────────────
async function findCarreraIdByName(name, token) {
  if (!name?.trim()) return null;
  // Si ya es un GUID válido lo devolvemos directamente
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  try {
    const url = `${CRM_BASE_URL}/new_carreras?$filter=new_name eq '${encodeURIComponent(name)}'&$select=new_carreraid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.new_carreraid ?? null;
    console.log(`   🔍 Carrera "${name}" → ${id ?? "no encontrada"}`);
    return id;
  } catch (e) {
    console.error(`   ⚠️ Error buscando carrera "${name}":`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Mapear variables acumuladas al formato interno ──────────────────────────
function mapVarsToPayload(vars, meta) {
  const canal = meta.chatPlatform === "whatsapp" ? "WhatsApp" : "Web";
  const telefono = canal === "WhatsApp"
    ? meta.contactId
    : vars["Telefono"] || vars["Teléfono"] || null;

  return {
    firstname:               vars["Nombre"]               || null,
    lastname:                vars["Apellido"]             || null,
    emailaddress1:           vars["Mail"]                 || vars["Email"] || null,
    mobilephone:             telefono,
    canal,
    new_areadeinteresnombre: vars["Area"]                 || vars["Area ID"] || vars["AreaID"] || null,
    new_programanombre:      vars["ProgramaSeleccionado"] || vars["Programa ID"] || vars["ProgramaID"] || vars["Programa Seleccionado"] || null,
    new_utm_source:          vars["utm_source"]           || null,
    new_utm_medium:          vars["utm_medium"]           || null,
    new_utm_campaign:        vars["utm_campaign"]         || null,
    new_utm_term:            vars["utm_term"]             || null,
    new_utm_content:         vars["utm_content"]          || null,
    new_googleclickid:       vars["gclid"]                || null,
    new_sourceid:            vars["source_id"]            || null,
    new_campaignid:          vars["campaign_id"]          || null,
    new_origencandidato:     vars["origen_candidato"]     || null,
    description:             vars["Consulta"]             || null,
  };
}

// ─── Validaciones ────────────────────────────────────────────────────────────
function validatePayload(body) {
  const errors = [];
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
  if (payload.lastname?.trim()) body.lastname = payload.lastname.trim();
  if (payload.mobilephone) {
    const cleaned = payload.mobilephone.replace(/[\s\-()]/g, "");
    if (!existing || !existing.mobilephone) body.mobilephone = cleaned;
  }
  if (payload.new_origencandidato) body.new_origencandidato = payload.new_origencandidato;
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Construir body del Interés del contacto (área) ─────────────────────────
function buildInteresBody(payload, leadId, areaId) {
  const body = {
    "new_ClientePotencial@odata.bind": `/leads(${leadId})`,
  };
  if (areaId) {
    body["new_Interes@odata.bind"] = `/new_intereses(${areaId})`;
  }
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Construir body de Relación cliente carrera (programa) ──────────────────
function buildRelacionCarreraBody(payload, leadId, carreraId) {
  const body = {
    "new_clientepotencial@odata.bind": `/leads(${leadId})`,
  };
  if (carreraId) {
    body["new_carrera@odata.bind"] = `/new_carreras(${carreraId})`;
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

// ─── Procesar sesión en CRM ──────────────────────────────────────────────────
async function processSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.processed) return;

  session.processed = true;
  const payload = mapVarsToPayload(session.vars, session.meta);

  console.log(`\n🚀 PROCESANDO SESIÓN: ${sessionId}`);
  console.log(`   Variables finales : ${JSON.stringify(session.vars)}`);
  console.log(`   Nombre    : ${payload.firstname} ${payload.lastname ?? "(sin apellido)"}`);
  console.log(`   Email     : ${payload.emailaddress1}`);
  console.log(`   Teléfono  : ${payload.mobilephone ?? "(no enviado)"}`);
  console.log(`   Canal     : ${payload.canal}`);
  console.log(`   Área      : ${payload.new_areadeinteresnombre ?? "(no enviado)"}`);
  console.log(`   Programa  : ${payload.new_programanombre ?? "(no enviado)"}`);
  console.log(`   UTM Source: ${payload.new_utm_source ?? "-"}`);

  const errors = validatePayload(payload);
  if (errors.length > 0) {
    session.processed = false;
    console.error("❌ [VALIDACIÓN]:", errors);
    return;
  }

  try {
    const token = await getCrmToken();

    // Resolver nombres a GUIDs
    const areaId = await findAreaIdByName(payload.new_areadeinteresnombre, token);
    const carreraId = await findCarreraIdByName(payload.new_programanombre, token);

    console.log(`   ✅ Área ID   : ${areaId ?? "(no encontrada)"}`);
    console.log(`   ✅ Carrera ID: ${carreraId ?? "(no encontrada)"}`);

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

    const interesId = await createInteresDelContacto(buildInteresBody(payload, leadId, areaId), token);
    const relacionId = await createRelacionCarrera(buildRelacionCarreraBody(payload, leadId, carreraId), token);

    console.log("\n============================================================");
    console.log("🎉 PROCESO COMPLETADO");
    console.log(`   Lead ${leadAction === "created" ? "CREADO" : "ACTUALIZADO"}: ${leadId}`);
    console.log(`   Interés  : ${interesId ?? "(no creado)"}`);
    console.log(`   Relación : ${relacionId ?? "(no creado)"}`);
    console.log("============================================================\n");

  } catch (err) {
    session.processed = false;
    const detail = err.response?.data ?? err.message;
    console.error("💥 [ERROR CRM]:", JSON.stringify(detail, null, 2));
  }
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

  // ─── DEBUG BODY COMPLETO ──────────────────────────────────────────────────
  console.log("=== BODY COMPLETO ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=== FIN BODY ===");
  // ─────────────────────────────────────────────────────────────────────────

  const body = req.body;
  const sessionId = body.sessionId;
  const newVars = body.variables || {};

  if (!sessionId) {
    return res.status(200).json({ ok: true, skipped: true, reason: "sin sessionId" });
  }

  const session = getOrCreateSession(sessionId, body);
  Object.assign(session.vars, newVars);
  scheduleCleanup(sessionId);

  console.log(`📌 Sesión  : ${sessionId}`);
  console.log(`   Vars    : ${JSON.stringify(session.vars)}`);

  if (session.processed) {
    console.log("✅ Sesión ya procesada — ignorando");
    return res.status(200).json({ ok: true, skipped: true, reason: "ya procesado" });
  }

  if (!hasRequiredVars(session.vars)) {
    console.log("⏳ Esperando más variables...");
    return res.status(200).json({ ok: true, skipped: true, reason: "variables incompletas" });
  }

  if (session.processTimer) {
    clearTimeout(session.processTimer);
    console.log("⏱️  Timer reiniciado — esperando 15s para acumular más variables");
  } else {
    console.log("⏱️  Timer iniciado — procesando en 15s si no llegan más variables");
  }

  session.processTimer = setTimeout(() => {
    processSession(sessionId);
  }, PROCESS_DELAY);

  return res.status(200).json({ ok: true, queued: true, vars: session.vars });
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok",
  sessions: sessions.size,
}));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Botmaker→CRM bridge corriendo en puerto ${PORT}`));