const { assessOfferReady, buildNote, noteFingerprint } = require('./qualify');
const { toE164 } = require('./phones');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_PIPELINE_NAME = 'SMS Blast Leads';

let missingConfigWarned = false;

function warnMissing(log) {
  if (missingConfigWarned) return;
  missingConfigWarned = true;
  log('[GHL] GHL_API_TOKEN or GHL_LOCATION_ID is not set. Skipping CRM push. The bot will keep running.');
}

async function ghlRequest(fetchImpl, token, path, { method = 'GET', body } = {}) {
  const resp = await fetchImpl(`${GHL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (_err) {
    data = null;
  }
  if (!resp.ok) {
    const err = new Error(`GHL ${method} ${path} failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return data || {};
}

async function resolvePipeline(fetchImpl, token, locationId, env, log) {
  if (env.GHL_PIPELINE_ID) {
    return {
      pipelineId: env.GHL_PIPELINE_ID,
      stageId: env.GHL_PIPELINE_STAGE_ID || '',
    };
  }
  const wanted = (env.GHL_PIPELINE_NAME || DEFAULT_PIPELINE_NAME).trim().toLowerCase();
  const data = await ghlRequest(fetchImpl, token, `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
  const pipelines = data.pipelines || [];
  const pipeline = pipelines.find((p) => String(p.name || '').trim().toLowerCase() === wanted);
  if (!pipeline) {
    log(`[GHL] Pipeline "${env.GHL_PIPELINE_NAME || DEFAULT_PIPELINE_NAME}" was not found. Contact and note will still be saved.`);
    return null;
  }
  const stages = pipeline.stages || [];
  const stage = env.GHL_PIPELINE_STAGE_ID
    ? stages.find((s) => (s.id || s._id) === env.GHL_PIPELINE_STAGE_ID) || { id: env.GHL_PIPELINE_STAGE_ID }
    : stages[0];
  return {
    pipelineId: pipeline.id,
    stageId: stage ? stage.id || stage._id || '' : '',
  };
}

/**
 * Create or update one offer-ready seller in GoHighLevel.
 * Later calls for the same seller add a note only.
 * Missing credentials are logged and ignored.
 */
async function syncSellerToGhl({ conversation, messages, env = process.env, fetchImpl = fetch, log = console.log, force = false }) {
  const assessment = assessOfferReady(messages, conversation);
  const blockedReasons = new Set(['opt_out', 'wrong_number', 'not_interested']);
  if (!assessment.ready && (!force || blockedReasons.has(assessment.reason))) {
    return { action: 'skipped', reason: assessment.reason, calls: [] };
  }

  const token = env.GHL_API_TOKEN && String(env.GHL_API_TOKEN).trim();
  const locationId = env.GHL_LOCATION_ID && String(env.GHL_LOCATION_ID).trim();
  if (!token || !locationId) {
    warnMissing(log);
    return { action: 'skipped', reason: 'missing_config', summary: assessment.summary };
  }

  const summary = assessment.summary;
  const fingerprint = noteFingerprint(messages);
  const existingContact = conversation && conversation.ghl_contact_id ? String(conversation.ghl_contact_id) : '';
  const existingOpp = conversation && conversation.ghl_opportunity_id ? String(conversation.ghl_opportunity_id) : '';
  const existingFingerprint = conversation && conversation.ghl_note_fingerprint ? String(conversation.ghl_note_fingerprint) : '';

  const note = buildNote(summary, messages);
  let contactId = existingContact;
  let opportunityId = existingOpp;
  let createdContact = false;
  let createdOpportunity = false;
  let wroteNote = false;

  try {
    if (!contactId) {
      const first = summary.name ? String(summary.name).trim().split(/\s+/)[0] : '';
      const payload = {
        locationId,
        phone: summary.phone || toE164(conversation.phone),
        source: 'NorCal SMS Agent',
      };
      if (first) payload.firstName = first;
      if (summary.name) payload.name = summary.name;
      if (summary.address && summary.address !== 'not given') payload.address1 = summary.address;
      const data = await ghlRequest(fetchImpl, token, '/contacts/upsert', { method: 'POST', body: payload });
      contactId = (data.contact && data.contact.id) || data.id || '';
      createdContact = true;
      if (!contactId) {
        log('[GHL] Contact upsert succeeded but no contact id was returned.');
        return { action: 'skipped', reason: 'no_contact_id', summary };
      }
    }

    if (fingerprint !== existingFingerprint) {
      const noteBody = { body: note };
      if (env.GHL_USER_ID) noteBody.userId = env.GHL_USER_ID;
      await ghlRequest(fetchImpl, token, `/contacts/${encodeURIComponent(contactId)}/notes`, {
        method: 'POST',
        body: noteBody,
      });
      wroteNote = true;
    }

    if (!opportunityId) {
      try {
        const pipeline = await resolvePipeline(fetchImpl, token, locationId, env, log);
        if (pipeline && pipeline.pipelineId) {
          const oppPayload = {
            pipelineId: pipeline.pipelineId,
            locationId,
            contactId,
            name: summary.address !== 'not given' ? summary.address : `SMS lead ${summary.phone || conversation.phone}`,
            status: 'open',
            source: 'SMS Blast',
          };
          if (pipeline.stageId) oppPayload.pipelineStageId = pipeline.stageId;
          const opp = await ghlRequest(fetchImpl, token, '/opportunities/upsert', { method: 'POST', body: oppPayload });
          opportunityId = (opp.opportunity && opp.opportunity.id) || '';
          createdOpportunity = true;
        }
      } catch (err) {
        log(`[GHL] Opportunity was not created (${err.status || 'error'}). The contact and note are still saved.`);
      }
    }
  } catch (err) {
    log(`[GHL] Push failed (${err.status || 'error'}). The bot will keep running.`);
    return {
      action: 'skipped',
      reason: 'api_error',
      contactId: contactId || '',
      opportunityId: opportunityId || '',
      summary,
    };
  }

  const action = createdContact ? 'created' : wroteNote || createdOpportunity ? 'updated' : 'unchanged';
  return {
    action,
    reason: 'offer_ready',
    contactId,
    opportunityId: opportunityId || '',
    fingerprint: wroteNote ? fingerprint : existingFingerprint,
    note: wroteNote ? note : '',
    summary,
    createdContact,
    createdOpportunity,
    wroteNote,
  };
}

function resetGhlWarnings() {
  missingConfigWarned = false;
}

module.exports = {
  syncSellerToGhl,
  resetGhlWarnings,
  GHL_BASE,
  DEFAULT_PIPELINE_NAME,
};
