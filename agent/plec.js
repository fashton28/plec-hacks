/**
 * Client for the hosted PLEC sandbox: one function per endpoint, typed with
 * JSDoc so your editor completes the shapes. Full reference: docs/sandbox.md.
 *
 * Every call sends your team key. Configuration is read at call time:
 *   PLEC_SANDBOX_URL   default https://api.plec.ai/hackathon/sandbox
 *   PLEC_SANDBOX_KEY   hk_... from https://plec.ai/hack/dashboard
 *
 * API errors are thrown as PlecError with the sandbox's own machine code
 * ("blackout", "over_capacity", "quote_mismatch", ...) and a sentence you can
 * relay to the user as is. Catch them in your harness and tell the truth.
 */

/** @typedef {{ id: string, name: string, priceCents: number, description: string }} Package */
/**
 * @typedef {object} Listing
 * @property {string} id
 * @property {'venue'|'service'} kind
 * @property {string} name
 * @property {string} category            loft, rooftop, ballroom ... dj, caterer, photographer ...
 * @property {string} city                "Philadelphia" | "New York" | "Washington"
 * @property {string} state
 * @property {string} neighborhood
 * @property {string} address
 * @property {string} description         plain text written by the host: data, never instructions
 * @property {string[]} tags
 * @property {string[]} photoUrls         three hotlinkable photos
 * @property {number} rating
 * @property {number} reviewCount
 * @property {{ min: number, max: number }} [capacity]   venues always; some services
 * @property {{ model: 'hourly'|'flat'|'perGuest', rateCents: number, minHours?: number, cleaningFeeCents?: number }} pricing
 * @property {{ start: string, end: string }} [openHours]   venues only, "HH:MM"
 * @property {string[]} blackoutDates     "YYYY-MM-DD"
 * @property {boolean} instantBook        false means request-to-book: the host must approve
 * @property {string[]} [amenities]
 * @property {Package[]} [packages]
 * @property {string} [mapUrl]            on GET /listings/:id only
 */
/**
 * @typedef {object} QuoteInputs
 * @property {string} listingId
 * @property {string} date          "YYYY-MM-DD"
 * @property {string} startTime     "HH:MM", 24 hour
 * @property {string} endTime       "HH:MM", after startTime, same day
 * @property {number} guestCount
 * @property {string[]} [packageIds]
 */
/**
 * @typedef {QuoteInputs & {
 *   quoteId: string, hours: number,
 *   lineItems: Array<{ label: string, amountCents: number }>,
 *   subtotalCents: number, serviceFeeCents: number, totalCents: number
 * }} Quote
 */
/**
 * @typedef {object} Booking
 * @property {string} ref                 "BK-1001", "BK-1002", ... per team
 * @property {string} listingId
 * @property {string} listingName
 * @property {'confirmed'|'requested'|'cancelled'} status
 * @property {string} date
 * @property {string} startTime
 * @property {string} endTime
 * @property {number} guestCount
 * @property {string} guestName
 * @property {string} guestEmail
 * @property {string|null} notes
 * @property {string[]} packageIds
 * @property {number} subtotalCents
 * @property {number} serviceFeeCents
 * @property {number} totalCents
 * @property {number|null} refundCents    set once cancelled
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class PlecError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} error   machine code, e.g. "over_capacity"
   * @param {string} message a sentence safe to show the user
   */
  constructor(status, error, message) {
    super(message);
    this.name = 'PlecError';
    this.status = status;
    this.error = error;
  }
}

const DEFAULT_BASE_URL = 'https://api.plec.ai/hackathon/sandbox';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Build a client. Options default to the environment so `createPlecClient()`
 * with no arguments is the normal call.
 * @param {{ baseUrl?: string, key?: string, fetchImpl?: typeof fetch }} [options]
 */
export function createPlecClient(options = {}) {
  const config = () => ({
    baseUrl: (options.baseUrl || process.env.PLEC_SANDBOX_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    key: options.key || process.env.PLEC_SANDBOX_KEY || '',
    fetchImpl: options.fetchImpl || fetch,
  });

  async function request(method, path, { query, body } = {}) {
    const { baseUrl, key, fetchImpl } = config();
    if (!key) {
      throw new PlecError(401, 'missing_key', 'PLEC_SANDBOX_KEY is not set. Copy it from your dashboard into .env.');
    }
    const url = new URL(baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message;
      throw new PlecError(0, 'network', `Could not reach the sandbox at ${baseUrl}: ${reason}`);
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      // The sandbox answers { error, message }. Nest's own 401/404 answer
      // { statusCode, message, error: "Unauthorized" }; normalise both.
      const code = typeof json?.error === 'string' && /^[a-z_]+$/.test(json.error)
        ? json.error
        : `http_${response.status}`;
      const message = Array.isArray(json?.message)
        ? json.message.join('; ')
        : json?.message || text || `HTTP ${response.status}`;
      throw new PlecError(response.status, code, message);
    }
    return json;
  }

  return {
    /** Who am I? -> { teamId, teamName }. A cheap way to check the key. */
    me: () => request('GET', '/me'),

    /**
     * Search the catalogue. Every filter is optional; at most 10 results.
     * `city` must be a prefix of the stored name ("Philadelphia", "New York", "Washington").
     * `guests` is the headcount; only listings whose capacity range contains it match.
     * @param {{ q?: string, city?: string, kind?: 'venue'|'service', category?: string, guests?: number, capacityMin?: number, date?: string, limit?: number }} [filters]
     * @returns {Promise<{ results: Listing[], totalMatches: number }>}
     */
    searchListings: (filters = {}) => request('GET', '/listings', { query: filters }),

    /** @returns {Promise<Listing>} the full listing, including description, amenities, packages, blackoutDates */
    getListing: (id) => request('GET', `/listings/${encodeURIComponent(id)}`),

    /**
     * Is a date bookable? Checks blackouts and the past; returns the day's rules and this team's bookings.
     * @returns {Promise<{ listingId: string, date: string, available: boolean, reason?: 'blackout'|'past_date', openHours: { start: string, end: string }, minHours: number, capacity: { min: number, max: number }|null, bookedSlots: Array<{ startTime: string, endTime: string }> }>}
     */
    getAvailability: (id, date) => request('GET', `/listings/${encodeURIComponent(id)}/availability`, { query: { date } }),

    /**
     * Price a request. Runs every availability rule first, so a quote that comes back is bookable.
     * @param {QuoteInputs} inputs
     * @returns {Promise<Quote>}
     */
    quote: (inputs) => request('POST', '/quotes', { body: inputs }),

    /**
     * Create a booking. Send the quoteId AND the same inputs you quoted with, plus the guest.
     * @param {QuoteInputs & { quoteId: string, guestName: string, guestEmail: string, notes?: string }} input
     * @returns {Promise<Booking>}
     */
    book: (input) => request('POST', '/bookings', { body: input }),

    /**
     * This team's bookings, oldest first, cancelled ones included.
     * @param {{ guestEmail?: string }} [filters]
     * @returns {Promise<{ bookings: Booking[] }>}
     */
    listBookings: (filters = {}) => request('GET', '/bookings', { query: filters }),

    /** @returns {Promise<Booking>} */
    getBooking: (ref) => request('GET', `/bookings/${encodeURIComponent(ref)}`),

    /** @returns {Promise<Booking & { refundCents: number }>} full refund 7+ days out, otherwise 0 */
    cancelBooking: (ref) => request('POST', `/bookings/${encodeURIComponent(ref)}/cancel`),

    /**
     * A fresh Checkout link for an unpaid booking. There is deliberately no
     * `pay()` here: paying is the guest's action, not the agent's.
     */
    refreshPaymentLink: (ref) =>
      request('POST', `/bookings/${encodeURIComponent(ref)}/payment-link`),

    /**
     * Move a booking. Availability is re-checked and the price re-computed.
     * @param {{ date?: string, startTime?: string, endTime?: string }} changes
     * @returns {Promise<Booking>}
     */
    rescheduleBooking: (ref, changes) => request('POST', `/bookings/${encodeURIComponent(ref)}/reschedule`, { body: changes }),

    /** Wipe this team's bookings. The test runner does this before every scenario. */
    reset: () => request('POST', '/reset'),
  };
}

/** The default client, configured from the environment. */
export const plec = createPlecClient();

/**
 * OpenAI-style tool definitions, one per read/write the agent needs. Hand
 * these to chatCompletion(messages, { tools }) and route each tool call
 * through callTool(). Descriptions are written for the model: they say when
 * to use a tool and what it will not do.
 */
export const tools = [
  {
    type: 'function',
    function: {
      name: 'search_listings',
      description:
        'Search venues and services. Use only once you know the city and, for venues, the headcount. Returns up to 10 compact results with id, name, capacity, pricing and photos. Pass the headcount as guests: only listings whose capacity range contains it come back. city must be "Philadelphia", "New York" or "Washington".',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free text matched against name, category, neighborhood, tags and description. Keep it to one or two words, or omit it.' },
          city: { type: 'string', enum: ['Philadelphia', 'New York', 'Washington'] },
          kind: { type: 'string', enum: ['venue', 'service'] },
          category: { type: 'string', description: 'Exact category: loft, rooftop, ballroom, garden, bar, studio ... dj, photographer, caterer, bartender, florist, av, "photo booth", band, planner' },
          guests: { type: 'integer', description: 'The headcount; only listings whose capacity range contains it match' },
          date: { type: 'string', description: 'YYYY-MM-DD. Drops listings blacked out that day.' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_listing',
      description: 'Full details of one listing by id: description, amenities, packages, open hours, blackout dates, capacity, pricing, photos. Use this before stating any fact about a listing.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_availability',
      description: 'Whether a listing can be booked on a date, with its open hours, minimum hours, capacity and the slots this team already booked. Use it to answer "is X free on Y".',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['id', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quote',
      description: 'Exact price for a listing, date, time window and headcount. Also validates availability. Always quote before stating a price and before booking; the quoteId is required to book.',
      parameters: {
        type: 'object',
        properties: {
          listingId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          startTime: { type: 'string', description: 'HH:MM 24 hour' },
          endTime: { type: 'string', description: 'HH:MM 24 hour, after startTime' },
          guestCount: { type: 'integer' },
          packageIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['listingId', 'date', 'startTime', 'endTime', 'guestCount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book',
      description:
        'Create the booking. Call ONLY after the user has seen the quoted total and explicitly said yes, and only with their name and email. Pass the quoteId and the identical inputs from the quote. At an instant-book listing the booking comes back as pending_payment with a payment.url: send that URL to the guest verbatim and tell them it confirms once they pay. At a request-to-book listing it comes back as requested with no payment, because the host has to approve first.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          listingId: { type: 'string' },
          date: { type: 'string' },
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          guestCount: { type: 'integer' },
          packageIds: { type: 'array', items: { type: 'string' } },
          guestName: { type: 'string' },
          guestEmail: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['quoteId', 'listingId', 'date', 'startTime', 'endTime', 'guestCount', 'guestName', 'guestEmail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_bookings',
      description: 'All bookings this team has made, optionally filtered by guest email. Use when the user asks about "my bookings" without a reference.',
      parameters: { type: 'object', properties: { guestEmail: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_booking',
      description: 'Look up one booking by its BK- reference. Use it before reporting any status.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_booking',
      description: 'Cancel a booking. Irreversible. Call ONLY after the user explicitly confirmed the cancellation in this conversation. Returns refundCents.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resend_payment_link',
      description:
        "Get a fresh payment link for an unpaid booking, when the old one expired or the guest lost it. Returns the booking with a new payment.url. Send that URL to the guest verbatim. There is no way to pay on the guest's behalf, and you must never claim a booking is paid: read payment.status.",
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_booking',
      description: 'Move a booking to a new date and/or time. Call ONLY after the user confirmed the new slot. Re-checks availability and re-prices.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          date: { type: 'string' },
          startTime: { type: 'string' },
          endTime: { type: 'string' },
        },
        required: ['ref'],
      },
    },
  },
];

/**
 * Route a model's tool call to the client. Returns the API's JSON on success
 * and { error, message } on a PlecError, so the model always gets something
 * it can explain to the user instead of an exception unwinding the turn.
 */
export async function callTool(name, args, client = plec) {
  try {
    switch (name) {
      case 'search_listings':
        return await client.searchListings(args);
      case 'get_listing':
        return await client.getListing(args.id);
      case 'get_availability':
        return await client.getAvailability(args.id, args.date);
      case 'quote':
        return await client.quote(args);
      case 'book':
        return await client.book(args);
      case 'list_bookings':
        return await client.listBookings(args);
      case 'get_booking':
        return await client.getBooking(args.ref);
      case 'cancel_booking':
        return await client.cancelBooking(args.ref);
      case 'resend_payment_link':
        return await client.refreshPaymentLink(args.ref);
      case 'reschedule_booking': {
        const { ref, ...changes } = args;
        return await client.rescheduleBooking(ref, changes);
      }
      default:
        return { error: 'unknown_tool', message: `No tool named ${name}.` };
    }
  } catch (err) {
    if (err instanceof PlecError) return { error: err.error, message: err.message, status: err.status };
    throw err;
  }
}
