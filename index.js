/**
 * API Bridge: Botmaker → CRM (Dynamics 365)
 * Universidad Austral
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
// ─── CORS para /url-tracking (llamado desde el browser de WordPress) ──────────
app.use("/url-tracking", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());


const {
  CRM_BASE_URL, CRM_TOKEN_URL, CRM_CLIENT_ID,
  CRM_CLIENT_SECRET, CRM_SCOPE, WEBHOOK_SECRET, PORT = 3000,
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
        contactId:    body.contactId,
        customerId:   body.customerId,
        sessionId,
      },
      processed:    false,
      processTimer: null,
      cleanupTimer: null,
    });
    console.log(`   🆕 Nueva sesión creada: ${sessionId}`);
  } else {
    console.log(`   🔄 Sesión existente: ${sessionId}`);
  }
  return sessions.get(sessionId);
}

function scheduleCleanup(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    console.log(`🧹 Sesión expirada y eliminada: ${sessionId}`);
    sessions.delete(sessionId);
  }, SESSION_TTL);
}

const REQUIRED_VARS = ["Nombre", "Mail"];

function hasRequiredVars(vars) {
  return REQUIRED_VARS.every(k => vars[k]?.trim());
}

// ─── GUID fijo del registro BOT en new_origen ────────────────────────────────
const ORIGEN_BOT_GUID = "4ed973c6-b5bc-ef11-a72e-002248dfb239";

// ─── Store URL-Tracking ───────────────────────────────────────────────────────
// Map<codigo, { url, creadoEn, cleanupTimer }>
const urlTrackingStore = new Map();
const URL_TRACKING_TTL = 48 * 60 * 60 * 1000; // 48h



function mapProgramaNombre(nombreBot) {
  if (!nombreBot?.trim()) return null;
  const mapped = PROGRAMA_MAPPER[nombreBot.trim()];
  if (!mapped) console.log(`   ⚠️  Programa "${nombreBot}" no encontrado en el mapper — se usará tal cual`);
  else         console.log(`   🗺️  Programa mapeado: "${nombreBot}" → "${mapped}"`);
  return mapped || nombreBot;
}

// ─── Parser de UTMs desde URL ─────────────────────────────────────────────────
function parseUTMs(url) {
  if (!url?.trim()) return {};
  try {
    const u = new URL(url);
    const result = {
      utm_source:   u.searchParams.get("utm_source")   || null,
      utm_medium:   u.searchParams.get("utm_medium")   || null,
      utm_campaign: u.searchParams.get("utm_campaign") || null,
      utm_term:     u.searchParams.get("utm_term")     || null,
      utm_content:  u.searchParams.get("utm_content")  || null,
      campaign_id:  u.searchParams.get("campaignid")   || null,
      gclid:        u.searchParams.get("gclid")        || null,
    };
    console.log(`   🔗 UTMs parseados desde URL:`);
    Object.entries(result).forEach(([k, v]) => { if (v) console.log(`      ${k}: ${v}`); });
    return result;
  } catch (e) {
    console.log(`   ⚠️  URL UTM inválida: ${url}`);
    return {};
  }
}

// ─── Cache del token CRM ──────────────────────────────────────────────────────
let crmTokenCache = { token: null, expiresAt: 0 };

async function getCrmToken() {
  if (crmTokenCache.token && Date.now() < crmTokenCache.expiresAt - 60_000) {
    console.log("   🔑 Token CRM desde caché");
    return crmTokenCache.token;
  }
  console.log("   🔑 Solicitando nuevo token a Azure AD...");
  const params = new URLSearchParams({
    grant_type: "client_credentials", client_id: CRM_CLIENT_ID,
    client_secret: CRM_CLIENT_SECRET, scope: CRM_SCOPE,
  });
  const { data } = await axios.post(CRM_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  crmTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  console.log("   ✅ Token obtenido correctamente");
  return data.access_token;
}

function crmHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
    "OData-MaxVersion": "4.0", "OData-Version": "4.0",
    Prefer: "return=representation",
  };
}

// ─── Buscar GUID de área por nombre ──────────────────────────────────────────
async function findAreaIdByName(name, token) {
  if (!name?.trim()) { console.log("   ⚠️  Área no enviada"); return null; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    console.log(`   ✅ Área ya es GUID: ${name}`); return name;
  }
  console.log(`   🔍 Buscando área por nombre: "${name}"`);
  try {
    const url = `${CRM_BASE_URL}/new_intereses?$filter=new_name eq '${encodeURIComponent(name)}'&$select=new_interesid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.new_interesid ?? null;
    if (id) console.log(`   ✅ Área encontrada → ID: ${id}`);
    else    console.log(`   ❌ Área "${name}" no encontrada en CRM`);
    return id;
  } catch (e) {
    console.error(`   💥 Error buscando área:`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Buscar GUID de carrera por nombre ───────────────────────────────────────
async function findCarreraIdByName(name, token) {
  if (!name?.trim()) { console.log("   ⚠️  Programa no enviado"); return null; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    console.log(`   ✅ Programa ya es GUID: ${name}`); return name;
  }
  console.log(`   🔍 Buscando programa por nombre: "${name}"`);
  try {
    const url = `${CRM_BASE_URL}/new_carreras?$filter=new_name eq '${encodeURIComponent(name)}'&$select=new_carreraid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.new_carreraid ?? null;
    if (id) console.log(`   ✅ Programa encontrado → ID: ${id}`);
    else    console.log(`   ❌ Programa "${name}" no encontrado en CRM`);
    return id;
  } catch (e) {
    console.error(`   💥 Error buscando programa:`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Buscar GUID de business unit (Facultad) por nombre ─────────────────────
async function findFacultadIdByName(name, token) {
  if (!name?.trim()) { console.log("   ⚠️  Facultad no enviada"); return null; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    console.log(`   ✅ Facultad ya es GUID: ${name}`); return name;
  }
  console.log(`   🔍 Buscando facultad (business unit) por nombre: "${name}"`);
  try {
    const url = `${CRM_BASE_URL}/businessunits?$filter=name eq '${encodeURIComponent(name)}'&$select=businessunitid,name&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.businessunitid ?? null;
    if (id) console.log(`   ✅ Facultad encontrada → ID: ${id}`);
    else    console.log(`   ❌ Facultad "${name}" no encontrada en CRM`);
    return id;
  } catch (e) {
    console.error(`   💥 Error buscando facultad:`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Buscar GUID de Campaña (campaign) por nombre ────────────────────────────
async function findCampanaIdByName(name, token) {
  if (!name?.trim()) { console.log("   ⚠️  Campaña no enviada"); return null; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    console.log(`   ✅ Campaña ya es GUID: ${name}`); return name;
  }
  console.log(`   🔍 Buscando campaña por nombre: "${name}"`);
  try {
    const url = `${CRM_BASE_URL}/campaigns?$filter=name eq '${encodeURIComponent(name)}'&$select=campaignid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.campaignid ?? null;
    if (id) console.log(`   ✅ Campaña encontrada → ID: ${id}`);
    else    console.log(`   ❌ Campaña "${name}" no encontrada en CRM`);
    return id;
  } catch (e) {
    console.error(`   💥 Error buscando campaña:`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Buscar GUID de Actividad de Campaña (campaignactivity) por subject ──────
async function findActividadCampanaIdByName(name, token) {
  if (!name?.trim()) { console.log("   ⚠️  Actividad de campaña no enviada"); return null; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    console.log(`   ✅ Actividad de campaña ya es GUID: ${name}`); return name;
  }
  console.log(`   🔍 Buscando actividad de campaña por nombre: "${name}"`);
  try {
    const url = `${CRM_BASE_URL}/campaignactivities?$filter=subject eq '${encodeURIComponent(name)}'&$select=activityid&$top=1`;
    const { data } = await axios.get(url, { headers: crmHeaders(token) });
    const id = data.value?.[0]?.activityid ?? null;
    if (id) console.log(`   ✅ Actividad de campaña encontrada → ID: ${id}`);
    else    console.log(`   ❌ Actividad de campaña "${name}" no encontrada en CRM`);
    return id;
  } catch (e) {
    console.error(`   💥 Error buscando actividad de campaña:`, e.response?.data ?? e.message);
    return null;
  }
}

// ─── Mapear variables al formato interno ─────────────────────────────────────
function mapVarsToPayload(vars, meta) {
  const canal    = "WhatsApp";
  const telefono = vars["Telefono"] || vars["Teléfono"] || meta.contactId || null;

  const programaBot =
    vars["ProgramaSeleccionado"] || vars["Programa ID"] ||
    vars["ProgramaID"] || vars["Programa Seleccionado"] || null;

  // ── Resolución de código de vinculación ──────────────────────────────────
  // 1) Desde variable dedicada CodigoWA
  // 2) Extraído del texto del campo UTM con formato "... | Código: UA-XXXX"
  const utmRaw = vars["UTM"] || vars["utm"] || "";
  const codigoDesdeTexto = utmRaw.match(/C[oó]digo:\s*([A-Z0-9\-]+)/i)?.[1] || null;

  const codigoVinculacion =
    codigoDesdeTexto ||                                        // 1° texto UTM (clic real en WordPress)
    vars["CodigoWA"] || vars["codigo_wa"] || vars["Codigo"] || null; // 2° variable dedicada

  if (codigoDesdeTexto) {
    console.log(`   🔎 Código extraído del texto UTM: ${codigoDesdeTexto}`);
  } else if (vars["CodigoWA"]) {
    console.log(`   🔎 Código desde variable CodigoWA: ${vars["CodigoWA"]}`);
  }

  let utmUrl = null;

  if (codigoVinculacion) {
    const tracked = urlTrackingStore.get(codigoVinculacion);
    if (tracked) {
      utmUrl = tracked.url;
      console.log(`   🔗 URL recuperada por código "${codigoVinculacion}": ${utmUrl}`);
    } else {
      console.log(`   ⚠️  Código "${codigoVinculacion}" no encontrado en el store`);
    }
  }

  // Fallback: variables de URL directas (comportamiento anterior)
  if (!utmUrl) {
    utmUrl =
      vars["URL"] || vars["url"] ||
      vars["landing_url"] || vars["UTM_URL"] || vars["Url"] || null;
    if (utmUrl) console.log(`   🔗 URL para UTMs encontrada en vars: ${utmUrl}`);
    else        console.log("   ⚠️  No se encontró URL ni código de vinculación");
  }

  const utms = parseUTMs(utmUrl);

  return {
    firstname:               vars["Nombre"]         || null,
    lastname:                vars["Apellido"]        || null,
    emailaddress1:           vars["Mail"] || vars["Email"] || null,
    mobilephone:             telefono,
    canal,
    new_areadeinteresnombre: vars["Area"] || vars["Area ID"] || vars["AreaID"] || null,
new_programanombre: programaBot || null,
    new_facultadnombre:      vars["Facultad"] || null,
    new_origencandidato:     26,
    new_interesadoposgrado:  true,
    initialcommunication:    1,
    new_detalleorigen:       "Bot",
    new_utm_source:          utms.utm_source   || vars["utm_source"]   || null,
    new_utm_medium:          utms.utm_medium   || vars["utm_medium"]   || null,
    new_utm_campaign:        utms.utm_campaign || vars["utm_campaign"] || null,
    new_utm_term:            utms.utm_term     || vars["utm_term"]     || null,
    new_utm_content:         utms.utm_content  || vars["utm_content"]  || null,
    new_googleclickid:       utms.gclid        || vars["gclid"]        || null,
    new_campaignid:          utms.campaign_id  || vars["campaign_id"]  || null,
    new_sourceid:            vars["source_id"] || null,
    new_tema:                vars["ProgramaSeleccionado"] || null,
    new_consulta:            meta.contactId
                               ? "https://go.botmaker.com/#/chats/" + meta.contactId
                               : vars["ReferralURL"] || utmUrl || null,
    // ── Nuevos campos ──
    new_campananombre:       vars["Campana"] || null,
    new_actdecampananombre:  vars["ActividadCampana"] || null,
  };
}

// ─── Validaciones ─────────────────────────────────────────────────────────────
function validatePayload(body) {
  const errors = [];
  if (!body.firstname?.trim())     errors.push("Nombre es obligatorio");
  if (!body.emailaddress1?.trim()) errors.push("Mail es obligatorio");
  if (body.firstname && (
    body.firstname.trim().length < 3 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.firstname.trim())
  )) errors.push("Nombre: mínimo 3 letras, sin números ni caracteres especiales");
  if (body.lastname && (
    body.lastname.trim().length < 2 ||
    !/^[A-Za-záéíóúÁÉÍÓÚüÜñÑ\s'-]+$/.test(body.lastname.trim())
  )) errors.push("Apellido: mínimo 2 letras, sin números ni caracteres especiales");
  if (body.emailaddress1 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailaddress1))
    errors.push("Mail: formato inválido");
  if (body.mobilephone) {
    const cleaned = body.mobilephone.replace(/[\s\-()]/g, "");
    if (!/^\+?[0-9]{7,15}$/.test(cleaned))
      errors.push("Teléfono: formato inválido");
  }
  return errors;
}

// ─── Buscar Lead por email ────────────────────────────────────────────────────
async function findLeadByEmail(email, token) {
  const url = `${CRM_BASE_URL}/leads?$filter=emailaddress1 eq '${encodeURIComponent(email)}'&$select=leadid,firstname,lastname,mobilephone&$top=1`;
  const { data } = await axios.get(url, { headers: crmHeaders(token) });
  return data.value?.[0] ?? null;
}

// ─── Construir bodies CRM ─────────────────────────────────────────────────────
function buildLeadBody(payload, existing = null) {
  const body = {
    firstname:              payload.firstname.trim(),
    emailaddress1:          payload.emailaddress1.trim(),
    new_interesadoposgrado: true,
    initialcommunication:   1,
    new_detalleorigen:      "Bot",
  };

  if (payload.lastname?.trim()) body.lastname = payload.lastname.trim();

  if (payload.mobilephone) {
    const cleaned = payload.mobilephone.replace(/[\s\-()]/g, "");
    if (!existing?.mobilephone) body.mobilephone = cleaned;
  }

  if (payload.new_origencandidato) body.new_origencandidato = payload.new_origencandidato;
  if (payload.new_utm_source)      body.new_utm_source      = payload.new_utm_source;
  if (payload.new_utm_medium)      body.new_utm_medium      = payload.new_utm_medium;
  if (payload.new_utm_campaign)    body.new_utm_campaign    = payload.new_utm_campaign;
  if (payload.new_utm_term)        body.new_utm_term        = payload.new_utm_term;
  if (payload.new_utm_content)     body.new_utm_content     = payload.new_utm_content;
  if (payload.new_googleclickid)   body.new_googleclickid   = payload.new_googleclickid;
  if (payload.new_campaignid)      body.new_campaignid      = payload.new_campaignid;
  if (payload.new_sourceid)        body.new_sourceid        = payload.new_sourceid;

  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }

  return body;
}

function buildInteresBody(payload, leadId, areaId) {
  const body = { "new_ClientePotencial@odata.bind": `/leads(${leadId})` };
  if (areaId) body["new_Interes@odata.bind"] = `/new_intereses(${areaId})`;
  return body;
}

function buildRelacionCarreraBody(payload, leadId, carreraId) {
  const body = { "new_clientepotencial@odata.bind": `/leads(${leadId})` };
  if (carreraId) body["new_carrera@odata.bind"] = `/new_carreras(${carreraId})`;
  return body;
}

function buildFacultadBody(leadId, facultadId, facultadNombre) {
  const body = {
    "new_clientepotencial@odata.bind": `/leads(${leadId})`,
    new_name: facultadNombre || "Sin facultad",
  };
  if (facultadId) body["new_unidaddenegocio@odata.bind"] = `/businessunits(${facultadId})`;
  return body;
}

// ─── Body Origen del Cliente Potencial (org_origen) ──────────────────────────
function buildOrigenBody(payload, leadId, areaId, carreraId, campanaId, actividadCampanaId) {
  const body = {
    subject: "Bot WhatsApp",
    "regardingobjectid_lead_org_origen@odata.bind": `/leads(${leadId})`,
    "new_clientepotencial_org_origen@odata.bind":   `/leads(${leadId})`,
    "new_origen_org_origen@odata.bind":             `/new_origens(${ORIGEN_BOT_GUID})`,
  };

  if (payload.new_tema)     body.new_tema    = payload.new_tema;
  if (payload.new_consulta) body.description = payload.new_consulta;

  if (areaId)    body["new_AreadeInteresId_org_origen@odata.bind"]     = `/new_intereses(${areaId})`;
  if (carreraId) body["new_ProgramadeInteresId_org_origen@odata.bind"] = `/new_carreras(${carreraId})`;
  if (campanaId) body["new_CampanaId@odata.bind"] = `/campaigns(${campanaId})`;
  // ⚠️  PENDIENTE: confirmar nombre exacto del campo con admin de Dynamics
  // if (actividadCampanaId) body["new_ActdeCampanaId@odata.bind"] = `/campaignactivities(${actividadCampanaId})`;

  if (payload.new_utm_source)    body.new_utm_source    = payload.new_utm_source;
  if (payload.new_utm_medium)    body.new_utm_medium    = payload.new_utm_medium;
  if (payload.new_utm_campaign)  body.new_utm_campaign  = payload.new_utm_campaign;
  if (payload.new_utm_term)      body.new_utm_term      = payload.new_utm_term;
  if (payload.new_utm_content)   body.new_utm_content   = payload.new_utm_content;
  if (payload.new_googleclickid) body.new_googleclickid = payload.new_googleclickid;
  if (payload.new_campaignid)    body.new_campaignid    = payload.new_campaignid;
  if (payload.new_sourceid)      body.new_sourceid      = payload.new_sourceid;

  return body;
}

// ─── Operaciones CRM ──────────────────────────────────────────────────────────
async function createLead(body, token) {
  const { data, headers } = await axios.post(`${CRM_BASE_URL}/leads`, body, { headers: crmHeaders(token) });
  return data?.leadid ?? headers["odata-entityid"]?.match(/\((.+)\)/)?.[1];
}

async function updateLead(leadId, body, token) {
  await axios.patch(`${CRM_BASE_URL}/leads(${leadId})`, body, { headers: crmHeaders(token) });
}

async function createInteresDelContacto(body, token) {
  const { data } = await axios.post(`${CRM_BASE_URL}/new_interesdelcontactos`, body, { headers: crmHeaders(token) });
  return data?.new_interesdelcontactoid;
}

async function createRelacionCarrera(body, token) {
  const { data } = await axios.post(`${CRM_BASE_URL}/new_relacionclientecarreras`, body, { headers: crmHeaders(token) });
  return data?.new_relacionclientecarreraid;
}

async function createFacultadOrigen(body, token) {
  const { data } = await axios.post(`${CRM_BASE_URL}/new_facultaddeorigens`, body, { headers: crmHeaders(token) });
  return data?.new_facultaddeorigenid;
}

async function createOrigenClientePotencial(body, token) {
  const { data } = await axios.post(`${CRM_BASE_URL}/org_origens`, body, { headers: crmHeaders(token) });
  return data?.activityid;
}

// ─── Procesar sesión en CRM ───────────────────────────────────────────────────
async function processSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.processed) return;
  session.processed = true;

  console.log("\n============================================================");
  console.log(`🚀 [PROCESANDO] Sesión: ${sessionId}`);
  console.log("============================================================");

  const payload = mapVarsToPayload(session.vars, session.meta);

  console.log("\n------------------------------------------------------------");
  console.log("📋 DATOS FINALES DEL BOT:");
  console.log(`   Nombre              : ${payload.firstname} ${payload.lastname ?? ""}`);
  console.log(`   Email               : ${payload.emailaddress1}`);
  console.log(`   Teléfono            : ${payload.mobilephone        ?? "(no enviado)"}`);
  console.log(`   Canal               : ${payload.canal}`);
  console.log(`   Área                : ${payload.new_areadeinteresnombre ?? "(no enviado)"}`);
  console.log(`   Programa            : ${payload.new_programanombre      ?? "(no enviado)"}`);
  console.log(`   Facultad            : ${payload.new_facultadnombre      ?? "(no enviado)"}`);
  console.log(`   Campaña             : ${payload.new_campananombre        ?? "(no enviado)"}`);
  console.log(`   Act. Campaña        : ${payload.new_actdecampananombre   ?? "(no enviado)"}`);
  console.log(`   Interesado Posgrado : ${payload.new_interesadoposgrado}`);
  console.log(`   Comunicación inicial: ${payload.initialcommunication} (Sin contacto)`);
  console.log(`   Detalle origen      : ${payload.new_detalleorigen}`);
  console.log(`   Origen (BOT)        : ${ORIGEN_BOT_GUID}`);
  console.log(`   UTM Source          : ${payload.new_utm_source          ?? "-"}`);
  console.log(`   UTM Medium          : ${payload.new_utm_medium          ?? "-"}`);
  console.log(`   UTM Camp.           : ${payload.new_utm_campaign        ?? "-"}`);
  console.log(`   UTM Term            : ${payload.new_utm_term            ?? "-"}`);
  console.log(`   UTM Cont.           : ${payload.new_utm_content         ?? "-"}`);
  console.log(`   GCLID               : ${payload.new_googleclickid       ?? "-"}`);
  console.log(`   Campaign ID         : ${payload.new_campaignid          ?? "-"}`);
  console.log(`   ReferralURL         : ${payload.new_consulta            ?? "-"}`);
  console.log("------------------------------------------------------------");

  const errors = validatePayload(payload);
  if (errors.length > 0) {
    session.processed = false;
    console.error("❌ [VALIDACIÓN] Errores encontrados:");
    errors.forEach(e => console.error(`   • ${e}`));
    return;
  }
  console.log("✅ [VALIDACIÓN] Datos correctos");

  try {
    console.log("\n------------------------------------------------------------");
    console.log("🔄 CONECTANDO CON DYNAMICS 365...");
    const token = await getCrmToken();

    console.log("\n------------------------------------------------------------");
    console.log("🔍 BUSCANDO REGISTROS EN CRM...");
    const areaId             = await findAreaIdByName(payload.new_areadeinteresnombre, token);
    const carreraId          = await findCarreraIdByName(payload.new_programanombre, token);
    const facultadId         = await findFacultadIdByName(payload.new_facultadnombre, token);
    const campanaId          = await findCampanaIdByName(payload.new_campananombre, token);
    const actividadCampanaId = await findActividadCampanaIdByName(payload.new_actdecampananombre, token);

    console.log("\n------------------------------------------------------------");
    console.log(`🔍 Buscando Lead con email: ${payload.emailaddress1.trim()}`);
    const existingLead = await findLeadByEmail(payload.emailaddress1.trim(), token);

    let leadId, leadAction;

    if (existingLead) {
      leadId = existingLead.leadid;
      console.log(`   ⚠️  Lead YA EXISTE (ID: ${leadId}) → actualizando campos`);
      await updateLead(leadId, buildLeadBody(payload, existingLead), token);
      leadAction = "updated";
    } else {
      console.log("   Lead NO encontrado → creando nuevo");
      leadId = await createLead(buildLeadBody(payload), token);
      leadAction = "created";
      console.log(`   ✅ Lead creado con ID: ${leadId}`);
    }

    // ─── Registros relacionados ───────────────────────────────────────────────
    let interesId = null, relacionId = null, facultadRelId = null, origenId = null;

    if (leadAction === "created") {
      console.log("\n------------------------------------------------------------");
      console.log("📎 CREANDO REGISTROS RELACIONADOS (lead nuevo)...");

      console.log("   Creando Interés del contacto (área)...");
      interesId = await createInteresDelContacto(buildInteresBody(payload, leadId, areaId), token);
      console.log(`   ✅ Interés creado: ${interesId ?? "(sin área)"}`);

      console.log("   Creando Relación cliente-carrera (programa)...");
      relacionId = await createRelacionCarrera(buildRelacionCarreraBody(payload, leadId, carreraId), token);
      console.log(`   ✅ Relación creada: ${relacionId ?? "(sin programa)"}`);

      console.log("   Creando Facultad de Origen...");
      facultadRelId = await createFacultadOrigen(
        buildFacultadBody(leadId, facultadId, payload.new_facultadnombre), token
      );
      console.log(`   ✅ Facultad creada: ${facultadRelId ?? "(sin facultad)"}`);

      console.log("   Creando Origen del Cliente Potencial...");
      origenId = await createOrigenClientePotencial(
        buildOrigenBody(payload, leadId, areaId, carreraId, campanaId, actividadCampanaId), token
      );
      console.log(`   ✅ Origen creado: ${origenId ?? "(error)"}`);

    } else {
      console.log("\n------------------------------------------------------------");
      console.log("📎 CREANDO ORIGEN para lead existente (sin tocar área/programa/facultad)...");

      origenId = await createOrigenClientePotencial(
        buildOrigenBody(payload, leadId, areaId, carreraId, campanaId, actividadCampanaId), token
      );
      console.log(`   ✅ Origen creado: ${origenId ?? "(error)"}`);
    }

    console.log("\n============================================================");
    console.log("🎉 PROCESO COMPLETADO EXITOSAMENTE");
    console.log(`   Lead      : ${leadAction === "created" ? "✅ CREADO" : "🔄 ACTUALIZADO"} → ${leadId}`);
    console.log(`   Interés   : ${interesId         ?? "(no aplica)"}`);
    console.log(`   Relación  : ${relacionId        ?? "(no aplica)"}`);
    console.log(`   Facultad  : ${facultadRelId     ?? "(no aplica)"}`);
    console.log(`   Origen    : ${origenId          ?? "(no aplica)"}`);
    console.log(`   Campaña   : ${campanaId         ?? "(no enviada)"}`);
    console.log(`   Act. Camp.: ${actividadCampanaId ?? "(no enviada)"}`);
    console.log("============================================================\n");

  } catch (err) {
    session.processed = false;
    const detail = err.response?.data ?? err.message;
    console.error("\n============================================================");
    console.error("💥 [ERROR CRM] Fallo al comunicarse con Dynamics 365:");
    console.error(JSON.stringify(detail, null, 2));
    console.error("============================================================\n");
  }
}

// ─── URL Tracking: WordPress registra el URL al hacer clic en WA ─────────────
app.post("/url-tracking", (req, res) => {
  const { url, codigo } = req.body;

  if (!url || !codigo) {
    return res.status(400).json({ ok: false, error: "url y codigo son obligatorios" });
  }

  const existing = urlTrackingStore.get(codigo);
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);

  const cleanupTimer = setTimeout(() => {
    urlTrackingStore.delete(codigo);
    console.log(`🧹 [URL-TRACKING] Código expirado: ${codigo}`);
  }, URL_TRACKING_TTL);

  urlTrackingStore.set(codigo, { url, creadoEn: new Date().toISOString(), cleanupTimer });
  console.log(`✅ [URL-TRACKING] Guardado: ${codigo} → ${url}`);

  return res.status(201).json({ ok: true, codigo });
});

// ─── Webhook principal ────────────────────────────────────────────────────────
app.post("/webhook/botmaker", async (req, res) => {
  console.log("\n============================================================");
  console.log("📨 MENSAJE RECIBIDO DE BOTMAKER");
  console.log(`   Fecha/Hora : ${new Date().toLocaleString("es-AR")}`);
  console.log(`   IP origen  : ${req.ip}`);
  console.log("============================================================");

  if (WEBHOOK_SECRET && req.headers["auth-bm-token"] !== WEBHOOK_SECRET) {
    console.error("❌ [AUTH] Token inválido – solicitud rechazada");
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
  console.log("✅ [AUTH] Token validado correctamente");

  console.log("\n📦 BODY COMPLETO RECIBIDO:");
  console.log(JSON.stringify(req.body, null, 2));

  const body      = req.body;
  const sessionId = body.sessionId || body.variables?.Mail || null;
  const newVars   = body.variables || {};

  if (!sessionId) {
    console.log("⚠️  Sin sessionId ni email — ignorando");
    return res.status(200).json({ ok: true, skipped: true, reason: "sin sessionId" });
  }

  if (!body.sessionId) {
    console.log(`   ⚠️  sessionId vacío — usando email como clave de sesión: ${sessionId}`);
  }

  const session = getOrCreateSession(sessionId, body);

  if (session.processed) {
    console.log("🔄 Nueva consulta del mismo contacto — reseteando sesión");
    session.processed = false;
    session.processTimer = null;
    session.vars = { ...newVars };
  } else {
    Object.assign(session.vars, newVars);
  }

  scheduleCleanup(sessionId);

  console.log("\n🔍 [DEBUG] Keys acumuladas en sesión:");
  Object.entries(session.vars).forEach(([k, v]) => console.log(`   "${k}": ${v}`));

  console.log(`\n📌 Sesión  : ${sessionId}`);
  console.log(`   Platform : ${body.chatPlatform ?? "(no especificado)"}`);

  const tieneRequeridos = hasRequiredVars(session.vars);
  if (!tieneRequeridos) {
    const faltantes = REQUIRED_VARS.filter(k => !session.vars[k]?.trim());
    console.log(`⏳ Variables requeridas faltantes: ${faltantes.join(", ")} — esperando más mensajes`);
    return res.status(200).json({ ok: true, skipped: true, reason: "variables incompletas", faltantes });
  }

  if (session.processTimer) {
    clearTimeout(session.processTimer);
    console.log("⏱️  Timer reiniciado — esperando 15s para acumular más variables");
  } else {
    console.log("⏱️  Timer iniciado — procesando en 15s");
  }

  session.processTimer = setTimeout(() => processSession(sessionId), PROCESS_DELAY);

  return res.status(200).json({ ok: true, queued: true, vars: session.vars });
});

// ─── DEBUG: listar URL-Tracking store ────────────────────────────────────────
app.get("/debug/url-tracking", (req, res) => {
  const entries = {};
  urlTrackingStore.forEach((val, key) => {
    entries[key] = { url: val.url, creadoEn: val.creadoEn };
  });
  res.json({ total: urlTrackingStore.size, entries });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status:      "ok",
  sessions:    sessions.size,
  urlTracking: urlTrackingStore.size,
}));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("============================================================");
  console.log(`🚀 Botmaker→CRM bridge corriendo en puerto ${PORT}`);
  console.log(`   CRM URL   : ${CRM_BASE_URL}`);
  console.log(`   Delay proc: ${PROCESS_DELAY / 1000}s`);
  console.log(`   TTL sesión: ${SESSION_TTL / 60000}min`);
  console.log(`   TTL URL   : ${URL_TRACKING_TTL / 3600000}h`);
  console.log("============================================================");
});