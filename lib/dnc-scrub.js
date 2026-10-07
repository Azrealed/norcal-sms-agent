/**
 * Tracersfy DNC Scrub Integration
 * 
 * Scrubs phone numbers against:
 *   - Federal DNC registry
 *   - State DNC registries  
 *   - DMA suppression list
 *   - TCPA Litigator database
 * 
 * API: https://tracerfy.com/v1/api/dnc/scrub/
 * Docs: https://tracerfy.com/skip-tracing-api-documentation/
 */

const TRACERFY_BASE = 'https://tracerfy.com/v1/api';

/**
 * Submit phone numbers for DNC scrubbing
 * Returns a dnc_queue_id to poll for results
 */
async function submitDncScrub(apiKey, phones) {
  const url = `${TRACERFY_BASE}/dnc/scrub/`;
  
  // Normalize phones: strip + prefix for Tracersfy (they handle both, but strip anyway)
  const cleanPhones = phones.map(p => p.replace(/^\+/, ''));
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ phones: cleanPhones })
  });

  const data = await resp.json();
  
  if (!resp.ok) {
    throw new Error(`DNC scrub submission failed: ${resp.status} - ${JSON.stringify(data)}`);
  }

  return {
    queueId: data.dnc_queue_id,
    status: data.status,
    phonesToCheck: data.phones_to_check,
    creditsPerPhone: data.credits_per_phone
  };
}

/**
 * Poll DNC queue until complete, then fetch and parse results
 */
async function pollUntilComplete(apiKey, queueId, { pollIntervalMs = 3000, maxWaitMs = 300000 } = {}) {
  const startTime = Date.now();
  
  while (true) {
    const status = await getDncQueueStatus(apiKey, queueId);
    
    if (!status.pending) {
      return status;
    }
    
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(`DNC scrub timed out after ${maxWaitMs}ms for queue ${queueId}`);
    }
    
    console.log(`[DNC] Queue ${queueId} still pending (${status.rows_uploaded || '?'} phones)...`);
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Get DNC queue status and results
 */
async function getDncQueueStatus(apiKey, queueId) {
  const url = `${TRACERFY_BASE}/dnc/queue/${queueId}`;
  
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!resp.ok) {
    throw new Error(`DNC queue status failed: ${resp.status}`);
  }

  return resp.json();
}

/**
 * Download and parse DNC results CSV
 * Returns array of { phone, national_dnc, state_dnc, dma, litigator, phone_type, is_clean }
 */
async function fetchResultsCsv(downloadUrl) {
  const resp = await fetch(downloadUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download DNC results: ${resp.status}`);
  }
  
  const csv = await resp.text();
  return parseDncCsv(csv);
}

/**
 * Parse DNC CSV into structured array
 */
function parseDncCsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim());
  
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => {
      // Convert Y/N to boolean for DNC flags
      if (['national_dnc', 'state_dnc', 'dma', 'litigator'].includes(h)) {
        row[h] = values[idx] === 'Y';
      } else if (h === 'is_clean') {
        row[h] = values[idx] === 'Yes';
      } else {
        row[h] = values[idx] || '';
      }
    });
    results.push(row);
  }
  
  return results;
}

/**
 * Full DNC scrub pipeline: submit → poll → fetch → parse
 * 
 * @param {string} apiKey - Tracersfy API key
 * @param {string[]} phones - Array of phone numbers (with or without + prefix)
 * @returns {{ clean: string[], blocked: object[], fullResults: object[], stats: object }}
 */
async function scrubPhones(apiKey, phones, { pollIntervalMs, maxWaitMs } = {}) {
  if (!phones || phones.length === 0) {
    return { clean: [], blocked: [], fullResults: [], stats: { total: 0, clean: 0, blocked: 0 } };
  }

  console.log(`[DNC] Submitting ${phones.length} phones for DNC scrubbing...`);
  
  // Step 1: Submit
  const { queueId } = await submitDncScrub(apiKey, phones);
  console.log(`[DNC] Queue ${queueId} created, polling for results...`);
  
  // Step 2: Poll until complete
  const queueStatus = await pollUntilComplete(apiKey, queueId, { pollIntervalMs, maxWaitMs });
  console.log(`[DNC] Queue ${queueId} complete — ${queueStatus.phones_checked} checked, ${queueStatus.phones_clean} clean`);
  
  // Step 3: Download full results CSV
  const fullResults = await fetchResultsCsv(queueStatus.download_url);
  
  // Step 4: Split into clean and blocked
  const clean = fullResults.filter(r => r.is_clean).map(r => r.phone);
  const blocked = fullResults.filter(r => !r.is_clean);
  
  return {
    clean,
    blocked,
    fullResults,
    stats: {
      total: queueStatus.phones_checked,
      clean: queueStatus.phones_clean,
      blocked: queueStatus.phones_checked - queueStatus.phones_clean,
      creditsDeducted: queueStatus.credits_deducted
    }
  };
}

module.exports = {
  submitDncScrub,
  getDncQueueStatus,
  pollUntilComplete,
  fetchResultsCsv,
  parseDncCsv,
  scrubPhones
};
