# Better Auth Manual Test (Bearer Token)

## 1) Setup

```bash
BASE_URL="https://items-api-worker.gaurkuber.workers.dev"
EMAIL="kgaur@cloudflare.com"
PASS="<your-current-password>"
```

## 2) Sign in and capture Better Auth bearer token

```bash
AUTH_TOKEN="$({
  curl -sS -o /tmp/bottomo.signin.json \
    -w "%header{set-auth-token}" \
    -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H "origin: $BASE_URL" \
    -H "content-type: application/json" \
    --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}";
} | tr -d '\r\n')"

test -n "$AUTH_TOKEN" && echo "Better Auth bearer token captured"
```

## 3) Get session (confirm Better Auth UUID)

```bash
curl -sS "$BASE_URL/api/auth/get-session" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"
```

## 4) Query app API (RLS path via Worker)

```bash
# create item
curl -sS -i -X POST "$BASE_URL/" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  --data '{"name":"manual-item"}'

# list items
curl -sS "$BASE_URL/" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"
```

## Notes

- Cloudflare Access token is no longer required for this flow.
- If an API response includes `set-auth-token`, replace `AUTH_TOKEN` with that value (token rotation).
