/* ============================================================
   Cyder Cup core logic, shared by index.html and admin.html.
   Matches are the single source of truth: tour totals, winners,
   player points and stars are all worked out from them here.
   ============================================================ */
(function (global) {
  const CC = {};

  const sidePlayers = (m, side) =>
    [m[side + '_p1'], m[side + '_p2']].filter(Boolean).length
      ? [m[side + '_p1'], m[side + '_p2']].filter(Boolean)
      : String(m[side + '_players'] || '').split('&').map(s => s.trim()).filter(Boolean);
  CC.sidePlayers = sidePlayers;

  const matchesFor = (tourId, matches) =>
    matches.filter(m => m.tour_id === tourId).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  CC.matchesFor = matchesFor;

  /**
   * Work out which team each player was on, using partners (same team) and
   * opponents (other team). Red/blue columns aren't always consistent with
   * team 1/2 in old data, so this is more reliable than trusting sides.
   * Returns { teams: {name: 1|2}, conflicts: [...] }.
   */
  CC.teamsForTour = function (tour, matches) {
    const adj = {};
    const link = (a, b, same) => {
      (adj[a] = adj[a] || []).push([b, same]);
      (adj[b] = adj[b] || []).push([a, same]);
    };
    matchesFor(tour.id, matches).forEach(m => {
      const r = sidePlayers(m, 'red'), b = sidePlayers(m, 'blue');
      if (r.length === 2) link(r[0], r[1], true);
      if (b.length === 2) link(b[0], b[1], true);
      r.forEach(x => b.forEach(y => link(x, y, false)));
    });
    const teams = {}, conflicts = [];
    const seed = (name, team) => {
      if (!name || !adj[name] || teams[name]) return;
      teams[name] = team;
      const stack = [name];
      while (stack.length) {
        const u = stack.pop();
        adj[u].forEach(([v, same]) => {
          const want = same ? teams[u] : 3 - teams[u];
          if (teams[v] === undefined) { teams[v] = want; stack.push(v); }
          else if (teams[v] !== want) conflicts.push(`${u} and ${v} can't be on those teams at once`);
        });
      }
    };
    seed(tour.cap1, 1);
    seed(tour.cap2, 2);
    // Any group not linked to a captain: fall back to the red side = team 1
    matchesFor(tour.id, matches).forEach(m => seed(sidePlayers(m, 'red')[0], 1));
    return { teams, conflicts: [...new Set(conflicts)] };
  };

  /** Which team (1|2) is on the red side of this match. */
  CC.redTeam = (m, teams) => teams[sidePlayers(m, 'red')[0]] || 1;

  /** Points for team 1 and team 2 from one match. */
  CC.matchPoints = function (m, teams) {
    const rt = CC.redTeam(m, teams);
    const v = m.winner === 'red' ? [1, 0] : m.winner === 'blue' ? [0, 1] : m.winner === 'draw' ? [0.5, 0.5] : [0, 0];
    return rt === 1 ? v : [v[1], v[0]];
  };

  const parsePlayoff = t => {
    try { return typeof t.playoff_scores === 'string' ? JSON.parse(t.playoff_scores || '[]') : (t.playoff_scores || []); }
    catch (e) { return []; }
  };
  CC.parsePlayoff = parsePlayoff;

  /** Derive everything for one tour. */
  CC.deriveTour = function (tour, matches) {
    const ms = matchesFor(tour.id, matches);
    const { teams, conflicts } = CC.teamsForTour(tour, matches);
    let s1 = 0, s2 = 0;
    const per = {};
    ms.forEach(m => {
      const [p1, p2] = CC.matchPoints(m, teams);
      s1 += p1; s2 += p2;
      ['red', 'blue'].forEach(side => sidePlayers(m, side).forEach(p => {
        const r = per[p] || (per[p] = { player_name: p, matches: 0, points: 0 });
        r.matches++;
        r.points += m.winner === side ? 1 : m.winner === 'draw' ? 0.5 : 0;
      }));
    });
    let winnerSide = s1 > s2 ? 1 : s2 > s1 ? 2 : 0;
    const tied = ms.length && s1 === s2;
    if (tied && tour.playoff_winner) {
      winnerSide = tour.playoff_winner === tour.team1 ? 1 : tour.playoff_winner === tour.team2 ? 2 : 0;
    }
    const winTeam = winnerSide === 1 ? tour.team1 : winnerSide === 2 ? tour.team2 : '';
    const winnerText = !ms.length ? '' : tied ? (winTeam ? `Tied — Playoff Win ${winTeam}` : 'Tied') : `${winTeam} Win`;
    const scores = Object.values(per).map(r => ({
      id: `${tour.id}:${r.player_name}`, tour_id: tour.id, player_name: r.player_name,
      matches: r.matches, points: r.points, stars: winnerSide !== 0 && teams[r.player_name] === winnerSide,
      team: teams[r.player_name] || 0,
    }));
    return { score1: s1, score2: s2, winnerSide, winnerText, tied, teams, conflicts, scores, matches: ms };
  };

  /** Checks that should pass before data is exported. Returns [{level, year, msg}]. */
  CC.validate = function (data) {
    const out = [];
    const add = (level, year, msg) => out.push({ level, year, msg });
    const players = new Set((data.players || []).map(p => p.full_name));
    (data.tours || []).forEach(t => {
      const y = t.year;
      const ms = matchesFor(t.id, data.matches || []);
      if (!ms.length) return;
      const d = CC.deriveTour(t, data.matches || []);
      d.conflicts.forEach(c => add('error', y, `Team clash: ${c}. Check who partnered and played whom.`));
      if (t.cap1 && d.teams[t.cap1] !== 1) add('warn', y, `Captain ${t.cap1} didn't play a match for ${t.team1}.`);
      if (t.cap2 && d.teams[t.cap2] !== 2) add('warn', y, `Captain ${t.cap2} didn't play a match for ${t.team2}.`);
      if (d.tied && !t.playoff_winner) add('warn', y, `Tied ${d.score1}–${d.score2} but no playoff winner set.`);
      if (!d.tied && t.playoff_winner) add('warn', y, `Playoff winner set, but the matches don't finish level (${d.score1}–${d.score2}).`);
      if (t.playoff_winner && ![t.team1, t.team2].includes(t.playoff_winner))
        add('error', y, `Playoff winner "${t.playoff_winner}" isn't one of the team names (${t.team1} / ${t.team2}).`);
      // Same player twice in one session
      const bySession = {};
      ms.forEach(m => (bySession[m.round_name] = bySession[m.round_name] || []).push(m));
      Object.entries(bySession).forEach(([rn, list]) => {
        const seen = {};
        list.forEach(m => ['red', 'blue'].forEach(s => sidePlayers(m, s).forEach(p => {
          if (seen[p]) add('error', y, `${p} appears twice in "${rn}".`);
          seen[p] = 1;
        })));
      });
      ms.forEach((m, i) => {
        const r = sidePlayers(m, 'red'), b = sidePlayers(m, 'blue');
        const label = `${rn(m)} match ${i + 1} (${r.join(' & ') || '?'} v ${b.join(' & ') || '?'})`;
        if (!r.length || !b.length) add('error', y, `${label} is missing players.`);
        if (!['red', 'blue', 'draw'].includes(m.winner)) add('error', y, `${label} has no winner.`);
        if (m.winner === 'draw' && m.score && !/^(A\/S|AS|Halved)$/i.test(m.score)) add('warn', y, `${label} is halved but the score says ${m.score}.`);
        if (m.winner !== 'draw' && /^(A\/S|AS)$/i.test(m.score || '')) add('warn', y, `${label} says A/S but has a winner.`);
        if (m.format === 'Singles' ? (r.length !== 1 || b.length !== 1) : (r.length !== 2 || b.length !== 2))
          add('warn', y, `${label}: ${m.format} but ${r.length} v ${b.length} players.`);
        [...r, ...b].forEach(p => { if (players.size && !players.has(p)) add('warn', y, `${p} isn't in the player list (typo or new player?).`); });
      });
      // Stored totals that disagree with the matches
      if (t.score1 !== undefined && t.score1 !== '' && (Number(t.score1) !== d.score1 || Number(t.score2) !== d.score2))
        add('info', y, `Stored score ${t.score1}–${t.score2} differs from the matches (${d.score1}–${d.score2}). The site uses the matches.`);
    });
    return out;
    function rn(m) { return m.round_name || m.format || 'Match'; }
  };

  /** Fill in derived fields on every tour and rebuild the scores list. Mutates data. */
  CC.deriveAll = function (data) {
    const scores = [];
    (data.tours || []).forEach(t => {
      const d = CC.deriveTour(t, data.matches || []);
      if (!d.matches.length) return;
      t.score1 = fmt(d.score1); t.score2 = fmt(d.score2);
      t.winner = d.winnerText;
      t._teams = d.teams;
      scores.push(...d.scores);
    });
    data.scores = scores;
    return data;
    function fmt(n) { return String(n); }
  };

  global.CC = CC;
})(typeof window !== 'undefined' ? window : globalThis);
