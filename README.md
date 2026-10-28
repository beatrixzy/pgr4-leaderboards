# PGR4 Leaderboards

Live leaderboards for PGR4-Recomp, the Project Gotham Racing 4
static recompilation: time attack, arcade, test track, co-op and world challenge boards, filled
by players' in-game results.

The page polls the leaderboard API (a Cloudflare Worker) every few seconds; the API address is in
`config.js`. Append `?api=<url>` to point the page at another server, e.g. a local test server.

Fan project, not affiliated with Bizarre Creations, Microsoft or Activision.
