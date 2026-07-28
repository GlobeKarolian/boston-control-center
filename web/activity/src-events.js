/* ============================================================================
   Scheduled events: MLB, NHL, NBA.

   This is the strongest crowd signal available for free, and for a newsroom it
   is often more useful than a heatmap. "37,000 people leave Fenway at 10:15pm"
   is a fact you can plan around. A glowing blob is not.

   Every number here derives from a published capacity and a documented curve.
   Nothing is invented. Where a real attendance figure is available (MLB reports
   it once a game is final) we use it and upgrade confidence to 'measured'.
   ========================================================================== */

const { activity, crowdCurve } = require('./contract.js');
const { VENUES } = require('./venues.js');

const UA = 'BostonNewsroomActivityLayer/0.1';

// cdn.nba.com rejects non-browser user agents with a 403, so that one source
// needs a browser-shaped UA. Everything else is happy with an honest one.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getJSON(url, timeoutMs = 12000, browserUA = false) {
  const res = await fetch(url, {
    headers: { 'User-Agent': browserUA ? BROWSER_UA : UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(url.split('?')[0] + ' -> HTTP ' + res.status);
  return res.json();
}

function todayISO(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/* ---- MLB: Red Sox at Fenway ---------------------------------------------
   statsapi.mlb.com is open, unauthenticated, and stable. teamId 111 = Red Sox,
   venue id 3 = Fenway. We only care about HOME games; an away game puts nobody
   in Boston.
   Typical 9-inning game runs about 3 hours. Gates open 90 minutes before for
   regular games (2 hours for premium, ignored here). --------------------- */
const MLB_TYPICAL_DURATION_MIN = 190; // 2026 nine-inning average, used until the real one is known

async function mlb(now = new Date()) {
  const out = [];
  const url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=111'
    + '&startDate=' + todayISO(-1) + '&endDate=' + todayISO(1);

  const j = await getJSON(url);
  for (const day of j.dates || []) {
    for (const g of day.games || []) {
      // home games only, and only at Fenway
      if (g.venue?.id !== 3) continue;

      const v = VENUES.fenway;

      /* The schedule endpoint carries no attendance and only a SCHEDULED start.
         The live feed carries gameInfo.attendance (announced, real), the actual
         firstPitch, and the actual gameDurationMinutes. That is a measured count
         instead of a guess, so it is worth the extra request per game. There is
         at most one Fenway game a day, so this costs nothing meaningful.

         Attendance is typically announced a few innings in, so an early-innings
         game falls back to the model until MLB publishes. */
      let info = {};
      try {
        const live = await getJSON('https://statsapi.mlb.com/api/v1.1/game/' + g.gamePk + '/feed/live', 15000);
        info = live.gameData?.gameInfo || {};
      } catch (e) { /* fall through to the modelled path */ }

      const announced = Number(info.attendance) || null;
      const startsAt = info.firstPitch ? new Date(info.firstPitch) : new Date(g.gameDate);
      const durationMin = Number(info.gameDurationMinutes) || MLB_TYPICAL_DURATION_MIN;
      const endsAt = new Date(startsAt.getTime() + durationMin * 60000);

      const { fraction, phase } = crowdCurve(now, startsAt, endsAt, { doorsMin: 90, exitMin: 45 });
      if (phase === 'pending' || phase === 'ended') continue;

      const peak = announced || Math.round(v.capacity * v.typicalFill);
      const away = g.teams?.away?.team?.teamName || 'opponent';
      const state = g.status?.detailedState || 'Scheduled';

      // Say plainly which parts are real and which are assumed. The headcount
      // can be measured while the in-or-out timing is still modelled.
      const timingBasis = info.gameDurationMinutes
        ? 'actual first pitch and actual ' + durationMin + '-minute duration'
        : 'actual first pitch and an assumed ' + durationMin + '-minute game';

      out.push(activity({
        id: 'mlb-' + g.gamePk,
        source: 'events',
        label: 'Fenway Park',
        lat: v.lat, lon: v.lon,
        people: peak * fraction,
        confidence: announced ? 'measured' : 'modelled',
        basis: announced
          ? 'MLB announced attendance ' + announced.toLocaleString() + ', scaled by a gates-open-to-dispersal curve using '
            + timingBasis + '. Headcount is a real count; how many are still inside right now is modelled.'
          : 'Attendance not yet announced. Fenway capacity ' + v.capacity.toLocaleString()
            + ' x typical fill ' + Math.round(v.typicalFill * 100) + '%, scaled by a curve using '
            + timingBasis + '. Estimate, not a count.',
        phase,
        radiusM: v.radiusM,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        detail: {
          kind: 'baseball',
          matchup: away + ' at Red Sox',
          status: state,
          peakEstimate: peak,
          attendanceSource: announced ? 'MLB announced' : 'modelled from capacity',
          durationMin,
          durationSource: info.gameDurationMinutes ? 'actual' : 'assumed',
          spillsInto: v.spillsInto,
          // The dispersal window is the operationally useful bit.
          emptiesBy: new Date(endsAt.getTime() + 45 * 60000).toISOString(),
        },
      }));
    }
  }
  return out;
}

/* ---- NHL: Bruins at TD Garden -------------------------------------------
   api-web.nhle.com is open. Games run about 2h30m including intermissions.
   Off-season returns nothing, which is correct behaviour rather than an error.
   ------------------------------------------------------------------------- */
async function nhl(now = new Date()) {
  const out = [];
  const j = await getJSON('https://api-web.nhle.com/v1/club-schedule/BOS/week/' + todayISO());

  for (const g of j.games || []) {
    const homeAbbrev = g.homeTeam?.abbrev;
    if (homeAbbrev !== 'BOS') continue;

    const v = VENUES.tdgarden_hockey;
    const startsAt = new Date(g.startTimeUTC);
    const endsAt = new Date(startsAt.getTime() + 2.5 * 3600 * 1000);
    const { fraction, phase } = crowdCurve(now, startsAt, endsAt, { doorsMin: 60, exitMin: 40 });
    if (phase === 'pending' || phase === 'ended') continue;

    const peak = Math.round(v.capacity * v.typicalFill);
    out.push(activity({
      id: 'nhl-' + g.id,
      source: 'events',
      label: 'TD Garden',
      lat: v.lat, lon: v.lon,
      people: peak * fraction,
      confidence: 'modelled',
      basis: 'TD Garden hockey capacity ' + v.capacity.toLocaleString() + ' x typical fill '
        + Math.round(v.typicalFill * 100) + '%, scaled by a doors-to-dispersal curve. Estimate, not a count.',
      phase,
      radiusM: v.radiusM,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      detail: {
        kind: 'hockey',
        matchup: (g.awayTeam?.abbrev || 'opponent') + ' at Bruins',
        peakEstimate: peak,
        spillsInto: v.spillsInto,
        emptiesBy: new Date(endsAt.getTime() + 40 * 60000).toISOString(),
      },
    }));
  }
  return out;
}

/* ---- NBA: Celtics at TD Garden ------------------------------------------
   cdn.nba.com publishes a full-season schedule as static JSON. It is large, so
   this is polled infrequently by the composer rather than every tick.
   ------------------------------------------------------------------------- */
async function nba(now = new Date()) {
  const out = [];
  const j = await getJSON('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json', 20000, true);
  const days = j.leagueSchedule?.gameDates || [];
  const today = todayISO();

  for (const day of days) {
    // gameDate looks like "10/22/2025 00:00:00"
    const [m, d, y] = (day.gameDate || '').split(' ')[0].split('/');
    if (!y) continue;
    const iso = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    if (iso < todayISO(-1) || iso > todayISO(1)) continue;

    for (const g of day.games || []) {
      if (g.homeTeam?.teamTricode !== 'BOS') continue;

      const v = VENUES.tdgarden_basketball;
      const startsAt = new Date(g.gameDateTimeUTC);
      const endsAt = new Date(startsAt.getTime() + 2.5 * 3600 * 1000);
      const { fraction, phase } = crowdCurve(now, startsAt, endsAt, { doorsMin: 60, exitMin: 40 });
      if (phase === 'pending' || phase === 'ended') continue;

      const peak = Math.round(v.capacity * v.typicalFill);
      out.push(activity({
        id: 'nba-' + g.gameId,
        source: 'events',
        label: 'TD Garden',
        lat: v.lat, lon: v.lon,
        people: peak * fraction,
        confidence: 'modelled',
        basis: 'TD Garden basketball capacity ' + v.capacity.toLocaleString() + ' x typical fill '
          + Math.round(v.typicalFill * 100) + '%, scaled by a doors-to-dispersal curve. Estimate, not a count.',
        phase,
        radiusM: v.radiusM,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        detail: {
          kind: 'basketball',
          matchup: (g.awayTeam?.teamTricode || 'opponent') + ' at Celtics',
          peakEstimate: peak,
          spillsInto: v.spillsInto,
          emptiesBy: new Date(endsAt.getTime() + 40 * 60000).toISOString(),
        },
      }));
    }
  }
  return out;
}

/** Run all event sources. One failing source must never take down the rest. */
async function collect(now = new Date()) {
  const results = await Promise.allSettled([mlb(now), nhl(now), nba(now)]);
  const items = [];
  const errors = [];
  const names = ['mlb', 'nhl', 'nba'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(names[i] + ': ' + r.reason.message);
  });
  return { items, errors };
}

module.exports = { collect, mlb, nhl, nba };
