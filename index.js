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

// ─── Mapper: Nombre Botmaker → Nombre CRM ────────────────────────────────────
const PROGRAMA_MAPPER = {
  "Doctorado en Derecho": "Doctorado en Derecho (Sede Buenos Aires)",
  "Maestría en Derecho LL.M.": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Maestría en Derecho LL.M. con Orientación en Derecho Electoral": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Certificación Internacional en Management Legal": "Programa de Certificación Internacional en Management Legal (Sede Buenos Aires)",
  "Diplomatura en LegalTech Avanzado": "Diplomatura en LegalTech Avanzado 2025 (Sede Buenos Aires)",
  "Diplomatura en Teoría del Derecho y de la Argumentación Jurídica": "Programa de Presentaciones Persuasivas (Sede Buenos Aires)",
  "Programa de Derecho y Startups": "Programa Derecho y Start-Ups (Sede Buenos Aires)",
  "Programa ejecutivo de Inteligencia Artificial Generativa": "Programa Ejecutivo - Inteligencia Artificial Generativa para la Práctica Profesional. Chat - GPT y Gemini (Sede Buenos Aires)",
  "Programa internacional de Derecho de Impacto": "Programa Derecho de Triple Impacto (Sede Buenos Aires)",
  "Programa Internacional de Privacidad de Datos": "Programa Internacional en Privacidad de Datos - Alumni FD (Sede Buenos Aires)",
  "Programa Internacional sobre Neurociencias y Derecho": "Programa Internacional: Neurociencias y Derecho (Sede Buenos Aires)",
  "Programa LegalTech": "Programa El Abogado del Futuro: Legaltech y la Transformación Digital del Derecho (Sede Buenos Aires)",
  "Curso Internacional Arbitraje Societario": "Curso de Arbitraje Societario (Sede Buenos Aires)",
  "Diplomatura en Arbitraje Comercial y de Inversiones": "Diplomatura en Arbitraje Comercial y de Inversiones - DArb (Sede Buenos Aires)",
  "Maestría en Derecho LL.M. con orientación en Arbitraje, Litigios y Contratos Internacionales": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Programa Derecho de la Construcción": "Programa Derecho de la Construcción (Sede Buenos Aires)",
  "Diplomado Post-Magistral en Derecho Administrativo Profundizado": "Diplomado Post-Magistral en Derecho Administrativo Profundizado - DDA (Sede Buenos Aires)",
  "Diplomatura en Derecho de los Hidrocarburos y de la Energía": "Diplomatura en Derecho de los Hidrocarburos - DDA (Sede Buenos Aires)",
  "Diplomatura en Derecho Sanitario": "Diplomatura en Derecho Sanitario (Sede Buenos Aires)",
  "Especialización en Contrataciones Públicas": "Especialización en Contrataciones Públicas - MD (Sede Buenos Aires)",
  "Maestría en Derecho Administrativo": "Maestría en Derecho Administrativo - MD (Sede Buenos Aires)",
  "Curso de Latín II": "Curso de Latín II (Sede Buenos Aires)",
  "Curso Latín I": "Curso de Latín I (Sede Buenos Aires)",
  "Diplomatura en Contratos y Litigios Judiciales Internacionales": "Diplomatura en Contratos y Litigios Judiciales Internacionales - DDC (Sede Buenos Aires)",
  "Diplomatura en Derecho Privado Patrimonial": "Diplomatura en Derecho Privado Patrimonial - DDC (Sede Buenos Aires)",
  "Maestría en Derecho Civil": "Maestría en Derecho Civil (Sede Buenos Aires)",
  "Programa de Derecho de Consumo Inmobiliario": "Programa Derecho de Consumo Inmobiliario (Sede Buenos Aires)",
  "Programa de Planificación Económica Familiar": "Programa en Planificación Económica Familiar (Sede Buenos Aires)",
  "Programa de Técnicas para la Redacción de Contratos y Dictámenes Jurídicos": "Programa de Técnicas para la Redacción de Contratos y Dictámenes Jurídicos - DDC (Sede Buenos Aires)",
  "Seminario de Historia de Roma": "Seminario de Historia de Roma - DDC - CIDR (Sede Buenos Aires)",
  "Diplomatura en Derecho Constitucional Latinoamericano": "Diplomatura en Derecho Constitucional Latinoamericano - DFDDC (Sede Buenos Aires)",
  "Diplomatura en Derecho Constitucional Profundizado": "Diplomatura en Derecho Constitucional Profundizado - DFD (Sede Buenos Aires)",
  "Diplomatura en Derecho Procesal Constitucional": "Diplomatura en Derecho Procesal Constitucional - DFD (Sede Buenos Aires)",
  "Maestría en Derecho LL.M. con Orientación en Derecho Constitucional": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Programa de Derecho de Propiedad en la Constitución": "Programa Derecho de la Propiedad en la Constitución (Sede Buenos Aires)",
  "Programa de Historia de la Corte Suprema de Justicia de la Nación y su Jurisprudencia": "Programa de Historia de la Corte Suprema y su Jurisprudencia (Sede Buenos Aires)",
  "Semana Internacional de Diplomatura en Derecho Constitucional Latinoamericano": "Semana Internacional DDCL 2025 (Sede Buenos Aires)",
  "Diplomatura en Derecho del Deporte": "CDD - Diplomatura en Derecho del Deporte (Sede Buenos Aires)",
  "Maestría en Derecho LL.M. con Orientación en Derecho del Deporte": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Curso sobre Normas Principios y Derechos Fundamentales del Trabajo": "Curso sobre Normas Principios y Derechos Fundamentales del Trabajo (Sede Buenos Aires)",
  "Diplomatura en Derecho del Trabajo y Relaciones Laborales": "Diplomatura en Derecho del Trabajo y Relaciones Laborales - DDTr. (Sede Buenos Aires)",
  "Maestría en Derecho del Trabajo y Relaciones Laborales": "Maestría en Derecho del Trabajo y Relaciones Laborales - MD (Sede Buenos Aires)",
  "Curso de Fusiones y adquisiciones de empresas": "Fusiones y Adquisiciones de Empresas. Oportunidades y Desafíos Globales 2025 (Sede Buenos Aires)",
  "Diplomatura en Derecho Bancario y Mercado de Capitales": "Diplomatura en Derecho Bancario y Mercado de Capitales (Sede Buenos Aires)",
  "Maestría en Derecho Empresario": "Maestría en Derecho Empresario (Sede Buenos Aires)",
  "Maestría en Derecho Empresario Global": "Maestría en Derecho Empresario Global - MD (Sede Buenos Aires)",
  "Programa de Blockchain e Inteligencia artificial en el Derecho Empresario": "Programa Blockchain, Derecho y Empresa - DDE (Sede Buenos Aires)",
  "Programa de Derecho Societario Actual": "Programa de Derecho Societario Actual - DDE (Sede Buenos Aires)",
  "Programa de Régimen Jurídico de los Agronegocios": "Programa de Régimen Jurídico de los Agronegocios - DDE (Sede Buenos Aires)",
  "Diplomatura en Derechos Humanos": "Diplomatura en Derechos Humanos - DFD (Sede Buenos Aires)",
  "Maestría en Magistratura y Derecho Judicial": "Maestría en Magistratura y Derecho Judicial - MD (Sede Buenos Aires)",
  "Maestría en Magistratura y Derecho Judicial Internacional": "Maestría en Magistratura y Derecho Judicial - MD (Sede Buenos Aires)",
  "Programa de Gestión Judicial Efectiva": "Programa Gestión Judicial Efectiva - Inteligencia Artificial y Justicia 4.0 (Sede Buenos Aires)",
  "Curso de Inteligencia artificial en el proceso penal": "Inteligencia Artificial en el Proceso Penal (Sede Buenos Aires)",
  "Diplomatura en Derecho Penal Económico": "Diplomatura en Derecho Penal Económico (Sede Buenos Aires)",
  "Diplomatura en Litigación Penal": "Diplomatura en Litigación Penal - DDP (Sede Buenos Aires)",
  "Diplomatura Internacional en Ciberdelincuencia y Tecnologías Aplicadas a la Investigación": "Diplomatura Internacional en Ciberdelincuencia y Tecnologías Aplicadas a la Investigación - DDP (Sede Buenos Aires)",
  "Maestría en Derecho LL.M. con orientación Internacional en Ciberdelincuencia y tecnologías aplicadas a la investigación": "Maestría en Derecho - MD (Sede Buenos Aires)",
  "Maestría en Derecho Penal": "Maestría en Derecho Penal (Sede Buenos Aires)",
  "Diplomatura en Estudio del Código Procesal Civil Adversarial de la Provincia del Neuquén": "Diplomatura Estudio del Código Procesal Civil Adversarial de la Provincia del Neuquén (Sede Buenos Aires)",
  "Maestría en Derecho Procesal": "Maestría en Derecho Procesal (Sede Buenos Aires)",
  "Curso de Contabilidad para Abogados": "Curso Online de Contabilidad para Abogados - DDT (Sede Buenos Aires)",
  "Curso de Fiscalidad de la Economía Digitalizada y las Tecnologías Emergentes": "Curso de Fiscalidad de la Economía Digitalizada y las Tecnologías Emergentes (Sede Buenos Aires)",
  "Curso Intensivo de Derecho Tributario Internacional": "Curso Intensivo en Derecho Internacional Tributario (Sede Buenos Aires)",
  "Diplomatura en Derecho Aduanero": "Diplomatura en Derecho Aduanero - DDT (Sede Buenos Aires)",
  "Diplomatura en Precios de Transferencia en Latinoamérica": "Diplomatura en Precios de Transferencia (Sede Buenos Aires)",
  "Diplomatura Regional en Asesoramiento Tributario": "Diplomatura Regional en Asesoramiento Tributario - DDT (Sede Buenos Aires)",
  "Maestría en Derecho Tributario": "Maestría en Derecho Tributario (Sede Buenos Aires)",
  "Programa de Actualización en Derecho Tributario": "Curso de Actualización en Derecho Tributario (Sede Buenos Aires)",
  "Workshop de Jurisprudencia Tributaria": "Taller de Jurisprudencia Tributaria - DDT (Sede Buenos Aires)",
  "Programa Plain English Skills for Lawyers": "Programa Plain English Skills for Lawyers - ADL (Sede Buenos Aires)",
  "Programa Practical & Intensive Course in Legal English": "Programa Practical & Intensive Course in Legal English (Sede Buenos Aires)",
  "Workshop Contract Drafting": "Workshop on Contract Drafting (Sede Buenos Aires)",
  "Diplomatura en Propiedad Intelectual": "Diplomatura en Propiedad Intelectual - CPI (Sede Buenos Aires)",
  "Maestría en Propiedad Intelectual y Nuevas Tecnologías": "Maestría en Propiedad Intelectual y Nuevas Tecnologías - MD (Sede Buenos Aires)",
};

function mapProgramaNombre(nombreBot) {
  if (!nombreBot?.trim()) return null;
  const mapped = PROGRAMA_MAPPER[nombreBot.trim()];
  if (!mapped) console.log(`   ⚠️ Programa "${nombreBot}" no encontrado en el mapper`);
  return mapped || nombreBot;
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

  const programaBot = vars["ProgramaSeleccionado"] || vars["Programa ID"] || vars["ProgramaID"] || vars["Programa Seleccionado"] || null;

  return {
    firstname:               vars["Nombre"]             || null,
    lastname:                vars["Apellido"]           || null,
    emailaddress1:           vars["Mail"]               || vars["Email"] || null,
    mobilephone:             telefono,
    canal,
    new_areadeinteresnombre: vars["Area"]               || vars["Area ID"] || vars["AreaID"] || null,
    new_programanombre:      mapProgramaNombre(programaBot),
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

  if (WEBHOOK_SECRET && req.headers["auth-bm-token"]) {
    if (req.headers["auth-bm-token"] !== WEBHOOK_SECRET) {
      console.error("❌ [AUTH] Token inválido");
      return res.status(401).json({ ok: false, error: "Token inválido" });
    }
  }

  console.log("=== BODY COMPLETO ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=== FIN BODY ===");

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