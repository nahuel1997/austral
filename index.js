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

// ─── Mapear payload de Botmaker al formato interno ───────────────────────────
function mapBotmakerPayload(body) {
  const vars = body.variables || {};
  const canal = body.chatPlatform === "whatsapp" ? "WhatsApp" : "Web";

  // Teléfono: en WhatsApp viene en contactId, en Web en la variable
  const telefono = canal === "WhatsApp"
    ? body.contactId
    : vars["Telefono"] || vars["Teléfono"] || null;

  return {
    firstname:              vars["Nombre"]               || null,
    lastname:               vars["Apellido"]             || null,
    emailaddress1:          vars["Mail"]                 || vars["Email"] || null,
    mobilephone:            telefono,
    canal,
    new_areadeinteresid:    vars["Area ID"]              || vars["AreaID"] || null,
    new_programadeinteresid: vars["Programa ID"]         || vars["ProgramaID"] || vars["Programa Seleccionado"] || null,
    new_utm_source:         vars["utm_source"]           || null,
    new_utm_medium:         vars["utm_medium"]           || null,
    new_utm_campaign:       vars["utm_campaign"]         || null,
    new_utm_term:           vars["utm_term"]             || null,
    new_utm_content:        vars["utm_content"]          || null,
    new_googleclickid:      vars["gclid"]                || null,
    new_sourceid:           vars["source_id"]            || null,
    new_campaignid:         vars["campaign_id"]          || null,
    new_origencandidato:    vars["origen_candidato"]     || null,
    description:            vars["Consulta"]             || vars["descripcion"] || null,
    // Raw de Botmaker por si se necesita
    _botmaker_raw: body,
  };
}

// ─── Validaciones ────────────────────────────────────────────────────────────
function validatePayload(body) {
  const errors = [];
  if (!body.firstname?.trim())        errors.push("firstname es obligatorio");
  if (!body.lastname?.trim())         errors.push("lastname es obligatorio");
  if (!body.emailaddress1?.trim())    errors.push("emailaddress1 es obligatorio");
  if (!body.new_areadeinteresid)      errors.push("new_areadeinteresid es obligatorio");
  if (!body.new_programadeinteresid)  errors.push("new_programadeinteresid es obligatorio");

  if (body.canal === "Web" && !body.mobilephone) {
    errors.push("mobilephone es obligatorio en canal Web");
  }
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
    lastname: payload.lastname.trim(),
    emailaddress1: payload.emailaddress1.trim(),
  };

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
  if (payload.ownerid) {
    const entity = payload.owneridtype === "team" ? "teams" : "systemusers";
    body["ownerid@odata.bind"] = `/${entity}(${payload.ownerid})`;
  }
  return body;
}

// ─── Construir body del Interés del contacto (área) ─────────────────────────
function buildInteresBody(payload, leadId) {
  const body = {
    "new_clientepotencial@odata.bind": `/leads(${leadId})`,
  };
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
  const body = {
    "new_clientepotencial@odata.bind": `/leads(${leadId})`,
  };
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
    `${CRM_BASE_URL}/new_interesdelcontactos`,
    body,
    { headers: crmHeaders(token) }
  );
  return data?.new_interesdelcontactoid;
}

async function createRelacionCarrera(body, token) {
  const { data } = await axios.post(
    `${CRM_BASE_URL}/new_relacionclientecarreras`,
    body,
    { headers: crmHeaders(token) }
  );
  return data?.new_relacionclientecarreraid;
}

// ─── Webhook principal ───────────────────────────────────────────────────────
app.post("/webhook/botmaker", async (req, res) => {
  console.log("\n============================================================");
  console.log("📨 CONEXIÓN RECIBIDA DESDE BOTMAKER");
  console.log(`   Fecha/Hora : ${new Date().toLocaleString("es-AR")}`);
  console.log(`   IP origen  : ${req.ip}`);
  console.log("============================================================");

  // Auth: opcional si Botmaker no manda secret
  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    // Solo rechazar si el header viene con un valor incorrecto
    // Si no viene el header, dejamos pasar (Botmaker no lo soporta)
    if (req.headers["x-webhook-secret"]) {
      console.error("❌ [AUTH] Webhook secret inválido");
      return res.status(401).json({ ok: false, error: "Webhook secret inválido" });
    }
  }
  console.log("✅ [AUTH] OK");

  // ─── DEBUG ────────────────────────────────────────────────────────────────
  console.log("\n=== PAYLOAD RAW DE BOTMAKER ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=== FIN PAYLOAD RAW ===\n");
  // ─────────────────────────────────────────────────────────────────────────

  // Mapear formato Botmaker → formato interno
  const payload = mapBotmakerPayload(req.body);

  console.log("\n------------------------------------------------------------");
  console.log("📋 DATOS MAPEADOS:");
  console.log(`   Nombre       : ${payload.firstname} ${payload.lastname}`);
  console.log(`   Email        : ${payload.emailaddress1}`);
  console.log(`   Teléfono     : ${payload.mobilephone ?? "(no enviado)"}`);
  console.log(`   Canal        : ${payload.canal}`);
  console.log(`   Área ID      : ${payload.new_areadeinteresid ?? "(no enviado)"}`);
  console.log(`   Programa ID  : ${payload.new_programadeinteresid ?? "(no enviado)"}`);
  console.log(`   UTM Source   : ${payload.new_utm_source ?? "-"}`);
  console.log(`   Descripción  : ${payload.description ? payload.description.slice(0, 80) + "..." : "(vacía)"}`);
  console.log("------------------------------------------------------------");

  // Validar
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    console.error("❌ [VALIDACIÓN] Campos inválidos o faltantes:");
    errors.forEach(e => console.error(`   • ${e}`));
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
    console.log(`   Interés  : ${interesId}`);
    console.log(`   Relación : ${relacionId}`);
    console.log("============================================================\n");

    return res.status(200).json({
      ok: true,
      lead_action: leadAction,
      leadid: leadId,
      interes_id: interesId,
      relacion_id: relacionId,
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