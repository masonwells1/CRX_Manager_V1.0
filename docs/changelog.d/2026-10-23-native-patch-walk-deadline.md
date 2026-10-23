## 2026-10-23 - native patch: the link walk checks the deadline between lookups

Luna review round 9 on the native `apply_patch` route. The deadline check ran only between
destinations, so one destination's walk of path components could not be cut short. The walk
(`realPathThroughLinks`) now checks the hook deadline before every lookup and gives up (the caller
refuses) once it has passed. The same round claimed that millions of content lines could outrun the
hook before a protected destination is denied; measured instead: a 24 MB patch of 8 million lines
parses in under a second and is denied, and the suite now pins a 4-million-line case. Rename-only
patches (an Update File with a Move to and no hunk) stay refused, as the real applier also requires a
hunk.
