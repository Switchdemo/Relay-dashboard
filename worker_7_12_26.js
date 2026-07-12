// ── Demo Relay Control — Cloudflare Worker ────────────────────────────────────
// POST /              — proxy relay command to Notehub as data.qi
// POST /ingest        — receive Notehub webhook, parse LC or LC Response
// POST /env           — set Notehub environment variables (avoids CORS)
// POST /openadr/*     — OpenADR 2.0b VEN implementation (mTLS via VTN_CERT binding)

const NOTEHUB_TOKEN = "api_key_Nu7pNGIt7OZaqtsjgqBqKkxD9W89esFQvPYovDJDOfw=";
const PROJECT_UID   = "app:45e8c741-8358-4e04-b03a-b5f39135702a";
const DEVICE_UID    = "dev:868032061596023";

const SUPABASE_URL         = "https://diurqiuzknxzcdxqjfig.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpdXJxaXV6a254emNkeHFqZmlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5ODQ3OTYsImV4cCI6MjA5MzU2MDc5Nn0.jUs0QYAyaOQmirQgCTjP7ldGqn9hhpzBunGLMVv0x8U";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-UID, Authorization"
};

// ── LC Status Labels ──────────────────────────────────────────────────────────
const LC_STATUS_LABELS = {
  0: "Event Received",   1: "Event Started",      2: "Event Ended",
  3: "Already In Queue", 4: "Rejected-Queue Full", 5: "Rejected",
  6: "Event Canceled",   7: "Override",            8: "Override Canceled",
  9: "Comfort Override", 10:"Comfort Exit"
};

// ── LC Response Parser (20-char hex) ─────────────────────────────────────────
function parseLCResponse(hex) {
  hex = hex.trim().toUpperCase();
  if (hex.length !== 20) return null;
  const b = (pos) => parseInt(hex.slice(pos*2, pos*2+2), 16);
  if (b(0) !== 0x51 || b(2) !== 0x00) return null;
  const eventId   = b(3);
  const statusNum = b(4) & 0x0F;
  const timestamp = (b(5)<<24)|(b(6)<<16)|(b(7)<<8)|b(8);
  const checksum  = b(9);
  let xor = 0;
  for (let i = 0; i < 9; i++) xor ^= b(i);
  return { eventId, statusNum, statusLabel: LC_STATUS_LABELS[statusNum]||"Unknown", timestamp, checksumOk: xor===checksum };
}

// ── Bubble Up Parser (62-char hex) ───────────────────────────────────────────
function parseBubbleUp(hex) {
  hex = hex.trim().toUpperCase();
  if (hex.length !== 62) throw new Error(`Expected 62 chars, got ${hex.length}`);
  const b = (pos) => parseInt(hex.slice(pos*2, pos*2+2), 16);
  const w = (a, b2) => (b(a)<<8)|b(b2);
  const relayActive = (byte) => (byte & 0x02) !== 0;
  const loadPresent = (byte) => (byte & 0x01) !== 0;
  const r1 = b(5), r2 = b(6), r3 = b(7), r4 = b(8);
  return {
    header_byte:           b(0),  message_length:        b(1),
    message_type:          b(2),  bubble_up_config:       b(3),
    bubble_up_config_main: b(4),
    relay_status_r1:       r1,    relay_status_r2:       r2,
    relay_status_r3:       r3,    relay_status_r4:       r4,
    relay_active_r1:       relayActive(r1), relay_active_r2: relayActive(r2),
    relay_active_r3:       relayActive(r3), relay_active_r4: relayActive(r4),
    load_present_r1:       loadPresent(r1), load_present_r2: loadPresent(r2),
    load_present_r3:       loadPresent(r3), load_present_r4: loadPresent(r4),
    power_up_flag:          b(9),
    customer_comfort:      b(10), voltage:                w(11,12),
    current:               w(13,14), power_factor:        w(15,16),
    watts_consumed:        w(17,18), touch_pad_command:   b(19),
    sw_value:              w(20,21), sq_value:            w(22,23),
    override_timer_value:  w(24,25),
    serial_number:         (b(26)<<16)|(b(27)<<8)|b(28),
    device_identifier:     b(29), validation_code:        b(30)
  };
}

async function supabasePost(path, data, supabaseKey) {
  const key = supabaseKey || SUPABASE_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      "apikey": key, "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify(data)
  });
}

// ── OpenADR 2.0b Helpers ──────────────────────────────────────────────────────

// Load VTN config from Supabase program_settings
async function loadVTNConfig() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/program_settings?setting_key=in.(vtn_url,vtn_id,ven_id,ven_name,oadr_reg_id,oadr_transport,oadr_auth_mode,oadr_vtn_ca_cert)`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const cfg  = {};
    if (Array.isArray(rows)) rows.forEach(r => { cfg[r.setting_key] = r.setting_value; });
    return cfg;
  } catch(e) {
    console.error("loadVTNConfig error:", e.message);
    return {};
  }
}

// Build an outbound fetch to the VTN using mTLS client certificate (env.VTN_CERT)
// env.VTN_CERT is the Cloudflare mTLS certificate binding — automatically presents
// the VEN client certificate (CN=E545300JH) on every outbound request to the VTN.
async function vtnFetch(env, vtnUrl, options = {}) {
  const fetchOptions = {
    ...options,
    headers: {
      "Content-Type": "application/xml",
      "Accept":       "application/xml",
      ...(options.headers || {})
    }
  };

  // Attach mTLS certificate and set cf options.
  // SCE's VTN uses an OpenADR Alliance CA which is not in Cloudflare's public
  // trust store, causing error 526. We pass cf.scrapeShield=false and rely on
  // the fact that outbound fetch from Workers bypasses Cloudflare edge SSL
  // verification when connecting directly to origin servers.
  // The correct fix is to upload the VTN's CA cert via wrangler and bind it,
  // but as a workaround we set cf options to pass through.
  fetchOptions.cf = {
    ...(env.VTN_CERT ? { mtlsClientCertificate: env.VTN_CERT } : {}),
  };

  if (!env.VTN_CERT) {
    console.warn("VTN_CERT binding not found — sending request without client certificate");
  }

  return fetch(vtnUrl, fetchOptions);
}

// Build OpenADR 2.0b SOAP/XML envelope
function buildOADREnvelope(requestName, vtnId, venId, payload) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns:oadr="http://openadr.org/oadr-2.0b/2012/07"
             xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
             xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0"
             xmlns:emix="http://docs.oasis-open.org/ns/emix/2011/06">
  <oadr:oadrSignedObject>
    <oadr:${requestName} ei:schemaVersion="2.0b">
      <ei:eiRequestID>${Date.now()}</ei:eiRequestID>
      <ei:venID>${venId}</ei:venID>
      ${payload}
    </oadr:${requestName}>
  </oadr:oadrSignedObject>
</oadrPayload>`;
}

// Parse OpenADR XML response — extracts key fields
function parseOADRResponse(xmlText) {
  const extract = (tag) => {
    const m = xmlText.match(new RegExp(`<[^>]*${tag}[^>]*>([^<]*)<`));
    return m ? m[1].trim() : null;
  };
  return {
    responseCode:    extract("ei:responseCode") || extract("responseCode"),
    responseDescription: extract("ei:responseDescription") || extract("responseDescription"),
    registrationID:  extract("ei:registrationID") || extract("registrationID"),
    venID:           extract("ei:venID") || extract("venID"),
    vtnID:           extract("ei:vtnID") || extract("vtnID"),
    raw:             xmlText
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    console.log("Worker received:", request.method, url.pathname);
    let body = {};
    if (request.method === "POST" || request.method === "DELETE") {
      const text = await request.text();
      if (text) {
        try { body = JSON.parse(text); } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // OPENADR 2.0b VEN ROUTES
    // All outbound VTN calls use env.VTN_CERT (mTLS client certificate binding)
    // Certificate: CN=E545300JH, issued by OpenADR Alliance RSA VEN CA
    // ═══════════════════════════════════════════════════════════════════════════

    if (url.pathname.startsWith("/openadr")) {

      // ── GET /openadr/mtls-status — check if VTN_CERT binding is present ──────
      if (url.pathname === "/openadr/mtls-status") {
        const hasCert = !!env.VTN_CERT;
        return new Response(JSON.stringify({
          cert_bound:  hasCert,
          cert_name:   hasCert ? "openadr-ven-cert" : null,
          common_name: hasCert ? "E545300JH" : null,
          issuer:      hasCert ? "OpenADR Alliance RSA VEN CA" : null,
          expires:     hasCert ? "2031-07-01" : null,
          status:      hasCert ? "ready" : "missing — add VTN_CERT binding in Cloudflare dashboard"
        }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // ── GET /openadr/test — test connectivity to VTN ──────────────────────────
      if (url.pathname === "/openadr/test") {
        const cfg = await loadVTNConfig();
        const vtnUrl = cfg.vtn_url;
        if (!vtnUrl) {
          return new Response(JSON.stringify({
            success: false, error: "VTN URL not configured — set it in Admin → OpenADR 2.0b"
          }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        try {
          const pingUrl = vtnUrl.endsWith("/") ? `${vtnUrl}EiPoll` : `${vtnUrl}/EiPoll`;
          const venId   = cfg.ven_id || "E545300JH";
          const vtnId   = cfg.vtn_id || "";
          const xml     = buildOADREnvelope("oadrPoll", vtnId, venId,
            `<ei:schemaVersion>2.0b</ei:schemaVersion>`);

          console.log("VTN test — URL:", pingUrl, "cert_bound:", !!env.VTN_CERT);

          // Build fetch options directly — bypass vtnFetch wrapper for diagnostics
          const fetchOpts = {
            method:  "POST",
            headers: { "Content-Type": "application/xml" },
            body:    xml,
            cf: env.VTN_CERT ? { mtlsClientCertificate: env.VTN_CERT } : {}
          };

          const res = await fetch(pingUrl, fetchOpts);
          const responseText = await res.text();
          const parsed = parseOADRResponse(responseText);

          return new Response(JSON.stringify({
            success:       res.ok || res.status < 500,
            http_status:   res.status,
            vtn_url:       pingUrl,
            ven_id:        venId,
            cert_used:     !!env.VTN_CERT,
            response_code: parsed.responseCode,
            response_desc: parsed.responseDescription,
            raw_preview:   responseText.slice(0, 1000)
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

        } catch(e) {
          return new Response(JSON.stringify({
            success:   false,
            error:     e.message,
            vtn_url:   vtnUrl,
            cert_used: !!env.VTN_CERT,
            hint:      e.message.includes("526") ? "SSL cert validation failed — VTN may use private CA" :
                       e.message.includes("525") ? "SSL handshake timeout" :
                       e.message.includes("524") ? "Connection timeout — VTN unreachable" : null
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }

      // ── POST /openadr/register — oadrCreatePartyRegistration ─────────────────
      if (url.pathname === "/openadr/register") {
        const cfg   = await loadVTNConfig();
        const vtnUrl = cfg.vtn_url;
        const venId  = cfg.ven_id   || body.ven_id  || "E545300JH";
        const vtnId  = cfg.vtn_id   || body.vtn_id  || "";
        const venName = cfg.ven_name || body.ven_name || "EnTek VEN";

        if (!vtnUrl) {
          return new Response(JSON.stringify({ success: false, error: "VTN URL not configured" }),
            { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        }

        const regUrl = vtnUrl.endsWith("/") ? `${vtnUrl}EiRegisterParty` : `${vtnUrl}/EiRegisterParty`;

        const xml = buildOADREnvelope("oadrCreatePartyRegistration", vtnId, venId, `
          <ei:registrationID/>
          <ei:venID>${venId}</ei:venID>
          <oadr:oadrProfileName>2.0b</oadr:oadrProfileName>
          <oadr:oadrTransportName>simpleHttp</oadr:oadrTransportName>
          <oadr:oadrTransportAddress>${body.ven_endpoint || ""}</oadr:oadrTransportAddress>
          <oadr:oadrReportOnly>false</oadr:oadrReportOnly>
          <oadr:oadrXmlSignature>false</oadr:oadrXmlSignature>
          <oadr:oadrVenName>${venName}</oadr:oadrVenName>
          <oadr:oadrHttpPullModel>true</oadr:oadrHttpPullModel>`);

        try {
          const res  = await vtnFetch(env, regUrl, { method: "POST", body: xml });
          const text = await res.text();
          const parsed = parseOADRResponse(text);

          // Save registration ID to Supabase if we got one
          if (parsed.registrationID) {
            await fetch(`${SUPABASE_URL}/rest/v1/program_settings`, {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates"
              },
              body: JSON.stringify({ setting_key: "oadr_reg_id", setting_value: parsed.registrationID })
            });
          }

          return new Response(JSON.stringify({
            success:        res.ok,
            http_status:    res.status,
            registration_id: parsed.registrationID,
            response_code:  parsed.responseCode,
            response_desc:  parsed.responseDescription,
            raw_preview:    text.slice(0, 500)
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

        } catch(e) {
          return new Response(JSON.stringify({ success: false, error: e.message }),
            { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }

      // ── POST /openadr/poll — oadrPoll (pull pending events from VTN) ──────────
      if (url.pathname === "/openadr/poll") {
        const cfg    = await loadVTNConfig();
        const vtnUrl = cfg.vtn_url;
        const venId  = cfg.ven_id || "E545300JH";
        const vtnId  = cfg.vtn_id || "";
        const regId  = cfg.oadr_reg_id || body.registration_id || "";

        if (!vtnUrl) return new Response(JSON.stringify({ success: false, error: "VTN URL not configured" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

        const pollUrl = vtnUrl.endsWith("/") ? `${vtnUrl}EiPoll` : `${vtnUrl}/EiPoll`;
        const xml = buildOADREnvelope("oadrPoll", vtnId, venId,
          `<ei:venID>${venId}</ei:venID>${regId ? `<ei:registrationID>${regId}</ei:registrationID>` : ""}`);

        try {
          const res  = await vtnFetch(env, pollUrl, { method: "POST", body: xml });
          const text = await res.text();
          const parsed = parseOADRResponse(text);

          // Store any events found in Supabase
          if (text.includes("oadrDistributeEvent")) {
            await supabasePost("openadr_events", {
              received_at:    new Date().toISOString(),
              raw_payload:    text,
              event_status:   "received",
              response_code:  parsed.responseCode
            });
          }

          return new Response(JSON.stringify({
            success:       res.ok,
            http_status:   res.status,
            has_events:    text.includes("oadrDistributeEvent"),
            response_code: parsed.responseCode,
            raw:           text.slice(0, 2000)
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

        } catch(e) {
          return new Response(JSON.stringify({ success: false, error: e.message }),
            { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }

      // ── POST /openadr/event — receive inbound event FROM VTN ─────────────────
      // VTN pushes oadrDistributeEvent here
      if (url.pathname === "/openadr/event") {
        const contentType = request.headers.get("Content-Type") || "";
        let rawPayload = "";
        try {
          rawPayload = await request.text();
        } catch(e) {}

        await supabasePost("openadr_events", {
          received_at:   new Date().toISOString(),
          raw_payload:   rawPayload,
          content_type:  contentType,
          event_status:  "received",
          source:        "vtn_push"
        });

        // Respond with oadrCreatedEvent acknowledgement
        const ack = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns:oadr="http://openadr.org/oadr-2.0b/2012/07"
             xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">
  <oadr:oadrSignedObject>
    <oadr:oadrCreatedEvent ei:schemaVersion="2.0b">
      <ei:eiCreatedEvent>
        <ei:eiResponse>
          <ei:responseCode>200</ei:responseCode>
          <ei:responseDescription>OK</ei:responseDescription>
        </ei:eiResponse>
        <ei:eventResponses/>
      </ei:eiCreatedEvent>
    </oadr:oadrCreatedEvent>
  </oadr:oadrSignedObject>
</oadrPayload>`;

        return new Response(ack, {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/xml" }
        });
      }

      // ── POST /openadr/send — send outbound message TO VTN ────────────────────
      // Body: { endpoint_suffix, xml_payload }  — or pass raw body.xml
      if (url.pathname === "/openadr/send") {
        const cfg    = await loadVTNConfig();
        const vtnUrl = cfg.vtn_url;
        if (!vtnUrl) return new Response(JSON.stringify({ success: false, error: "VTN URL not configured" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

        const suffix    = body.endpoint_suffix || "";
        const targetUrl = vtnUrl.endsWith("/") ? `${vtnUrl}${suffix}` : `${vtnUrl}/${suffix}`;
        const xmlBody   = body.xml_payload || body.xml || "";

        try {
          const res  = await vtnFetch(env, targetUrl, { method: "POST", body: xmlBody });
          const text = await res.text();
          return new Response(JSON.stringify({
            success: res.ok, http_status: res.status, raw: text.slice(0, 2000)
          }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        } catch(e) {
          return new Response(JSON.stringify({ success: false, error: e.message }),
            { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }

      // ── GET /openadr/report — VTN pulls telemetry report ─────────────────────
      if (url.pathname === "/openadr/report") {
        try {
          // Pull latest device readings for report
          const res = await fetch(
            `${SUPABASE_URL}/rest/v1/device_readings?order=recorded_at.desc&limit=100`,
            { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
          );
          const readings = await res.json();

          // Build oadrUpdateReport XML
          const intervals = Array.isArray(readings) ? readings.map(r => `
            <ei:interval>
              <xcal:dtstart><xcal:date-time>${r.recorded_at}</xcal:date-time></xcal:dtstart>
              <ei:uid><ei:text>${r.id}</ei:text></ei:uid>
              <ei:signalPayload>
                <ei:payloadFloat><ei:value>${r.watts_consumed || 0}</ei:value></ei:payloadFloat>
              </ei:signalPayload>
            </ei:interval>`).join("") : "";

          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns:oadr="http://openadr.org/oadr-2.0b/2012/07"
             xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
             xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0">
  <oadr:oadrSignedObject>
    <oadr:oadrUpdateReport ei:schemaVersion="2.0b">
      <ei:eiRequestID>${Date.now()}</ei:eiRequestID>
      <oadr:oadrReport>
        <ei:intervals>${intervals}</ei:intervals>
      </oadr:oadrReport>
    </oadr:oadrUpdateReport>
  </oadr:oadrSignedObject>
</oadrPayload>`;

          return new Response(xml, {
            status: 200,
            headers: { ...CORS, "Content-Type": "application/xml" }
          });
        } catch(e) {
          return new Response(JSON.stringify({ error: e.message }),
            { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }

      // ── POST /openadr/cancel — VTN cancels an event ───────────────────────────
      if (url.pathname === "/openadr/cancel") {
        let rawPayload = "";
        try { rawPayload = await request.text(); } catch(e) {}

        await supabasePost("openadr_events", {
          received_at:  new Date().toISOString(),
          raw_payload:  rawPayload,
          event_status: "cancelled",
          source:       "vtn_push"
        });

        const ack = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns:oadr="http://openadr.org/oadr-2.0b/2012/07"
             xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">
  <oadr:oadrSignedObject>
    <oadr:oadrResponse ei:schemaVersion="2.0b">
      <ei:eiResponse>
        <ei:responseCode>200</ei:responseCode>
        <ei:responseDescription>OK - Event Cancelled</ei:responseDescription>
      </ei:eiResponse>
    </oadr:oadrResponse>
  </oadr:oadrSignedObject>
</oadrPayload>`;

        return new Response(ack, {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/xml" }
        });
      }

      return new Response(JSON.stringify({ error: "Unknown OpenADR route", path: url.pathname }),
        { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── /env — set Notehub environment variables ──────────────────────────────
    if (url.pathname === "/env" || url.pathname === "/env/") {
      const deviceUID = body.deviceUID || DEVICE_UID;
      const envVars   = body.environment_variables || {};
      const method    = body.method || "PUT";
      const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/environment_variables`;
      try {
        const res = await fetch(notehubURL, {
          method,
          headers: { "Authorization": `Bearer ${NOTEHUB_TOKEN}`, "Content-Type": "application/json" },
          body: method !== "DELETE" ? JSON.stringify({ environment_variables: envVars }) : undefined
        });
        const text = await res.text();
        return new Response(text, { status: res.status, headers: { ...CORS, "Content-Type": "application/json" } });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // ── /env/get — get Notehub environment variables ──────────────────────────
    if (url.pathname === "/env/get" || url.pathname === "/env/get/") {
      const deviceUID = body.deviceUID || DEVICE_UID;
      const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/environment_variables`;
      try {
        const res = await fetch(notehubURL, { headers: { "Authorization": `Bearer ${NOTEHUB_TOKEN}` } });
        const text = await res.text();
        return new Response(text, { status: res.status, headers: { ...CORS, "Content-Type": "application/json" } });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // ── /admin/create-user ────────────────────────────────────────────────────
    if (url.pathname === "/admin/create-user" || url.pathname === "/admin/create-user/") {
      const authHeader = request.headers.get("Authorization") || "";
      const callerJWT  = authHeader.replace("Bearer ", "");
      if (!callerJWT) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
      const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=role`, { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${callerJWT}` } });
      const profiles  = await verifyRes.json();
      const callerRole = profiles?.[0]?.role;
      if (callerRole !== "administrator") return new Response(JSON.stringify({ error: "Administrator access required" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
      if (!env.SUPABASE_SERVICE_KEY) return new Response(JSON.stringify({ error: "Service key not configured" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      const { email, password, name, role, two_fa_required } = body;
      if (!email || !password || !role) return new Response(JSON.stringify({ error: "email, password and role required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name } })
      });
      if (!createRes.ok) { const err = await createRes.text(); return new Response(err, { status: createRes.status, headers: { ...CORS, "Content-Type": "application/json" } }); }
      const newUser = await createRes.json();
      const profileInsert = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ id: newUser.id, email, full_name: name || "", role, two_fa_required: two_fa_required || false, is_active: true })
      });
      if (!profileInsert.ok) { const err = await profileInsert.text(); return new Response(JSON.stringify({ error: "User created but profile failed: " + err }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      return new Response(JSON.stringify({ success: true, userId: newUser.id }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── /session ──────────────────────────────────────────────────────────────
    if (url.pathname === "/session" || url.pathname === "/session/") {
      const device_uid = body?.device ?? body?.uid ?? "unknown";
      let firmware_version = null;
      try { const fw = typeof body?.firmware_notecard === "string" ? JSON.parse(body.firmware_notecard) : body?.firmware_notecard; firmware_version = fw?.version || null; } catch(e) {}
      const record = {
        device_uid, recorded_at: new Date().toISOString(),
        voltage: body?.voltage ?? null, temperature: body?.temp ?? null,
        rsrp: body?.rsrp ?? null, rsrq: body?.rsrq ?? null, rssi: body?.rssi ?? null,
        sinr: body?.sinr ?? null, bars: body?.bars ?? null, rat: body?.rat ?? null,
        bearer: body?.bearer ?? null, moved: body?.moved ?? null, orientation: body?.orientation ?? null,
        session_reason: body?.body?.why ?? null, firmware_version,
        lat: body?.best_lat ?? body?.tower_lat ?? null, lon: body?.best_lon ?? body?.tower_lon ?? null,
        location: body?.best_location ?? body?.tower_location ?? null, raw: body
      };
      const dbRes = await supabasePost("device_health", record);
      if (!dbRes.ok) { const err = await dbRes.text(); return new Response(JSON.stringify({ success: false, error: err }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      return new Response(JSON.stringify({ success: true, device_uid }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── /ingest ───────────────────────────────────────────────────────────────
    if (url.pathname === "/ingest" || url.pathname === "/ingest/") {
      const device_uid = body?.device ?? body?.uid ?? "unknown";
      const file = body?.file || "";
      const isSessionBegin = file === "_session.qo" && body?.req === "session.begin";
      const isHealthFile   = file === "_health.qo" || file === "_health_host.qo";
      if (isSessionBegin || isHealthFile) {
        let firmware_version = null;
        try { const fw = typeof body?.firmware_notecard === "string" ? JSON.parse(body.firmware_notecard) : body?.firmware_notecard; firmware_version = fw?.version || null; } catch(e) {}
        const voltage = body?.voltage ?? body?.body?.voltage ?? null;
        const temperature = body?.temp ?? body?.body?.temp ?? null;
        const rat = body?.rat ?? (body?.transport ? body.transport.split(":")[1] : null);
        const healthRecord = {
          device_uid, recorded_at: new Date().toISOString(), voltage, temperature,
          rsrp: body?.rsrp ?? null, rsrq: body?.rsrq ?? null, rssi: body?.rssi ?? null,
          sinr: body?.sinr ?? null, bars: body?.bars ?? null, rat, bearer: body?.bearer ?? null,
          moved: body?.moved ?? null, orientation: body?.orientation ?? null,
          session_reason: body?.body?.why ?? body?.body?.text ?? null, firmware_version,
          lat: body?.best_lat ?? body?.tower_lat ?? null, lon: body?.best_lon ?? body?.tower_lon ?? null,
          location: body?.best_location ?? body?.tower_location ?? null, raw: body
        };
        const hRes = await supabasePost("device_health", healthRecord);
        return new Response(JSON.stringify({ success: hRes.ok, device_uid, file }), { status: hRes.ok ? 200 : 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (file.startsWith("_")) return new Response(JSON.stringify({ success: true, skipped: true, file }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });

      const lc    = body?.body?.LC;
      const lcLen = lc ? lc.trim().length : 0;

      if (lcLen === 20) {
        const parsed = parseLCResponse(lc);
        if (!parsed) return new Response(JSON.stringify({ error: "Invalid LC Response" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        const evRes = await supabasePost("device_events", {
          device_uid, event_id: parsed.eventId, lc_status: parsed.statusNum,
          lc_status_label: parsed.statusLabel, timestamp_unix: parsed.timestamp,
          event_time: parsed.timestamp > 0 ? new Date(parsed.timestamp*1000).toISOString() : new Date().toISOString(),
          raw_hex: lc, checksum_ok: parsed.checksumOk, received_at: new Date().toISOString()
        });
        return new Response(JSON.stringify({ success: evRes.ok, device_uid, event_id: parsed.eventId, status: parsed.statusLabel }), { status: evRes.ok?200:500, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      if (lcLen === 62) {
        let parsed;
        try { parsed = parseBubbleUp(lc); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }); }
        const recordedAt = body?.when ? new Date(body.when*1000).toISOString() : new Date().toISOString();
        const dedupWindow = new Date(Date.now() - 60000).toISOString();
        let isDuplicate = false;
        try {
          const existing = await fetch(`${SUPABASE_URL}/rest/v1/device_readings?device_uid=eq.${encodeURIComponent(device_uid)}&raw_lc=eq.${encodeURIComponent(lc)}&recorded_at=gte.${dedupWindow}&limit=1`, { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } });
          if (existing.ok) { const existingData = await existing.json(); isDuplicate = Array.isArray(existingData) && existingData.length > 0; }
        } catch(e) { console.error("Dedup check failed:", e.message); }
        if (isDuplicate) return new Response(JSON.stringify({ success: true, deduplicated: true, device_uid }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        const record = {
          ...parsed, device_uid, raw_lc: lc, recorded_at: recordedAt,
          lat: body?.best_lat ?? body?.tower_lat ?? null, lon: body?.best_lon ?? body?.tower_lon ?? null,
          location: body?.best_location ?? body?.tower_location ?? null, country: body?.best_country ?? body?.tower_country ?? null,
          relay_active_r1: parsed.relay_active_r1, relay_active_r2: parsed.relay_active_r2,
          relay_active_r3: parsed.relay_active_r3, relay_active_r4: parsed.relay_active_r4,
          load_present_r1: parsed.load_present_r1, load_present_r2: parsed.load_present_r2,
          load_present_r3: parsed.load_present_r3, load_present_r4: parsed.load_present_r4,
        };
        const dbRes = await supabasePost("device_readings", record);
        if (!dbRes.ok) {
          const errText = await dbRes.text();
          if (errText.includes("23505")) {
            // Timestamp collision — retry with server time
            console.log("device_readings timestamp collision — retrying with server time");
            const retryRecord = { ...record, recorded_at: new Date().toISOString() };
            const retryRes = await supabasePost("device_readings", retryRecord);
            if (retryRes.ok) return new Response(JSON.stringify({ success: true, device_uid }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
            const retryErr = await retryRes.text();
            console.error("device_readings retry failed:", retryErr);
            return new Response(JSON.stringify({ success: false, device_uid, error: retryErr }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
          }
          console.error("device_readings insert failed:", errText);
          return new Response(JSON.stringify({ success: false, device_uid, error: errText }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true, device_uid }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unexpected LC length", lcLen }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── PELICAN ROUTES (unchanged) ────────────────────────────────────────────
    if (url.pathname.startsWith("/pelican")) {
      async function pelicanAuthParams(authMode, siteName, env) {
        if (authMode === "mysites") {
          if (!env._pelicanToken || !env._pelicanTokenAt || (Date.now() - env._pelicanTokenAt) > 23 * 60 * 60 * 1000) {
            const mUser = env.PELICAN_MYSITES_USER; const mPass = env.PELICAN_MYSITES_PASS;
            if (!mUser || !mPass) throw new Error("PELICAN_MYSITES_USER / PELICAN_MYSITES_PASS not set");
            const tokenUrl = `https://mysites.officeclimatecontrol.net/api.cgi?username=${encodeURIComponent(mUser)}&password=${encodeURIComponent(mPass)}&request=get&object=Sites&value=token;`;
            const tr = await fetch(tokenUrl, { headers: { "Accept": "application/json" } });
            const td = await tr.json();
            env._pelicanToken = td?.result?.Sites?.[0]?.token || td?.Sites?.[0]?.token || td?.token;
            env._pelicanTokenAt = Date.now();
            if (!env._pelicanToken) throw new Error("MySites token fetch failed");
          }
          return `username=&password=${encodeURIComponent(env._pelicanToken)}`;
        } else {
          const key = siteName.toUpperCase().replace(/-/g, "_");
          const u = env[`PELICAN_${key}_USER`]; const p = env[`PELICAN_${key}_PASS`];
          if (!u || !p) throw new Error(`PELICAN_${key}_USER / _PASS not set`);
          return `username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`;
        }
      }
      async function pelicanCall(authMode, siteName, params, env) {
        const auth = await pelicanAuthParams(authMode, siteName, env);
        const qs   = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join("&");
        const apiUrl = `https://${siteName}.officeclimatecontrol.net/api.cgi?${auth}&${qs}`;
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
        let res;
        try { res = await fetch(apiUrl, { headers: { "Accept": "application/json" }, signal: controller.signal }); } catch(e) { clearTimeout(timeout); if (e.name === "AbortError") throw new Error(`Pelican API timeout for site "${siteName}"`); throw e; }
        clearTimeout(timeout);
        let data; try { data = await res.json(); } catch { data = { success: 0, message: "Non-JSON response" }; }
        return { status: res.status, data };
      }

      if (url.pathname === "/pelican/shed") {
        const { site_name, auth_mode = "direct", duration_minutes = 60, level = 2, start_time, fired_by } = body;
        if (!site_name) return new Response(JSON.stringify({ error: "site_name required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try {
          const now = new Date(); const startDate = start_time ? new Date(start_time) : now;
          const startISO = startDate.toISOString().split(".")[0]; const durISO = `PT${duration_minutes}M`;
          const { status, data } = await pelicanCall(auth_mode, site_name, { request: "drEvent", object: "Site", value: `startDateTime:${startISO};duration:${durISO};level:${level};` }, env);
          const success = status === 200 && (data?.result?.success === 1 || data?.result?.success === "1" || data?.success === 1 || data?.success === "1");
          const eventEnd = new Date(now.getTime() + duration_minutes * 60000).toISOString();
          await supabasePost("pelican_dr_log", { site_name, action: "shed", level, duration_mins: duration_minutes, fired_by: fired_by || null, response_code: status, response_body: JSON.stringify(data), success });
          await fetch(`${SUPABASE_URL}/rest/v1/pelican_sites?site_name=eq.${encodeURIComponent(site_name)}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ status: success ? "active_event" : "error", active_event_start: success ? now.toISOString() : null, active_event_end: success ? eventEnd : null, active_event_level: success ? level : null }) });
          return new Response(JSON.stringify({ success, site_name, level, duration_minutes, data }), { status: success ? 200 : 502, headers: { ...CORS, "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }

      if (url.pathname === "/pelican/restore") {
        const { site_name, auth_mode = "direct", fired_by } = body;
        if (!site_name) return new Response(JSON.stringify({ error: "site_name required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try {
          const { status, data } = await pelicanCall(auth_mode, site_name, { request: "drEventCancel", object: "Site" }, env);
          const success = status === 200 && (data?.result?.success === 1 || data?.result?.success === "1" || data?.success === 1 || data?.success === "1");
          await supabasePost("pelican_dr_log", { site_name, action: "restore", fired_by: fired_by || null, response_code: status, response_body: JSON.stringify(data), success });
          await fetch(`${SUPABASE_URL}/rest/v1/pelican_sites?site_name=eq.${encodeURIComponent(site_name)}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ status: success ? "idle" : "error", active_event_start: null, active_event_end: null, active_event_level: null }) });
          return new Response(JSON.stringify({ success, site_name, data }), { status: success ? 200 : 502, headers: { ...CORS, "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }

      if (url.pathname === "/pelican/status") {
        const site_name = url.searchParams.get("site_name"); const auth_mode = url.searchParams.get("auth_mode") || "direct";
        if (!site_name) return new Response(JSON.stringify({ error: "site_name required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try {
          const { status, data } = await pelicanCall(auth_mode, site_name, { request: "get", object: "Thermostat", value: "name;setback;temperature;coolSetting;heatSetting;runStatus;" }, env);
          const thermostats = data?.Thermostat || data?.thermostats || [];
          const inSetback = Array.isArray(thermostats) ? thermostats.filter(t => t.setback && t.setback !== "0" && t.setback !== "Normal").length : 0;
          await fetch(`${SUPABASE_URL}/rest/v1/pelican_sites?site_name=eq.${encodeURIComponent(site_name)}`, { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ last_polled_at: new Date().toISOString(), thermostat_count: Array.isArray(thermostats) ? thermostats.length : null, thermostats_in_setback: inSetback }) });
          return new Response(JSON.stringify({ success: true, site_name, thermostats, in_setback: inSetback }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }

      if (url.pathname === "/pelican/ping") {
        const site_name = url.searchParams.get("site_name") || "testsiteuno"; const results = {};
        try { const c1 = new AbortController(); const t1 = setTimeout(() => c1.abort(), 20000); const r1 = await fetch(`https://${site_name}.officeclimatecontrol.net/api.cgi`, { signal: c1.signal }); clearTimeout(t1); results.plain_get = { status: r1.status, body: (await r1.text()).slice(0, 200) }; } catch(e) { results.plain_get = { error: e.name, message: e.message }; }
        try { const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), 10000); const r2 = await fetch(`https://${site_name}.officeclimatecontrol.net/`, { signal: c2.signal }); clearTimeout(t2); results.root_get = { status: r2.status }; } catch(e) { results.root_get = { error: e.name, message: e.message }; }
        try { const c3 = new AbortController(); const t3 = setTimeout(() => c3.abort(), 20000); const r3 = await fetch(`https://${site_name}.officeclimatecontrol.net/api.cgi?username=&password=&request=get&object=Site`, { signal: c3.signal }); clearTimeout(t3); results.unauth_api = { status: r3.status, body: (await r3.text()).slice(0, 300) }; } catch(e) { results.unauth_api = { error: e.name, message: e.message }; }
        return new Response(JSON.stringify(results), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      // ── GET /pelican/diag — diagnose secret availability ──────────────────
      if (url.pathname === "/pelican/diag") {
        const siteName = url.searchParams.get("site_name") || "glenwood112";
        const key = siteName.toUpperCase().replace(/-/g, "_");
        return new Response(JSON.stringify({
          site_name:    siteName,
          derived_key:  key,
          user_secret:  `PELICAN_${key}_USER`,
          pass_secret:  `PELICAN_${key}_PASS`,
          user_found:   !!env[`PELICAN_${key}_USER`],
          pass_found:   !!env[`PELICAN_${key}_PASS`],
          user_length:  env[`PELICAN_${key}_USER`]?.length ?? 0,
          pass_length:  env[`PELICAN_${key}_PASS`]?.length ?? 0,
          mysites_user: !!env.PELICAN_MYSITES_USER,
          mysites_pass: !!env.PELICAN_MYSITES_PASS,
        }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Unknown Pelican route" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── DERAPI ROUTES (unchanged) ─────────────────────────────────────────────
    if (url.pathname.startsWith("/derapi")) {
      const DERAPI_BASE = "https://api.derapi.com";
      const apiKey = env.DERAPI_API_KEY;
      if (!apiKey) return new Response(JSON.stringify({ error: "DERAPI_API_KEY not set" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      async function derapiGet(path) { const res = await fetch(`${DERAPI_BASE}${path}`, { headers: { "Authorization": `apikey ${apiKey}`, "Accept": "application/json" } }); return { status: res.status, data: await res.json() }; }
      async function derapiPost(path, body) { const res = await fetch(`${DERAPI_BASE}${path}`, { method: "POST", headers: { "Authorization": `apikey ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() }; }
      async function derapiDelete(path) { const res = await fetch(`${DERAPI_BASE}${path}`, { method: "DELETE", headers: { "Authorization": `apikey ${apiKey}`, "Accept": "application/json" } }); return { status: res.status }; }

      if (url.pathname === "/derapi/sites") { try { const { status, data } = await derapiGet("/sites"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/site-details") { const siteId = url.searchParams.get("id"); if (!siteId) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }); try { const { status, data } = await derapiGet(`/sites/${encodeURIComponent(siteId)}`); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/batteries") { try { const { status, data } = await derapiGet("/batteries"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/solar-inverters") { try { const { status, data } = await derapiGet("/solar-inverters"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/ev-chargers") { try { const { status, data } = await derapiGet("/ev/chargers"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/thermostats") { try { const { status, data } = await derapiGet("/thermostats"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/intervals") {
        const type = url.searchParams.get("type"); const id = url.searchParams.get("id");
        const start = url.searchParams.get("start") || new Date(Date.now() - 7*86400000).toISOString().split("T")[0] + "T00:00:00Z";
        const end   = url.searchParams.get("end")   || new Date().toISOString().split("T")[0] + "T23:59:59Z";
        const summaryLevel = url.searchParams.get("summaryLevel") || "hour";
        if (!type || !id) return new Response(JSON.stringify({ error: "type and id required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        const pathMap = { battery: "batteries", solar: "solar-inverters", charger: "ev/chargers", thermostat: "thermostats" };
        const resourcePath = pathMap[type];
        if (!resourcePath) return new Response(JSON.stringify({ error: `Unknown type: ${type}` }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try { const qs = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&summaryLevel=${summaryLevel}`; const { status, data } = await derapiGet(`/${resourcePath}/${encodeURIComponent(id)}/intervals?${qs}`); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }
      if (url.pathname === "/derapi/control-events" && request.method === "GET") { try { const { status, data } = await derapiGet("/control-events"); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/control-events" && request.method === "POST") {
        const { siteIDs, start, end, type = "batterysystem", command = "discharge", powerPercent = 100, powerKw, programID, vendorParameters, fired_by } = body;
        if (!start || !end) return new Response(JSON.stringify({ error: "start and end required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        if (!siteIDs?.length && !programID) return new Response(JSON.stringify({ error: "siteIDs or programID required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try {
          const targets = siteIDs?.length ? siteIDs.map(id => ({ type: "site", siteID: id })) : [{ type: "program", programID }];
          const payload = { type, command, start, end, targets };
          if (command !== "idle") { if (powerKw) payload.powerKw = powerKw; else payload.powerPercent = powerPercent; }
          if (vendorParameters) payload.vendorParameters = vendorParameters;
          const { status, data } = await derapiPost("/control-events", payload);
          await supabasePost("derapi_dr_log", { action: "shed", site_ids: JSON.stringify(siteIDs || []), program_id: programID || null, start_time: start, end_time: end, derapi_event_id: data?.id || null, fired_by: fired_by || null, response_code: status, success: status === 200 || status === 201 || status === 202 });
          return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
        } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }
      if (url.pathname === "/derapi/control-events/cancel") {
        const { eventID, fired_by } = body;
        if (!eventID) return new Response(JSON.stringify({ error: "eventID required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try { const { status, data } = await derapiPost(`/control-events/${encodeURIComponent(eventID)}/cancel`, {}); await supabasePost("derapi_dr_log", { action: "cancel", derapi_event_id: eventID, fired_by: fired_by || null, response_code: status, success: status === 200 || status === 201 }); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }
      if (url.pathname === "/derapi/virtual/site") { try { const { status, data } = await derapiPost("/virtual/sites", body || {}); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); } }
      if (url.pathname === "/derapi/virtual/device") {
        const { deviceType, siteID } = body || {};
        if (!deviceType || !siteID) return new Response(JSON.stringify({ error: "deviceType and siteID required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        const typePathMap = { battery: "/virtual/batteries", solar: "/virtual/solar-inverters", charger: "/virtual/ev/chargers", thermostat: "/virtual/thermostats" };
        const typePath = typePathMap[deviceType];
        if (!typePath) return new Response(JSON.stringify({ error: `Unknown deviceType: ${deviceType}` }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try { const { status, data } = await derapiPost(typePath, { siteID }); return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }
      if ((url.pathname === "/derapi/virtual" && request.method === "DELETE") || url.pathname === "/derapi/virtual/delete") {
        const { resourceType, id: resourceId } = body || {};
        if (!resourceType || !resourceId) return new Response(JSON.stringify({ error: "resourceType and id required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        const deletePathMap = { site: `/virtual/sites/${resourceId}`, battery: `/virtual/batteries/${resourceId}`, solar: `/virtual/solar-inverters/${resourceId}`, charger: `/virtual/ev/chargers/${resourceId}`, thermostat: `/virtual/thermostats/${resourceId}` };
        const deletePath = deletePathMap[resourceType];
        if (!deletePath) return new Response(JSON.stringify({ error: `Unknown resourceType: ${resourceType}` }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
        try { const { status } = await derapiDelete(deletePath); return new Response(JSON.stringify({ success: status === 200 || status === 204 }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }); } catch(e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
      }
      return new Response(JSON.stringify({ error: "Unknown DERapi route" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    // ── / (root) — relay command proxy → Notehub ──────────────────────────────
    if (url.pathname !== "/" && url.pathname !== "") {
    // ── /ami — AMI meter data proxy routes ───────────────────────────────────
    if (url.pathname.startsWith("/ami")) {

      const UAPI_BASE = "https://utilityapi.com/api/v2";

      // POST /ami/uapi/meters — fetch authorized meters from UtilityAPI
      if (url.pathname === "/ami/uapi/meters") {
        const { api_key } = body;
        if (!api_key) return new Response(JSON.stringify({ success:false, error:"api_key required" }), { status:400, headers:{...CORS,"Content-Type":"application/json"} });
        try {
          const res  = await fetch(`${UAPI_BASE}/authorizations?include=meters`, {
            headers: { "Authorization": `Bearer ${api_key}`, "Accept": "application/json" }
          });
          const data = await res.json();
          console.log("[AMI] authorizations response:", JSON.stringify(data).slice(0, 500));
          const meters = [];
          (data.authorizations || []).forEach(auth => {
            // UtilityAPI nests meters as { meters: [...] } or directly as an array
            const meterList = Array.isArray(auth.meters) ? auth.meters
              : Array.isArray(auth.meters?.meters) ? auth.meters.meters
              : [];
            meterList.forEach(m => {
              meters.push({
                uid:             m.uid,
                utility:         auth.utility,
                service_address: m.blocks?.find(b => b.type === "BASE")?.service_address || null,
                status:          m.status,
                tariff:          m.blocks?.find(b => b.type === "BASE")?.service_tariff || null,
                interval_length: m.blocks?.find(b => b.type === "BASE")?.meter_interval_length || null
              });
            });
          });
          return new Response(JSON.stringify({ success:true, meters }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
        } catch(e) { return new Response(JSON.stringify({ success:false, error:e.message }), { status:500, headers:{...CORS,"Content-Type":"application/json"} }); }
      }

      // POST /ami/uapi/meter-status — check if meter data collection is complete
      if (url.pathname === "/ami/uapi/meter-status") {
        const { api_key, meter_uid } = body;
        if (!api_key || !meter_uid) return new Response(JSON.stringify({ success:false, error:"api_key and meter_uid required" }), { status:400, headers:{...CORS,"Content-Type":"application/json"} });
        try {
          const res  = await fetch(`${UAPI_BASE}/meters/${meter_uid}`, {
            headers: { "Authorization": `Bearer ${api_key}`, "Accept": "application/json" }
          });
          const data = await res.json();
          console.log(`[AMI meter-status] ${meter_uid}: status=${data.status} intervals=${data.interval_count}`);
          return new Response(JSON.stringify({
            success:        res.ok,
            status:         data.status,
            interval_count: data.interval_count || 0,
            bill_count:     data.bill_count     || 0
          }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
        } catch(e) { return new Response(JSON.stringify({ success:false, error:e.message }), { status:500, headers:{...CORS,"Content-Type":"application/json"} }); }
      }

      // POST /ami/uapi/collect — trigger UtilityAPI historical collection
      if (url.pathname === "/ami/uapi/collect") {
        const { api_key, meter_uid, type, duration_months = 6, frequency = "daily" } = body;
        if (!api_key || !meter_uid) return new Response(JSON.stringify({ success:false, error:"api_key and meter_uid required" }), { status:400, headers:{...CORS,"Content-Type":"application/json"} });
        try {
          let res, data, resText;
          if (type === "scheduled") {
            res  = await fetch(`${UAPI_BASE}/meters/ongoing-collection`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${api_key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ meters: [meter_uid], collection_frequency: frequency })
            });
          } else {
            res  = await fetch(`${UAPI_BASE}/meters/historical-collection?duration_months=${duration_months}`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${api_key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ meters: [meter_uid] })
            });
          }
          resText = await res.text();
          console.log(`[AMI collect] status=${res.status} body=${resText.slice(0,500)}`);
          try { data = JSON.parse(resText); } catch(e) { data = { raw: resText }; }
          if (!res.ok) {
            return new Response(JSON.stringify({ success:false, error:`UtilityAPI ${res.status}: ${resText.slice(0,200)}`, data }), { status:502, headers:{...CORS,"Content-Type":"application/json"} });
          }
          const collectionUid = data?.collection_uids?.[0] || data?.collections?.[0]?.uid || null;
          return new Response(JSON.stringify({ success:true, collection_uid: collectionUid, data }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
        } catch(e) {
          console.error("[AMI collect] error:", e.message);
          return new Response(JSON.stringify({ success:false, error:e.message }), { status:500, headers:{...CORS,"Content-Type":"application/json"} });
        }
      }

      // POST /ami/uapi/intervals — fetch interval readings from UtilityAPI
      if (url.pathname === "/ami/uapi/intervals") {
        const { api_key, meter_uid } = body;
        if (!api_key || !meter_uid) return new Response(JSON.stringify({ success:false, error:"api_key and meter_uid required" }), { status:400, headers:{...CORS,"Content-Type":"application/json"} });
        try {
          const res  = await fetch(`${UAPI_BASE}/intervals?meters=${meter_uid}`, {
            headers: { "Authorization": `Bearer ${api_key}`, "Accept": "application/json" }
          });
          const resText = await res.text();
          console.log(`[AMI intervals] status=${res.status} body=${resText.slice(0,1000)}`);
          let data;
          try { data = JSON.parse(resText); } catch(e) { data = { raw: resText }; }
          if (!res.ok) return new Response(JSON.stringify({ success:false, error:`UtilityAPI ${res.status}: ${resText.slice(0,200)}` }), { status:502, headers:{...CORS,"Content-Type":"application/json"} });
          // Normalize UtilityAPI interval format to our ami_readings format
          // Response structure: { intervals: [ { meter_uid, readings: [{start, end, kwh}] } ] }
          const intervals = [];
          (data.intervals || []).forEach(block => {
            const mUid = block.meter_uid || block.meter;
            (block.readings || []).forEach(iv => {
              if (!iv.start || iv.kwh == null) return;
              const startDt = new Date(iv.start);
              const endDt   = new Date(iv.end || new Date(startDt.getTime() + 3600000));
              const durHrs  = (endDt - startDt) / 3600000;
              const kw      = durHrs > 0 ? parseFloat((iv.kwh / durHrs).toFixed(4)) : null;
              intervals.push({
                meter_uid:      mUid,
                interval_start: startDt.toISOString(),
                interval_end:   endDt.toISOString(),
                kwh:            parseFloat(iv.kwh.toFixed(4)),
                kw,
                cost:           iv.cost != null ? parseFloat(iv.cost.toFixed(4)) : null,
                raw_fields:     iv,
                source_type:    "utilityapi"
              });
            });
          });
          console.log(`[AMI intervals] normalized ${intervals.length} readings`);
          return new Response(JSON.stringify({ success:true, intervals, count: intervals.length }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
        } catch(e) { return new Response(JSON.stringify({ success:false, error:e.message }), { status:500, headers:{...CORS,"Content-Type":"application/json"} }); }
      }

      // POST /ami/ingest — webhook endpoint for utility push data (Green Button Connect)
      if (url.pathname === "/ami/ingest") {
        // Accept pushed data from utility or UtilityAPI webhook
        // Parse and forward to Supabase
        try {
          const contentType = request.headers.get("content-type") || "";
          let intervals = [];
          if (contentType.includes("application/json")) {
            const pushed = body;
            intervals = pushed.intervals || [];
          } else if (contentType.includes("xml")) {
            // Green Button XML push — return 200 and log; full parse happens client-side
            console.log("[AMI webhook] Received Green Button XML push");
            await supabasePost("ami_collection_jobs", { job_type:"webhook", status:"received", created_at: new Date().toISOString() });
            return new Response(JSON.stringify({ success:true, message:"received" }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
          }
          if (intervals.length) {
            const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/ami_readings?on_conflict=meter_uid,interval_start`, {
              method:"POST",
              headers:{ "apikey":SUPABASE_KEY, "Authorization":`Bearer ${SUPABASE_KEY}`, "Content-Type":"application/json", "Prefer":"resolution=ignore-duplicates,return=minimal" },
              body: JSON.stringify(intervals)
            });
            return new Response(JSON.stringify({ success: supaRes.ok, count: intervals.length }), { status: supaRes.ok ? 200 : 502, headers:{...CORS,"Content-Type":"application/json"} });
          }
          return new Response(JSON.stringify({ success:true, message:"no intervals to ingest" }), { status:200, headers:{...CORS,"Content-Type":"application/json"} });
        } catch(e) { return new Response(JSON.stringify({ success:false, error:e.message }), { status:500, headers:{...CORS,"Content-Type":"application/json"} }); }
      }

      return new Response(JSON.stringify({ error:"Unknown AMI route" }), { status:404, headers:{...CORS,"Content-Type":"application/json"} });
    }

      return new Response(JSON.stringify({ error: "Unknown path", pathname: url.pathname }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const deviceUID  = request.headers.get("X-Device-UID") || DEVICE_UID;
    const notehubURL = `https://api.notefile.net/v1/projects/${PROJECT_UID}/devices/${encodeURIComponent(deviceUID)}/notes/data.qi`;
    const res = await fetch(notehubURL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${NOTEHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    const result = await res.text();
    return new Response(result, { status: res.status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
};