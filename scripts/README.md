# scripts

## `vendor-test.mjs` — run this before writing any application code

Answers the one question that decides whether the product can be built on a given vendor
([`docs/03-data-sources.md` §2](../docs/03-data-sources.md)):

> **Does the vendor return itineraries with long and overnight layovers at all?**

Many flight-search engines apply their own maximum connect time and drop long connections
before you ever see the response. If that happens, local filtering cannot recover them and the
vendor is unusable — no matter how good its free tier is.

### Getting a key

1. Register at <https://developers.amadeus.com> and verify your email.
2. **My Self-Service Workspace → Create New App.**
3. Copy the **API Key** and **API Secret**. They are issued immediately.

That gives you a **test** key. See the caveat below.

### Run it

```bash
export AMADEUS_API_KEY=...
export AMADEUS_API_SECRET=...
export AMADEUS_ENV=test          # or: production
node scripts/vendor-test.mjs
```

Node 18+ required (built-in `fetch`). No dependencies — the project has not picked a stack
yet and this must not prejudge it.

Override the route to test other markets:

```bash
DEST=SIN node scripts/vendor-test.mjs
ORIGIN=LAX DEST=BKK STOPOVER_CITY=HND DAYS_OUT=45 node scripts/vendor-test.mjs
```

### What it does

- **Mode A — Discover.** One ordinary `SEA → ICN` search, pulled as wide as the API allows
  (250 offers). Reports a layover histogram and the longest layovers found. This is the
  acceptance test.
- **Mode B — Construct.** A multi-city single-ticket stopover search — `SEA → TYO` on day D,
  `TYO → ICN` on day D+1 — which is how ANA/JAL free-stopover fares are actually built.
- Prints a **PASS / WEAK / FAIL** verdict for each, with what to do next in each case.

### Caveat: test vs production

The **test** environment serves a limited subset of data. **A null result on test is not
conclusive** — it may mean thin test data rather than a vendor-side connect-time cap. The
script says so in its verdict. Re-run against `AMADEUS_ENV=production` before ruling Amadeus
out.

Whether a free **production** tier is still available to new signups is the open question
flagged ⚠️ throughout [`docs/03-data-sources.md`](../docs/03-data-sources.md).

### How it measures layovers

Amadeus returns local times with **no UTC offset**, so subtracting the printed clock times is
wrong across the date line and DST — exactly the trap in NFR-1, and Seattle → Tokyo → Seoul
crosses both.

Instead the script uses the elapsed ISO-8601 durations the API also returns:

```
total layover = itinerary duration − Σ segment durations
```

For a one-stop itinerary that is the single layover, exactly, with no timezone lookup at all.
The real app still needs proper UTC + IANA handling for display and for multi-stop itineraries
— this shortcut is only enough to answer the acceptance test.
