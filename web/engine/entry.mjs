/**
 * Entry / visa evaluation — requirements FR-21 to FR-23.
 *
 * An overnight layover means leaving the airside transit area and ENTERING the
 * country. Transit-without-visa provisions do not help. So the app has to answer
 * a question with legal consequences, and the cost of being wrong is someone
 * stranded at a border.
 *
 * Two design rules follow from that:
 *
 * 1. EVALUATE AGAINST THE TRAVEL DATE, NOT TODAY. Entry rules have start and end
 *    dates, and live examples sit right inside a normal planning horizon:
 *    Korea's K-ETA waiver lapses 2026-12-31, ETIAS is expected in 2027, Japan's
 *    JESTA in fiscal 2028. A static status field would quietly give the wrong
 *    answer to anyone planning across a boundary.
 *
 * 2. HEDGE TOWARD 'UNKNOWN'. Anything not explicitly matched resolves to
 *    'unknown', which the UI must render as "check before you go". Never silently
 *    to "fine". A false 'unknown' costs a search; a false 'visa_free' costs a trip.
 *
 * Data is injected, matching the rest of the engine.
 */

/** Ordered by how much they should worry the traveller. */
export const ENTRY_SEVERITY = {
  visa_free: 0,
  visa_on_arrival: 1,
  eta_required: 2,
  visa_required: 3,
  unknown: 4,
  not_permitted: 5,
};

const inWindow = (date, from, until) =>
  (!from || date >= from) && (!until || date <= until);

export function createEntryRules(data) {
  const countries = data.countries ?? {};
  const groups = data.groups ?? {};

  const expand = (rule) => {
    const out = new Set(rule.nationalities ?? []);
    for (const g of rule.groups ?? []) for (const n of groups[g] ?? []) out.add(n);
    return out;
  };

  /**
   * @param {string} passport       ISO 3166-1 alpha-2, e.g. 'US'
   * @param {string} countryCode    destination/layover country, alpha-2
   * @param {string} travelDate     'YYYY-MM-DD' — the date of the LAYOVER, not today
   */
  function evaluate(passport, countryCode, travelDate) {
    const country = countries[countryCode];
    if (!country) {
      return {
        status: 'unknown', countryCode, confidence: 'none', sources: [],
        note: 'No entry rules recorded for this country. Check the relevant government source.',
      };
    }

    // Schengen members share one rule set; follow the pointer rather than
    // duplicating (and risking divergence in) the rules.
    const ruleSource = country.same_rules_as ? countries[country.same_rules_as] : country;
    const rules = ruleSource?.rules ?? [];

    const base = {
      countryCode,
      countryName: country.name,
      confidence: country.confidence ?? 'low',
      sources: (country.sources?.length ? country.sources : ruleSource?.sources) ?? [],
      verifyBeforeTravel: true,
      arrivalFormalities: country.arrival_formalities ?? ruleSource?.arrival_formalities ?? [],
      schengen: Boolean(country.schengen),
    };

    // Date-bounded rules are evaluated before open-ended ones, then array order.
    //
    // Hand-ordering alone is a footgun: Japan's open-ended visa_free rule sat
    // above its JESTA rule (effective 2028) and shadowed it permanently, so the
    // future requirement could never fire. Sorting by specificity makes the
    // outcome independent of how the data happens to be written down.
    const applicable = rules
      .filter((r) => expand(r).has(passport))
      .filter((r) => inWindow(travelDate, r.effective_from, r.effective_until));
    const bounded = applicable.filter((r) => r.effective_from || r.effective_until);
    const unbounded = applicable.filter((r) => !r.effective_from && !r.effective_until);

    for (const rule of [...bounded, ...unbounded]) {
      return {
        ...base,
        status: rule.status,
        scheme: rule.scheme ?? null,
        schemeWaived: rule.scheme_waived ?? null,
        cost: rule.cost ?? null,
        maxStayDays: rule.max_stay_days ?? null,
        stayBasis: rule.stay_basis ?? null,
        note: rule.note ?? null,
        effectiveFrom: rule.effective_from ?? null,
        effectiveUntil: rule.effective_until ?? null,
      };
    }

    return {
      ...base,
      status: country.default_status ?? 'unknown',
      note: country.note ?? 'No rule matched this passport. Check the relevant government source.',
    };
  }

  /**
   * A rule that changes within `withinDays` of the travel date.
   *
   * This is the genuinely useful part: it warns someone booking in December that
   * the same trip in January needs an authorisation it does not need today.
   */
  function upcomingChange(passport, countryCode, travelDate, withinDays = 180) {
    const country = countries[countryCode];
    const ruleSource = country?.same_rules_as ? countries[country.same_rules_as] : country;
    if (!ruleSource?.rules?.length) return null;

    const horizon = new Date(Date.parse(`${travelDate}T00:00:00Z`) + withinDays * 864e5)
      .toISOString().slice(0, 10);
    const current = evaluate(passport, countryCode, travelDate);

    for (const rule of ruleSource.rules) {
      if (!expand(rule).has(passport)) continue;
      const starts = rule.effective_from;
      if (!starts || starts <= travelDate || starts > horizon) continue;
      if (ENTRY_SEVERITY[rule.status] <= ENTRY_SEVERITY[current.status]) continue;
      return {
        from: starts,
        status: rule.status,
        scheme: rule.scheme ?? null,
        note: rule.note ?? null,
        text: `From ${starts}, ${country.name} ${rule.scheme ? `requires ${rule.scheme}` : `changes to ${rule.status.replace(/_/g, ' ')}`} `
          + 'for this passport. Travel after that date needs it; travel before does not.',
      };
    }
    return null;
  }

  /** Plain sentences for the UI. Hedged wherever the data is hedged. */
  function describe(result) {
    switch (result.status) {
      case 'visa_free':
        return `Visa-free${result.maxStayDays ? ` for up to ${result.maxStayDays} days` : ''}`
          + `${result.schemeWaived ? ` — ${result.schemeWaived} is currently waived` : ''}.`;
      case 'visa_on_arrival':
        return `Visa on arrival${result.maxStayDays ? `, up to ${result.maxStayDays} days` : ''}.`;
      case 'eta_required':
        return `${result.scheme ?? 'A travel authorisation'} required before departure`
          + `${result.cost ? ` (${result.cost.amount} ${result.cost.currency})` : ''}.`;
      case 'visa_required':
        return 'A visa is required in advance.';
      case 'not_permitted':
        return 'Entry is not permitted on this passport.';
      default:
        return 'Entry rules not confirmed for this passport — check before you go.';
    }
  }

  return { evaluate, upcomingChange, describe, checkedAt: data.checked_at };
}
