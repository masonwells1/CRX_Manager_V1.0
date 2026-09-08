## 2026-09-08 - Proof-chain review fixes

Closed four independent review findings: SECURITY DEFINER bodies now reject the
`SET SCHEMA` search-path alias, renamed RPC destructuring is detected, proof
collection no longer executes the ignored TypeScript parser, and the migration
wrappability helper is bound into the protected proof chain.
