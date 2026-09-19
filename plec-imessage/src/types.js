/**
 * Shared shapes (JSDoc; the project is plain JS to match the repo).
 *
 * @typedef {string} ChatId  provider's group identifier, normalized
 * @typedef {string} Phone   E.164
 *
 * @typedef {object} InboundMessage
 * @property {string} id                      provider message id (dedupe key)
 * @property {ChatId} chatId
 * @property {boolean} isGroup
 * @property {Phone} from                     "agent" for our own messages in the transcript
 * @property {string} [fromName]
 * @property {string} text
 * @property {{ url: string, mimeType: string }[]} attachments
 * @property {{ type: string, targetMessageId: string }} [reaction]
 * @property {number} timestamp
 * @property {'live'|'screenshot'|'simulator'|'agent'} source
 *
 * @typedef {{ phone: Phone, name?: string, isOrganizer?: boolean }} Participant
 * @typedef {{ person: string, constraint: string, sourceMessageId?: string }} PersonConstraint
 *
 * @typedef {object} ChatPlan
 * @property {string} [eventType]
 * @property {string} [guestOfHonor]
 * @property {boolean} [isSurprise]
 * @property {{ date: string, worksFor: string[], doesNotWorkFor: string[] }[]} dateOptions
 * @property {{ value: number, confidence: 'low'|'medium'|'high', note?: string }} [headcount]
 * @property {{ max?: number, perPerson?: number, note?: string }} [budget]
 * @property {{ area?: string, maxTravelNote?: string }} [location]
 * @property {{ start?: string, end?: string }} [timeWindow]
 * @property {string} [contactEmail]          organizer email (needed for sandbox bookings)
 * @property {string[]} vibe
 * @property {string[]} dealbreakers
 * @property {PersonConstraint[]} personConstraints
 * @property {string[]} openQuestions
 * @property {string[]} decisions
 * @property {string[]} shortlist            venue ids proposed, in the numbered order sent
 * @property {Record<string, string[]>} votes venueId -> voter names
 * @property {'gathering'|'options_sent'|'voting'|'awaiting_confirmation'|'booked'} status
 * @property {number} lastUpdated
 *
 * @typedef {object} PendingAction
 * @property {string} id
 * @property {'create_booking'|'modify_booking'|'cancel_booking'} kind
 * @property {object} payload
 * @property {string} summaryText             exactly what was shown to the organizer
 * @property {number} requestedAt
 * @property {number} expiresAt               30 minutes
 *
 * @typedef {object} Booking
 * @property {string} id
 * @property {ChatId} chatId
 * @property {string} venueId
 * @property {string} venueName
 * @property {string} date
 * @property {string} startTime
 * @property {string} endTime
 * @property {number} headcount
 * @property {string[]} services
 * @property {Record<string, number>} priceBreakdown  dollars
 * @property {number} total
 * @property {number} deposit
 * @property {'confirmed'|'pending_payment'|'requested'|'cancelled'} status
 * @property {string} [paymentUrl]            sandbox only: guest pays here, never the agent
 * @property {string} [sandboxRef]
 * @property {number} createdAt
 * @property {{ at: number, change: string }[]} history
 *
 * @typedef {object} ChatState
 * @property {ChatId} chatId
 * @property {Participant[]} participants
 * @property {InboundMessage[]} transcript   capped at the last 300
 * @property {ChatPlan} plan
 * @property {PendingAction} [pendingAction]
 * @property {Booking[]} bookings
 * @property {boolean} introduced
 * @property {number} [lastAgentSpokeAt]
 * @property {number} messagesSinceAgentSpoke
 * @property {boolean} optedOut
 * @property {string[]} seenIds              last 1000 inbound ids (dedupe)
 * @property {{ at: number, speak: boolean, reason: string, intent?: string }[]} decisions  decision log
 */
export {};
