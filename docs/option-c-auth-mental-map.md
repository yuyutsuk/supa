# Option C auth mental map

```text
Option C: Cloudflare Access is Authentication (AuthN)
|
|- 1. Client reaches items-api-worker
|  |
|  |- Cloudflare Access protects the hostname
|  |- Access applies its Allow policy
|  |- Client signs in through the configured identity provider if needed
|  `- Access forwards Cf-Access-Jwt-Assertion to the Worker
|
|- 2. Worker trusts Cloudflare Access only after cryptographic validation
|  |
|  |- Reads Cf-Access-Jwt-Assertion
|  |- Downloads/caches Cloudflare Access JWKS
|  |- Checks RS256 signature
|  |- Checks issuer == CF_ACCESS_TEAM_DOMAIN
|  |- Checks audience == CF_ACCESS_AUD for this exact application
|  `- Extracts trusted identity: Access sub + email
|
|- 3. Worker becomes a tightly scoped token bridge
|  |
|  |- Does not forward the Access JWT to Supabase
|  |- Uses Worker-only ES256 private JWK
|  |- Mints a new five-minute JWT
|  |  |
|  |  |- sub = Cloudflare Access sub
|  |  |- email = Cloudflare Access email
|  |  |- cf_access_sub = Cloudflare Access sub (traceability)
|  |  |- role = authenticated
|  |  |- iat = issuance time
|  |  `- exp = issuance time + 5 minutes
|  `- Never returns or logs that bridge JWT
|
|- 4. Supabase trusts the bridge token, not the Access token
|  |
|  |- Worker sends publishable key as apikey
|  |- Worker sends bridge JWT as Authorization Bearer token
|  |- Data API selects the imported public key using JWT kid
|  |- Data API verifies ES256 signature and expiry
|  `- Supabase now sees role = authenticated and sub = Access sub
|
|- 5. Postgres makes Authorization (AuthZ) decision
|  |
|  |- Request role is authenticated
|  |- auth.uid() resolves from bridge JWT sub
|  `- Existing RLS policies allow/deny each row and mutation
|
`- 6. Migration boundary: not solved yet
   |
   |- Existing Supabase Auth user IDs may not equal Access sub
   |- Existing items.user_id may therefore not match auth.uid()
   |- GoTrue remains enabled; its current JWT path keeps working
   `- Later: design explicit Access-sub/email -> old user_id mapping before
      rewriting ownership or changing RLS
```

## One-line ownership rule

The bridge makes `auth.uid()` equal the validated Cloudflare Access `sub`; RLS
will only see existing rows when their `user_id` uses that same UUID.
