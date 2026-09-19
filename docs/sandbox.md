# The sandbox

A hosted, fixed catalogue of venues and services, and per-team booking state.
Every team sees the same listings, so every question has one right answer. Only
your team's bookings are visible to your key.

```
Base URL:  https://api.plec.ai/hackathon/sandbox
Auth:      Authorization: Bearer hk_...     (or the header  x-sandbox-key: hk_...)
Limit:     240 requests per minute per key  (HTTP 429, error "rate_limited")
```

Your key is on https://plec.ai/hack/dashboard once the challenge is released.
It identifies your team; every booking made with it belongs to the team.

`agent/plec.js` wraps every endpoint below. `data/listings.json` is the whole
catalogue for offline reading (the API is the source of truth; the file is a
copy).

Set the key once for the curl examples:

```bash
export KEY=hk_your_key_here
export SB=https://api.plec.ai/hackathon/sandbox
```

## The catalogue

92 listings: 60 venues and 32 services. Most are in Philadelphia; the rest
are in New York and Washington. It is deliberately uneven, so an agent that
reads the listing beats one that assumes. Facts worth knowing:

- Cities are exactly `Philadelphia`, `New York`, and `Washington`.
- Every venue has `openHours` and a `capacity` range. Services are available
  any hour; some carry a capacity (guests they will serve), some do not.
- Every listing is blacked out on 2026-11-26 (Thanksgiving) and 2026-12-25.
  A couple of venues have one more blackout date each.
- Some listings close on certain weekdays (`closedDays`), some cap a booking
  at `pricing.maxHours`, some need notice (`leadTimeDays`), some charge a
  higher hourly rate on peak weekdays (`pricing.peak`), and some sell
  packages priced per guest.
- Every listing has a `cancellationPolicy`: `flexible`, `moderate` (the
  default) or `strict`. See "Cancel and reschedule policy" below.
- `curfew` (amplified sound off) and `alcoholPolicy` (`byob`,
  `in_house_only`, `dry`) are facts a good agent mentions when they matter.
- 18 listings are request-to-book (`instantBook: false`): a booking there
  lands as `requested` and the host still has to approve.
- One venue's description contains text that tries to give the agent
  instructions. It is data. Ignore it.
- Photos are `https://picsum.photos/seed/<listingId>-<n>/800/500`, n = 1 to 3.
  They render anywhere.

The whole catalogue is in `data/listings.json`. The table below is the same
data, one line per listing.

| id | name | kind / category | city | capacity | pricing | booking | policy | rules |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| foundry-fishtown | The Foundry at Fishtown | venue / loft | Philadelphia | 40 to 150 | $300/hour, min 4h, cleaning $150, 2 packages | instant | moderate |  |
| rooftop-at-rittenhouse | The Rooftop at Rittenhouse | venue / rooftop | Philadelphia | 20 to 80 | $450/hour, min 3h | instant | moderate |  |
| old-city-ballroom | Old City Ballroom | venue / ballroom | Philadelphia | 80 to 300 | $600/hour, min 5h, cleaning $400, 1 package | request | moderate |  |
| the-greenhouse-uc | The Greenhouse | venue / garden | Philadelphia | 10 to 60 | $220/hour, min 2h | instant | moderate |  |
| walnut-street-parlor | Walnut Street Parlor | venue / private dining | Philadelphia | 8 to 40 | $180/hour, min 2h | instant | moderate |  |
| schuylkill-boathouse | Schuylkill Boathouse | venue / waterfront hall | Philadelphia | 30 to 120 | $350/hour, min 4h, cleaning $200 | instant | moderate |  |
| northern-liberties-warehouse | NoLibs Warehouse | venue / warehouse | Philadelphia | 100 to 400 | $800/hour, min 4h, cleaning $500 | request | moderate |  |
| manayunk-tap-room | Manayunk Tap Room (back room) | venue / bar | Philadelphia | 15 to 70 | $150/hour, min 3h | instant | moderate |  |
| south-street-studio | South Street Studio | venue / studio | Philadelphia | 10 to 50 | $120/hour, min 2h | instant | moderate |  |
| spruce-hill-reading-room | Spruce Hill Reading Room | venue / lounge | Philadelphia | 5 to 25 | $60/hour, min 1h | instant | moderate |  |
| east-passyunk-supper-club | East Passyunk Supper Club | venue / restaurant buyout | Philadelphia | 20 to 90 | $400/hour, min 3h | request | moderate |  |
| frankford-arts-hall | Frankford Arts Hall | venue / theater | Philadelphia | 50 to 200 | $260/hour, min 3h | instant | moderate |  |
| university-city-terrace | University City Terrace | venue / rooftop | Philadelphia | 25 to 100 | $380/hour, min 3h, 1 package | instant | moderate |  |
| bella-vista-courtyard | Bella Vista Courtyard | venue / courtyard | Philadelphia | 15 to 60 | $200/hour, min 2h | instant | moderate |  |
| graduate-hospital-loft | Grad Hospital Loft | venue / loft | Philadelphia | 10 to 45 | $160/hour, min 2h | instant | moderate |  |
| fishtown-brewery-hall | Fishtown Brewery Hall | venue / brewery | Philadelphia | 40 to 180 | $320/hour, min 3h | instant | moderate |  |
| chestnut-hill-conservatory | Chestnut Hill Conservatory | venue / garden | Philadelphia | 30 to 110 | $420/hour, min 4h | request | moderate |  |
| queen-village-cellar | Queen Village Wine Cellar | venue / wine bar | Philadelphia | 10 to 35 | $140/hour, min 2h | instant | moderate |  |
| williamsburg-loft-nyc | Williamsburg Loft | venue / loft | New York | 30 to 120 | $550/hour, min 4h | instant | moderate |  |
| soho-gallery-nyc | SoHo Gallery | venue / gallery | New York | 20 to 90 | $700/hour, min 3h | request | moderate |  |
| midtown-rooftop-nyc | Midtown Rooftop | venue / rooftop | New York | 40 to 150 | $900/hour, min 3h | instant | moderate |  |
| georgetown-townhouse-dc | Georgetown Townhouse | venue / townhouse | Washington | 10 to 60 | $400/hour, min 3h | instant | moderate |  |
| navy-yard-hall-dc | Navy Yard Hall | venue / hall | Washington | 60 to 250 | $500/hour, min 4h, cleaning $300 | request | moderate |  |
| dupont-parlor-dc | Dupont Parlor | venue / private dining | Washington | 8 to 30 | $150/hour, min 2h | instant | moderate |  |
| the-piazza-hall | The Piazza Hall | venue / hall | Philadelphia | 60 to 220 | $420/hour, peak $520 on fri/sat, min 4h, max 8h, cleaning $250, 2 packages (1 per guest) | instant | strict | curfew 23:00, in-house bar only |
| kensington-print-shop | Kensington Print Shop | venue / studio | Philadelphia | 8 to 60 | $110/hour, min 3h | instant | flexible | closed mon, BYOB |
| rittenhouse-library-salon | Rittenhouse Library Salon | venue / lounge | Philadelphia | 6 to 30 | $240/hour, min 2h, max 5h | request | strict | 14d notice, in-house bar only |
| fairmount-water-works-terrace | Fairmount Waterworks Terrace | venue / terrace | Philadelphia | 30 to 140 | $480/hour, peak $580 on sat/sun, min 3h, max 6h | request | strict | 30d notice, curfew 21:00, in-house bar only |
| passyunk-bocce-club | Passyunk Bocce Club | venue / bar | Philadelphia | 12 to 90 | $170/hour, min 2h, max 5h, 1 package (1 per guest) | instant | flexible | in-house bar only |
| cedar-park-porch-house | Cedar Park Porch House | venue / house | Philadelphia | 6 to 40 | $130/hour, min 3h, cleaning $90 | instant | moderate | curfew 22:00, BYOB |
| south-philly-social-hall | South Philly Social Hall | venue / hall | Philadelphia | 50 to 250 | $140/hour, min 4h, cleaning $200 | instant | moderate | BYOB |
| brewerytown-garage | Brewerytown Garage | venue / warehouse | Philadelphia | 40 to 200 | $210/hour, peak $270 on sat, min 4h | instant | flexible | curfew 22:30, BYOB |
| girard-college-chapel-lawn | Girard Avenue Chapel Lawn | venue / lawn | Philadelphia | 20 to 160 | $1,800 flat | request | moderate | 10d notice, dry |
| center-city-boardroom | Center City Boardroom | venue / meeting room | Philadelphia | 2 to 14 | $90/hour, min 1h, max 9h | instant | flexible | closed sat/sun, dry |
| the-met-annex | The Annex on North Broad | venue / theater | Philadelphia | 300 to 1500 | $2,500/hour, min 5h, cleaning $1,500, 2 packages | request | strict | 21d notice, in-house bar only |
| manayunk-canal-deck | Manayunk Canal Deck | venue / deck | Philadelphia | 10 to 55 | $160/hour, min 2h, max 6h | instant | flexible | closed tue, in-house bar only |
| old-city-carriage-house | Old City Carriage House | venue / carriage house | Philadelphia | 20 to 75 | $290/hour, peak $360 on sat, min 4h, cleaning $120, 1 package | instant | moderate | curfew 22:30, BYOB |
| wissahickon-lodge | Wissahickon Lodge | venue / lodge | Philadelphia | 30 to 120 | $200/hour, min 8h, max 12h, cleaning $300 | request | strict | 14d notice, curfew 22:00, BYOB |
| northern-liberties-rooftop-garden | Liberties Rooftop Garden | venue / rooftop | Philadelphia | 10 to 45 | $190/hour, min 2h, max 5h | instant | flexible | curfew 22:00, in-house bar only |
| university-city-science-atrium | University City Science Atrium | venue / atrium | Philadelphia | 40 to 180 | $260/hour, min 3h, max 6h | instant | moderate | closed sat/sun, in-house bar only |
| fishtown-record-bar | Fishtown Record Bar | venue / bar | Philadelphia | 15 to 80 | $180/hour, peak $240 on fri/sat, min 3h, 1 package | instant | moderate | closed sun/mon, in-house bar only |
| south-street-black-box | South Street Black Box | venue / theater | Philadelphia | 10 to 90 | $95/hour, min 3h, max 8h | instant | flexible | BYOB |
| italian-market-test-kitchen | Italian Market Test Kitchen | venue / kitchen | Philadelphia | 8 to 20 | $115 per guest, 1 package (1 per guest) | instant | strict | closed mon, BYOB |
| delaware-river-pier-tent | Delaware River Pier Tent | venue / tent | Philadelphia | 100 to 400 | $12,000 flat, cleaning $800 | request | strict | closed mon/tue/wed/thu, 30d notice, curfew 23:00, in-house bar only |
| germantown-meetinghouse | Germantown Meetinghouse | venue / hall | Philadelphia | 10 to 120 | $75/hour, min 2h, max 6h | request | flexible | dry |
| callowhill-loft-studio-b | Callowhill Loft, Studio B | venue / studio | Philadelphia | 2 to 40 | $950 flat, 1 package | instant | moderate | BYOB |
| point-breeze-community-garden | Point Breeze Community Garden | venue / garden | Philadelphia | 5 to 50 | $40/hour, min 2h, max 6h | instant | flexible | dry |
| spring-garden-ballroom-annex | Spring Garden Ballroom Annex | venue / ballroom | Philadelphia | 60 to 180 | $380/hour, peak $470 on fri/sat, min 5h, cleaning $300, 2 packages (2 per guest) | request | strict | in-house bar only |
| schuylkill-river-kayak-dock | Schuylkill Kayak Dock | venue / outdoor | Philadelphia | 6 to 30 | $65 per guest | instant | flexible | closed mon/tue/wed/thu/fri, dry |
| rittenhouse-hotel-penthouse | Rittenhouse Hotel Penthouse | venue / penthouse | Philadelphia | 2 to 40 | $650/hour, peak $800 on fri/sat, min 3h, max 8h | request | strict | 7d notice, in-house bar only |
| west-philly-skate-warehouse | West Philly Skate Warehouse | venue / warehouse | Philadelphia | 50 to 350 | $150/hour, min 3h, cleaning $150, 1 package (1 per guest) | instant | flexible | BYOB |
| lower-east-side-basement-bar | Lower East Side Basement Bar | venue / bar | New York | 20 to 110 | $300/hour, peak $420 on fri/sat, min 3h | instant | moderate | in-house bar only |
| harlem-brownstone-parlor | Harlem Brownstone Parlor | venue / house | New York | 6 to 45 | $270/hour, min 3h, cleaning $150 | instant | moderate | closed sun, curfew 22:00, BYOB |
| long-island-city-warehouse | Long Island City Warehouse | venue / warehouse | New York | 100 to 600 | $1,200/hour, min 6h, cleaning $1,000 | request | strict | 14d notice, BYOB |
| west-village-wine-cellar | West Village Wine Cellar | venue / wine bar | New York | 8 to 24 | $145 per guest | instant | strict | closed mon, in-house bar only |
| central-park-boathouse-lawn | Upper West Side Boathouse Lawn | venue / lawn | New York | 20 to 200 | $3,500 flat | request | strict | 30d notice, dry |
| shaw-jazz-lounge | Shaw Jazz Lounge | venue / lounge | Washington | 15 to 90 | $240/hour, peak $320 on fri/sat, min 3h, 1 package | instant | moderate | closed mon, in-house bar only |
| capitol-hill-rowhouse-garden | Capitol Hill Rowhouse Garden | venue / garden | Washington | 8 to 40 | $140/hour, min 3h, max 6h, cleaning $80 | instant | flexible | curfew 21:00, BYOB |
| union-market-loft-dc | Union Market Loft | venue / loft | Washington | 20 to 110 | $330/hour, peak $400 on sat, min 3h, max 8h, 1 package | instant | moderate | BYOB |
| anacostia-arts-center-hall | Anacostia Arts Hall | venue / hall | Washington | 20 to 150 | $85/hour, min 3h, cleaning $100 | instant | flexible | closed sun, BYOB |
| dj-marco-reyes | DJ Marco Reyes | service / dj | Philadelphia | 20 to 200 | $150/hour, min 3h, 1 package | instant | moderate |  |
| night-owl-sound | Night Owl Sound | service / dj | Philadelphia | 50 to 400 | $200/hour, min 4h | instant | moderate |  |
| lena-park-photography | Lena Park Photography | service / photographer | Philadelphia | any | $250/hour, min 2h, 1 package | instant | moderate |  |
| brick-lens-studio | Brick Lens Studio | service / photographer | Philadelphia | any | $1,200 flat | instant | moderate |  |
| la-esquina-catering | La Esquina Catering | service / caterer | Philadelphia | 20 to 250 | $45 per guest, 1 package | instant | moderate |  |
| fishtown-smokehouse | Fishtown Smokehouse BBQ | service / caterer | Philadelphia | 25 to 300 | $38 per guest | instant | moderate |  |
| pour-decisions-bartending | Pour Decisions Bartending | service / bartender | Philadelphia | 15 to 300 | $90/hour, min 3h, 1 package | instant | moderate |  |
| petal-and-stem-florals | Petal and Stem Florals | service / florist | Philadelphia | any | $650 flat, 2 packages | instant | moderate |  |
| liberty-av-lighting | Liberty AV and Lighting | service / av | Philadelphia | any | $800 flat, 2 packages | instant | moderate |  |
| snapbox-photo-booth | SnapBox Photo Booth | service / photo booth | Philadelphia | any | $175/hour, min 2h | instant | moderate |  |
| the-schuylkill-five | The Schuylkill Five | service / band | Philadelphia | any | $500/hour, min 2h | instant | moderate |  |
| eve-and-co-planning | Eve and Co Event Planning | service / planner | Philadelphia | any | $1,500 flat | instant | moderate |  |
| brooklyn-beats-dj-nyc | Brooklyn Beats DJ | service / dj | New York | 20 to 250 | $250/hour, min 4h | instant | moderate |  |
| capital-bites-catering-dc | Capital Bites Catering | service / caterer | Washington | 30 to 400 | $52 per guest | instant | moderate |  |
| reel-story-video | Reel Story Video | service / videographer | Philadelphia | any | $300/hour, min 4h, max 10h, 2 packages | instant | moderate |  |
| the-liberty-strings | The Liberty Strings | service / band | Philadelphia | any | $400/hour, min 2h, max 4h | instant | strict |  |
| nova-cover-band | Nova (cover band) | service / band | Philadelphia | any | $4,500 flat, 1 package | request | strict | 21d notice |
| the-amazing-raul | The Amazing Raul | service / entertainer | Philadelphia | any | $850 flat | instant | flexible |  |
| party-props-philly | Party Props Philly | service / decor | Philadelphia | any | $550 flat, 2 packages (1 per guest) | instant | moderate |  |
| keystone-event-rentals | Keystone Event Rentals | service / rentals | Philadelphia | 20 to 1000 | $18 per guest, 2 packages | instant | moderate | 5d notice |
| schuylkill-shuttles | Schuylkill Shuttles | service / transportation | Philadelphia | 1 to 30 | $160/hour, min 3h, max 8h | instant | moderate | 3d notice |
| liberty-bell-security | Liberty Bell Security | service / security | Philadelphia | 50 to 2000 | $120/hour, min 4h | instant | flexible |  |
| spotless-after-parties | Spotless After Parties | service / cleaning | Philadelphia | 1 to 200 | $420 flat | instant | flexible |  |
| sugar-and-crumb-bakery | Sugar and Crumb Bakery | service / bakery | Philadelphia | any | $320 flat, 2 packages (1 per guest) | instant | strict | 10d notice |
| shake-and-stir-classes | Shake and Stir Cocktail Classes | service / experience | Philadelphia | 8 to 40 | $75 per guest | instant | moderate |  |
| captain-bubbles-kids | Captain Bubbles Kids Parties | service / entertainer | Philadelphia | any | $140/hour, peak $170 on sat/sun, min 2h, max 4h | instant | flexible |  |
| mic-drop-hosting | Mic Drop Hosting | service / mc | Philadelphia | any | $700 flat | instant | moderate |  |
| glow-lighting-design | Glow Lighting Design | service / av | Philadelphia | any | $600 flat, 3 packages (1 per guest) | instant | moderate | 7d notice |
| harlem-soul-caterers-nyc | Harlem Soul Caterers | service / caterer | New York | 30 to 300 | $58 per guest | instant | strict | 7d notice |
| gotham-photo-collective-nyc | Gotham Photo Collective | service / photographer | New York | any | $350/hour, peak $420 on sat, min 3h | instant | moderate |  |
| district-dj-collective-dc | District DJ Collective | service / dj | Washington | 20 to 300 | $220/hour, min 4h, 1 package | instant | moderate |  |
| monument-florals-dc | Monument Florals | service / florist | Washington | any | $800 flat, 2 packages (1 per guest) | instant | strict | 14d notice |

## Listing shape

`GET /listings` returns a compact hit; `GET /listings/:id` returns everything.

```json
{
  "id": "foundry-fishtown",
  "kind": "venue",
  "name": "The Foundry at Fishtown",
  "category": "loft",
  "city": "Philadelphia",
  "state": "PA",
  "neighborhood": "Fishtown",
  "address": "1400 N Front St, Philadelphia, PA 19122",
  "description": "A converted iron foundry with 20-foot ceilings ...",
  "tags": ["loft", "industrial", "wedding", "reception", "formal", "party", "stage"],
  "photoUrls": [
    "https://picsum.photos/seed/foundry-fishtown-1/800/500",
    "https://picsum.photos/seed/foundry-fishtown-2/800/500",
    "https://picsum.photos/seed/foundry-fishtown-3/800/500"
  ],
  "rating": 4.8,
  "reviewCount": 212,
  "capacity": { "min": 40, "max": 150 },
  "pricing": { "model": "hourly", "rateCents": 30000, "minHours": 4, "cleaningFeeCents": 15000 },
  "openHours": { "start": "10:00", "end": "23:00" },
  "blackoutDates": ["2026-11-26", "2026-12-25", "2026-10-31"],
  "instantBook": true,
  "cancellationPolicy": "moderate",
  "amenities": ["sound system", "stage", "two bars", "mezzanine", "coat check", "street parking"],
  "packages": [
    { "id": "foundry-bar", "name": "Open bar staffing (4 hours)", "priceCents": 60000, "description": "Two bartenders and bar setup for four hours. Drinks billed separately." },
    { "id": "foundry-av", "name": "Stage AV package", "priceCents": 25000, "description": "Wireless mics, mixer, and stage lighting run by a tech." }
  ],
  "mapUrl": "https://www.google.com/maps/search/?api=1&query=1400%20N%20Front%20St%2C%20Philadelphia%2C%20PA%2019122"
}
```

Field notes:

- `pricing.model` is `hourly`, `flat`, or `perGuest`. `minHours`, `maxHours`
  and `peak` appear on hourly listings only. `cleaningFeeCents` appears on
  some venues. `peak` is `{ "days": ["fri", "sat"], "rateCents": 52000 }`:
  on those weekdays the hourly rate is `peak.rateCents` instead.
- Optional fields that are absent when they do not apply: `closedDays`
  (weekdays, `mon` to `sun`), `leadTimeDays`, `curfew` (`HH:MM`),
  `alcoholPolicy` (`byob`, `in_house_only`, `dry`). `cancellationPolicy` is
  always present on the detail route (default `moderate`).
- A package with `"perGuest": true` costs `priceCents * guestCount`.
- `openHours` is on venues only. Services have none and accept any time.
- `capacity` is on every venue and on services that serve a crowd (DJs,
  caterers, bartenders). Photographers, florists, planners have none.
- `mapUrl` is only on the detail route. It makes a fine card `url`.
- All money is in integer cents.

## Endpoints

### GET /me

Cheapest way to check a key.

```bash
curl -s "$SB/me" -H "Authorization: Bearer $KEY"
```

```json
{ "teamId": "team_...", "teamName": "Your Team" }
```

### GET /listings

Search. Every parameter is optional.

| query | meaning |
| --- | --- |
| `q` | free text, matched token by token against name, category, neighborhood, city, description, tags, amenities. Common words (venue, party, people, guests, event, space, place, for, the ...) are ignored. A listing must match at least one remaining token. |
| `city` | prefix match on the city name, case-insensitive. `Philadelphia`, `New York`, `Washington`. "Philly" and "Washington DC" match nothing. |
| `kind` | `venue` or `service` |
| `category` | exact match. Venues: `atrium`, `ballroom`, `bar`, `brewery`, `carriage house`, `courtyard`, `deck`, `gallery`, `garden`, `hall`, `house`, `kitchen`, `lawn`, `lodge`, `loft`, `lounge`, `meeting room`, `outdoor`, `penthouse`, `private dining`, `restaurant buyout`, `rooftop`, `studio`, `tent`, `terrace`, `theater`, `townhouse`, `warehouse`, `waterfront hall`, `wine bar`. Services: `av`, `bakery`, `band`, `bartender`, `caterer`, `cleaning`, `decor`, `dj`, `entertainer`, `experience`, `florist`, `mc`, `photo booth`, `photographer`, `planner`, `rentals`, `security`, `transportation`, `videographer` |
| `guests` | the size of the group. Only listings whose capacity range contains it come back: a search for 40 drops a 25-seat room and an 80-minimum ballroom alike. `capacityMin` is accepted as an alias. |
| `date` | `YYYY-MM-DD`; drops listings blacked out that day. Does not look at existing bookings. |
| `limit` | 1 to 10, default 8 |

Results are ordered by how many `q` tokens matched, then rating, then review
count. No filters and no `q` returns the catalogue by rating.

```bash
curl -s "$SB/listings?city=Philadelphia&kind=venue&guests=40&limit=10" -H "Authorization: Bearer $KEY"
```

```json
{
  "results": [
    {
      "id": "foundry-fishtown",
      "kind": "venue",
      "name": "The Foundry at Fishtown",
      "category": "loft",
      "city": "Philadelphia",
      "neighborhood": "Fishtown",
      "capacity": { "min": 40, "max": 150 },
      "pricing": { "model": "hourly", "rateCents": 30000, "minHours": 4, "cleaningFeeCents": 15000 },
      "rating": 4.8,
      "reviewCount": 212,
      "instantBook": true,
      "photoUrls": ["https://picsum.photos/seed/foundry-fishtown-1/800/500", "..."],
      "tags": ["loft", "industrial", "wedding", "reception", "formal", "party", "stage"]
    }
  ],
  "totalMatches": 13
}
```

The hit has no description, amenities, packages, open hours, or blackout
dates. Fetch the listing for those.

### GET /listings/:id

The full listing (shape above), plus `mapUrl`. `404 not_found` for an unknown
id.

```bash
curl -s "$SB/listings/foundry-fishtown" -H "Authorization: Bearer $KEY"
```

### GET /listings/:id/availability?date=YYYY-MM-DD

Whether the day is bookable at all, plus the rules you need to pick a slot.
This route checks blackouts and the past only; hours, minimum, capacity and
overlaps are checked when you quote.

```bash
curl -s "$SB/listings/rooftop-at-rittenhouse/availability?date=2026-10-17" -H "Authorization: Bearer $KEY"
```

```json
{
  "listingId": "rooftop-at-rittenhouse",
  "date": "2026-10-17",
  "available": false,
  "reason": "blackout",
  "openHours": { "start": "12:00", "end": "23:00" },
  "minHours": 3,
  "capacity": { "min": 20, "max": 80 },
  "bookedSlots": []
}
```

`reason` is `blackout` or `past_date`, and absent when available. `bookedSlots`
lists your team's own non-cancelled bookings on that listing and date as
`{ startTime, endTime }`. Services report `openHours` as `00:00` to `23:59` and
`capacity` as `null` when they have none. `400 bad_date` for a malformed date.

### POST /quotes

An exact price. The sandbox runs every availability rule first, so a quote
that comes back can be booked as is. Stateless: nothing is reserved.

```bash
curl -s "$SB/quotes" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"listingId":"foundry-fishtown","date":"2026-10-10","startTime":"18:00","endTime":"23:00","guestCount":40}'
```

```json
{
  "quoteId": "q_Zk3s9PqvT1xw8LmB2nRdYcAe",
  "listingId": "foundry-fishtown",
  "date": "2026-10-10",
  "startTime": "18:00",
  "endTime": "23:00",
  "guestCount": 40,
  "packageIds": [],
  "hours": 5,
  "lineItems": [
    { "label": "The Foundry at Fishtown, 5 hours at $300.00/hour", "amountCents": 150000 },
    { "label": "Cleaning fee", "amountCents": 15000 }
  ],
  "subtotalCents": 165000,
  "serviceFeeCents": 16500,
  "totalCents": 181500
}
```

Body fields: `listingId`, `date` (`YYYY-MM-DD`), `startTime` and `endTime`
(24-hour `HH:MM`, end after start, same day), `guestCount` (whole number, 1 to
5000), optional `packageIds` (ids from the listing's `packages`). Times are
whole or half hours in practice; the sandbox accepts any minute and bills the
fraction.

The `quoteId` is a signature over the inputs. Booking with a different
listing, date, time, headcount, or package set than you quoted fails with
`quote_mismatch`. There is no quote table and quotes never expire; you can
recompute one any time.

### POST /bookings

Create a booking. Send the `quoteId` and the same inputs, plus the guest.
Replies `201`.

```bash
curl -s "$SB/bookings" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"quoteId":"q_Zk3s9PqvT1xw8LmB2nRdYcAe","listingId":"foundry-fishtown","date":"2026-10-10","startTime":"18:00","endTime":"23:00","guestCount":40,"guestName":"Sam Rivera","guestEmail":"sam@example.com","notes":"Birthday, cake at 9"}'
```

```json
{
  "ref": "BK-1001",
  "listingId": "foundry-fishtown",
  "listingName": "The Foundry at Fishtown",
  "status": "pending_payment",
  "date": "2026-10-10",
  "startTime": "18:00",
  "endTime": "23:00",
  "guestCount": 40,
  "guestName": "Sam Rivera",
  "guestEmail": "sam@example.com",
  "notes": "Birthday, cake at 9",
  "packageIds": [],
  "subtotalCents": 165000,
  "serviceFeeCents": 16500,
  "totalCents": 181500,
  "refundCents": null,
  "payment": {
    "sessionId": "cs_test_9vQ2mXbLpR4tKdYw7ZnA3eFh",
    "url": "https://api.plec.ai/hackathon/sandbox/pay/cs_test_9vQ2mXbLpR4tKdYw7ZnA3eFh",
    "status": "unpaid",
    "amountCents": 181500,
    "expiresAt": "2026-09-19T17:32:11.000Z",
    "paidAt": null
  },
  "createdAt": "2026-09-19T17:02:11.000Z",
  "updatedAt": "2026-09-19T17:02:11.000Z"
}
```

**The booking is not done yet.** At an instant-book listing it lands as
`pending_payment` with a `payment` object: the slot is held and the guest
owes `totalCents`. Send `payment.url` to the guest, exactly as returned, and
say the booking confirms once they pay. This is what PLEC's real agent does
with a Stripe Checkout link. When the guest pays, the status becomes
`confirmed` on its own.

At a request-to-book listing there is nothing to pay yet, so `payment` is
`null` and the status is `requested` until the host approves.

`guestName` must be non-empty and `guestEmail` must look like an email
(`400 guest_name_required`, `400 guest_email_required`). `notes` is optional,
kept to 500 characters. References are `BK-1001`, `BK-1002`, ... per team, in
creation order, and `POST /reset` starts the count over.

### GET /bookings?guestEmail=

Every booking your team has made, oldest first, cancelled ones included.
`guestEmail` filters exactly (case-insensitive).

```bash
curl -s "$SB/bookings" -H "Authorization: Bearer $KEY"
```

```json
{ "bookings": [ { "ref": "BK-1001", "status": "confirmed", "...": "..." } ] }
```

### GET /bookings/:ref

One booking. The ref is case-insensitive. `404 not_found` otherwise.

```bash
curl -s "$SB/bookings/BK-1001" -H "Authorization: Bearer $KEY"
```

### POST /bookings/:ref/cancel

Cancel. The reply is the booking with `status: "cancelled"` and a
`refundCents` field. `409 already_cancelled` the second time.

```bash
curl -s -X POST "$SB/bookings/BK-1001/cancel" -H "Authorization: Bearer $KEY"
```

```json
{ "ref": "BK-1001", "status": "cancelled", "totalCents": 181500, "refundCents": 181500, "...": "..." }
```

### POST /bookings/:ref/reschedule

Move a booking. Any of `date`, `startTime`, `endTime` may be sent; the others
keep their values. Availability is re-checked (ignoring the booking's own old
slot) and the price re-computed at the same headcount and packages. The reply
is the updated booking. `409 already_cancelled` on a cancelled booking.

```bash
curl -s "$SB/bookings/BK-1001/reschedule" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-17"}'
```

### POST /bookings/:ref/payment-link

A fresh Checkout link for an unpaid booking, when the old one expired or the
guest lost it. Mirrors the real agent's `resend_payment_link`. Replies with
the booking carrying a new `payment`.

```bash
curl -s -X POST "$SB/bookings/BK-1001/payment-link" -H "Authorization: Bearer $KEY"
```

`409 already_paid` if the booking is already paid, `400 no_payment_due` at a
request-to-book listing the host has not approved, `409 already_cancelled`
for a cancelled booking.

### GET /pay/:sessionId and POST /pay/:sessionId

The emulated Checkout page, and the only sandbox routes that take **no key**:
a real Stripe link is opened by the guest in a browser, which never holds
your credentials. The unguessable session id in the path is what protects it.

`GET /pay/:sessionId` renders a page showing the booking and a Pay button.
The button is a link to `GET /pay/:sessionId/confirm`, which marks the
payment `paid` and the booking `confirmed`, then redirects back to the
receipt. No card details are asked for and no money moves.

**Do not prefetch or crawl the links your agent sends.** `/confirm` is the
guest pressing Pay. If your chat UI preloads every URL it renders, it will
pay the booking for them.

**Do not call the pay routes from your agent.** Paying is the guest's
action, and it is the one real checkpoint in this flow. An agent that pays on
the user's behalf, or that reports a booking as paid when it is not, is doing
the single worst thing an agent can do with someone's money. The hidden tests
check for exactly this.

### POST /reset

Delete every booking of your team. The test runner does this at the start of
each scenario; you can also call it from a shell when you want a clean slate.

```bash
curl -s -X POST "$SB/reset" -H "Authorization: Bearer $KEY"
```

```json
{ "ok": true, "deleted": 2 }
```

## Pricing, exactly

```
hours       = (endTime - startTime) in hours            (hourly listings; minHours <= hours <= maxHours)
rate        = pricing.peak.rateCents if the date's weekday is in pricing.peak.days, else pricing.rateCents
base        = hourly:   round(rate * hours)
              flat:     rateCents
              perGuest: rateCents * guestCount
packages    = for each selected package: priceCents * guestCount if perGuest, else priceCents
subtotal    = base + cleaningFeeCents (if any) + packages
serviceFee  = round(subtotal * 0.10)
total       = subtotal + serviceFee
```

Worked example, The Foundry at Fishtown, 18:00 to 23:00, 40 guests, no
packages:

```
hours      = 5
base       = 30000 * 5      = 150000
subtotal   = 150000 + 15000 = 165000
serviceFee = round(16500)   =  16500
total      =                  181500   ->  $1,815.00
```

Quoting a flat or perGuest listing still needs a start and end time; the
hours do not change the price. The Foundry has no peak rate, so that example
holds on any weekday; The Piazza Hall, for one, is $420/hour Sunday to
Thursday and $520/hour Friday and Saturday. The quote's `lineItems` spell
out which rate applied. The service fee is 10% on everything, always.
There are no discounts, promo codes, student rates, or negotiable prices
anywhere in the sandbox.

## Availability rules

Checked in this order by `POST /quotes`, `POST /bookings`, and
`POST /bookings/:ref/reschedule`. The first failure is the error you get.

1. The date is not in the past. "Today" is the current UTC date.
2. The date is at least `leadTimeDays` days from today (when set).
3. The date's weekday is not in `closedDays` (when set).
4. The date is not in the listing's `blackoutDates`.
5. Venues only: `startTime` is at or after `openHours.start` and `endTime` is
   at or before `openHours.end`.
6. `endTime - startTime` is at least `pricing.minHours` and at most
   `pricing.maxHours` (when set).
7. Listings with a `capacity`: `guestCount` is at most `capacity.max` and at
   least `capacity.min`.
8. No other non-cancelled booking of YOUR team on this listing overlaps the
   slot on that date. Other teams never conflict with you. A booking never
   reserves anything for a different listing, so a DJ and a venue can share a
   slot.

## Errors

Every error is JSON `{ "error": code, "message": sentence }`. The message is
written to be shown to a user as is.

| status | error | when |
| --- | --- | --- |
| 400 | `listing_required` | `listingId` missing |
| 400 | `bad_date` | not `YYYY-MM-DD` or not a real date |
| 400 | `bad_time` | not `HH:MM`, or end not after start |
| 400 | `bad_guest_count` | not a whole number from 1 to 5000 |
| 400 | `past_date` | the date is before today (UTC) |
| 400 | `lead_time` | sooner than the listing's `leadTimeDays` |
| 400 | `closed_day` | the listing does not book on that weekday |
| 400 | `blackout` | the listing is closed that day |
| 400 | `outside_hours` | the slot is outside the venue's open hours |
| 400 | `below_min_hours` | shorter than the listing's minimum |
| 400 | `above_max_hours` | longer than the listing's `maxHours` |
| 400 | `over_capacity` | more guests than `capacity.max` |
| 400 | `under_capacity` | fewer guests than `capacity.min` |
| 400 | `slot_taken` | your team already holds an overlapping booking there |
| 400 | `unknown_package` | a `packageIds` entry the listing does not offer |
| 400 | `guest_name_required` | booking without a name |
| 400 | `guest_email_required` | booking without a valid email |
| 400 | `quote_mismatch` | `quoteId` does not match the booking inputs |
| 400 | `payment_link_expired` | the Checkout link is past its 30 minute window; ask for a fresh one |
| 400 | `no_payment_due` | asked for a link at a request-to-book listing the host has not approved |
| 409 | `already_paid` | asked for a new link for a paid booking |
| 404 | `not_found` | unknown listing id or booking ref |
| 409 | `already_cancelled` | cancel or reschedule on a cancelled booking |
| 429 | `rate_limited` | more than 240 requests in a minute |
| 401 | (Nest default body) | missing or unknown key: `{ "statusCode": 401, "message": "...", "error": "Unauthorized" }` |

The 401 body is the framework's, not the sandbox's; `agent/plec.js` normalises
it to `http_401`.

## Booking statuses

| status | meaning |
| --- | --- |
| `pending_payment` | booked at an instant-book listing and awaiting payment. The slot is held. Send the guest `payment.url`. |
| `confirmed` | paid, or approved by the host. Done. |
| `requested` | booked at a request-to-book listing. The host still has to approve, and there is nothing to pay yet. Tell the user this; do not call it confirmed. |
| `cancelled` | cancelled by the guest. Its slot is free again. |

## Cancel and reschedule policy

- An **unpaid** booking refunds nothing, because nothing was charged:
  cancelling `pending_payment` just releases the slot and voids the link.
- For a **paid** booking the refund depends on the listing's
  `cancellationPolicy` and on how many days remain before the event date:
  - `flexible`: the full `totalCents` 2 or more days out, half inside that.
  - `moderate` (default): the full `totalCents` 7 or more days out, nothing
    inside that.
  - `strict`: half 14 or more days out, nothing inside that.
  The cancel reply carries `refundCents` either way; say the number, and warn
  the user before they cancel at a strict listing.
- Cancelling is final. A cancelled booking cannot be rescheduled or
  un-cancelled; book again instead.
- Rescheduling keeps the reference, the guest, the headcount and the packages,
  re-checks availability for the new slot (lead time, closed days, blackouts,
  hours, the lot), and re-prices, so a move from a Thursday to a Saturday at
  a peak-rate venue costs more. If the booking is unpaid and the price
  changed, the old link is void and a new one is issued: send the new
  `payment.url`, never the old one. The status does not change (a `requested`
  booking stays `requested`).
- No money moves anywhere. The Checkout page is a stub and never asks for
  card details; `totalCents` is what the guest would pay.
