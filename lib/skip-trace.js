/**
 * Skip Tracing Module
 * 
 * Converts property addresses → owner names + phone numbers.
 * 
 * Supports multiple providers via a clean abstraction.
 * Add new providers by implementing the Provider interface below.
 * 
 * Provider Interface:
 *   async searchByAddress(address: string): Promise<SkipTraceResult>
 *   
 *   SkipTraceResult = {
 *     phones: string[],        // E.164 formatted phone numbers
 *     ownerName: string,       // Owner name
 *     mailingAddress: string,  // Mailing address if different
 *     source: string,          // Provider name
 *     raw: object              // Raw provider response
 *   }
 */

// ── BatchLeads Provider ──
// API docs: https://batchleads.io (available in account dashboard)
// Authentication: Bearer token in Authorization header
// Endpoint: POST /v1/property/search or /v1/skip-trace (check docs)

class BatchLeadsProvider {
  constructor(apiKey, baseUrl = 'https://api.batchleads.io') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async searchByAddress(address) {
    const url = `${this.baseUrl}/v1/property/search`;
    
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          address: address,
          limit: 1
        })
      });

      const data = await resp.json();
      
      if (!resp.ok) {
        console.error(`[BatchLeads] Error ${resp.status}: ${JSON.stringify(data)}`);
        return null;
      }

      // Adapt BatchLeads response to standard format
      const result = data?.data?.[0] || data?.results?.[0] || data;
      
      return {
        phones: this.extractPhones(result),
        ownerName: result?.owner_name || result?.ownerName || result?.name || '',
        mailingAddress: result?.mailing_address || result?.mailingAddress || '',
        source: 'batchleads',
        raw: result
      };
    } catch (err) {
      console.error(`[BatchLeads] Error: ${err.message}`);
      return null;
    }
  }

  extractPhones(result) {
    const phones = new Set();
    const phoneFields = ['phone', 'phone_number', 'phone_1', 'phone_2', 'phone_3',
      'owner_phone', 'ownerPhone', 'cell_phone', 'home_phone', 'mobile_phone'];
    
    for (const field of phoneFields) {
      const val = result?.[field];
      if (val && typeof val === 'string' && val.replace(/[^\d]/g, '').length >= 10) {
        phones.add(this.normalizePhone(val));
      }
    }
    
    // Also check phones array
    if (result?.phones && Array.isArray(result.phones)) {
      for (const p of result.phones) {
        if (p && typeof p === 'string') phones.add(this.normalizePhone(p));
        if (p?.number) phones.add(this.normalizePhone(p.number));
      }
    }

    return [...phones];
  }

  normalizePhone(phone) {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('1') && cleaned.length === 11) return '+' + cleaned;
    if (cleaned.length === 10) return '+1' + cleaned;
    return cleaned;
  }
}

// ── PropertyRadar Provider ──
class PropertyRadarProvider {
  constructor(apiKey, baseUrl = 'https://api.propertyradar.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async searchByAddress(address) {
    const url = `${this.baseUrl}/v1/properties`;
    
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          criteria: [
            { field: 'Address', operator: 'eq', value: address }
          ],
          limit: 1,
          fields: ['Address', 'OwnerName', 'PhoneNumbers', 'MailingAddress']
        })
      });

      const data = await resp.json();
      
      if (!resp.ok) {
        console.error(`[PropertyRadar] Error ${resp.status}: ${JSON.stringify(data)}`);
        return null;
      }

      const result = data?.results?.[0] || data?.data?.[0] || data;
      
      return {
        phones: this.extractPhones(result),
        ownerName: result?.OwnerName || result?.ownerName || result?.owner_name || '',
        mailingAddress: result?.MailingAddress || result?.mailingAddress || '',
        source: 'propertyradar',
        raw: result
      };
    } catch (err) {
      console.error(`[PropertyRadar] Error: ${err.message}`);
      return null;
    }
  }

  extractPhones(result) {
    const phones = new Set();
    const phoneFields = ['PhoneNumbers', 'phoneNumbers', 'Phone', 'phone', 'OwnerPhone'];
    
    for (const field of phoneFields) {
      const val = result?.[field];
      if (!val) continue;
      
      if (typeof val === 'string') {
        phones.add(this.normalizePhone(val));
      } else if (Array.isArray(val)) {
        for (const p of val) {
          if (typeof p === 'string') phones.add(this.normalizePhone(p));
          if (p?.number) phones.add(this.normalizePhone(p.number));
          if (p?.Phone) phones.add(this.normalizePhone(p.Phone));
        }
      }
    }

    return [...phones];
  }

  normalizePhone(phone) {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('1') && cleaned.length === 11) return '+' + cleaned;
    if (cleaned.length === 10) return '+1' + cleaned;
    return cleaned;
  }
}

// ── TruePeopleSearch Provider (Free fallback) ──
// Scrapes truepeoplesearch.com for phone numbers
// NOTE: This is a free but slower option. Use BatchLeads or PropertyRadar for bulk.
class TruePeopleSearchProvider {
  constructor() {
    this.name = 'truepeoplesearch';
  }

  async searchByAddress(address) {
    try {
      // Encode address for URL
      const encoded = encodeURIComponent(address);
      const url = `https://www.truepeoplesearch.com/result?address=${encoded}`;
      
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SkipTrace/1.0)',
          'Accept': 'text/html'
        }
      });

      if (!resp.ok) {
        console.error(`[TruePeopleSearch] Error ${resp.status}`);
        return null;
      }

      const html = await resp.text();
      
      // Extract phone numbers from the page
      const phonePattern = /\(\d{3}\)\s*\d{3}-\d{4}/g;
      const phones = [...new Set(html.match(phonePattern) || [])]
        .map(p => '+1' + p.replace(/[^\d]/g, ''));

      // Try to extract name
      const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      const ownerName = nameMatch ? nameMatch[1].trim() : '';

      return {
        phones,
        ownerName,
        mailingAddress: '',
        source: 'truepeoplesearch',
        raw: null
      };
    } catch (err) {
      console.error(`[TruePeopleSearch] Error: ${err.message}`);
      return null;
    }
  }
}

// ── Skip Trace Engine ──
class SkipTraceEngine {
  constructor() {
    this.providers = [];
    this.defaultProvider = null;
  }

  /**
   * Register a provider. First registered is the default.
   */
  use(provider, isDefault = false) {
    this.providers.push(provider);
    if (isDefault || !this.defaultProvider) {
      this.defaultProvider = provider;
    }
  }

  /**
   * Skip trace a single address.
   * Tries providers in order, returns first successful result.
   */
  async traceOne(address, providerName = null) {
    const providers = providerName
      ? this.providers.filter(p => p.constructor.name.toLowerCase().includes(providerName.toLowerCase()))
      : this.providers;

    for (const provider of providers) {
      const result = await provider.searchByAddress(address);
      if (result && result.phones.length > 0) {
        return result;
      }
      if (result) {
        // Result but no phones — try next provider
        console.log(`[SkipTrace] ${provider.constructor.name} found owner but no phones for: ${address}`);
      }
    }

    return null;
  }

  /**
   * Skip trace multiple addresses in batch.
   * Returns results mapped by address.
   */
  async traceBatch(addresses, { onProgress, concurrency = 3, providerName } = {}) {
    const results = {};
    let completed = 0;
    let found = 0;

    // Process in chunks to control concurrency
    for (let i = 0; i < addresses.length; i += concurrency) {
      const chunk = addresses.slice(i, i + concurrency);
      
      const chunkResults = await Promise.all(
        chunk.map(async (addr) => {
          const result = await this.traceOne(addr, providerName);
          completed++;
          
          if (result && result.phones.length > 0) {
            found++;
          }
          
          if (onProgress) {
            onProgress({ completed, total: addresses.length, found, address: addr, result });
          }
          
          return { address: addr, result };
        })
      );

      for (const { address, result } of chunkResults) {
        results[address] = result;
      }

      // Small delay between chunks to be nice to the API
      if (i + concurrency < addresses.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return {
      results,
      stats: {
        total: addresses.length,
        found,
        notFound: addresses.length - found,
        rate: Math.round((found / addresses.length) * 100)
      }
    };
  }
}

// ── Factory: Create engine from environment ──
function createEngine() {
  const engine = new SkipTraceEngine();

  // BatchLeads
  if (process.env.BATCHLEADS_API_KEY) {
    engine.use(new BatchLeadsProvider(
      process.env.BATCHLEADS_API_KEY,
      process.env.BATCHLEADS_API_URL || 'https://api.batchleads.io'
    ), true);
  }

  // PropertyRadar
  if (process.env.PROPERTY_RADAR_KEY) {
    engine.use(new PropertyRadarProvider(
      process.env.PROPERTY_RADAR_KEY,
      process.env.PROPERTY_RADAR_URL || 'https://api.propertyradar.com'
    ));
  }

  // TruePeopleSearch (free fallback, always available)
  engine.use(new TruePeopleSearchProvider());

  return engine;
}

module.exports = {
  SkipTraceEngine,
  BatchLeadsProvider,
  PropertyRadarProvider,
  TruePeopleSearchProvider,
  createEngine
};
