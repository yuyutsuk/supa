# Better Auth Manual Test (Bearer Token, No Service Token)

## 1) Setup

```bash
BASE_URL="https://items-api-worker.gaurkuber.workers.dev"
EMAIL="kgaur@cloudflare.com"
PASS="<your-current-password>"
```

## 2) Get user Access token via browser login

```bash
cloudflared access login "$BASE_URL"
ACCESS_TOKEN="$(cloudflared access token "$BASE_URL")"
```

## 3) Sign in and capture Better Auth bearer token

```bash
AUTH_TOKEN="$({
  curl -sS -o /tmp/bottomo.signin.json \
    -w "%header{set-auth-token}" \
    -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H "cf-access-token: $ACCESS_TOKEN" \
    -H "origin: $BASE_URL" \
    -H "content-type: application/json" \
    --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}";
} | tr -d '\r\n')"

test -n "$AUTH_TOKEN" && echo "Better Auth bearer token captured"
```

## 4) Get session (confirm Better Auth UUID)

```bash
curl -sS "$BASE_URL/api/auth/get-session" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"
```

## 5) Query app API (RLS path via Worker)

```bash
# create item
curl -sS -i -X POST "$BASE_URL/" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H "content-type: application/json" \
  --data '{"name":"manual-item"}'

# list items
curl -sS "$BASE_URL/" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"
```

## Notes

- No service token is used in this flow.
- If `cloudflared access token` fails, run `cloudflared access login` again.
- `cf-access-token` and Better Auth bearer token are separate layers.
- If an API response includes `set-auth-token`, replace `AUTH_TOKEN` with that value (token rotation).
