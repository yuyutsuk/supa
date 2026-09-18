# Better Auth Manual Test (No Service Token)

## 1) Setup

```bash
BASE_URL="https://items-api-worker.gaurkuber.workers.dev"
COOKIE_JAR="/tmp/bottomo.cookies"
EMAIL="manual.$(date +%s)@example.com"
PASS="SmokeTest123"
```

## 2) Get user Access token via browser login

```bash
cloudflared access login "$BASE_URL"
ACCESS_TOKEN="$(cloudflared access token "$BASE_URL")"
```

## 3) Sign up (creates Better Auth user/account/session)

```bash
curl -sS -i -X POST "$BASE_URL/api/auth/sign-up/email" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "content-type: application/json" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  --data "{\"name\":\"Bottomo User\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
```

## 4) Login (existing user)

```bash
curl -sS -i -X POST "$BASE_URL/api/auth/sign-in/email" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "content-type: application/json" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
```

## 5) Get session (confirm Better Auth UUID)

```bash
curl -sS "$BASE_URL/api/auth/get-session" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR"
```

## 6) Query app API (RLS path via Worker)

```bash
# create item
curl -sS -i -X POST "$BASE_URL/" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -H "content-type: application/json" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  --data '{"name":"manual-item"}'

# list items
curl -sS "$BASE_URL/" \
  -H "cf-access-token: $ACCESS_TOKEN" \
  -H "origin: $BASE_URL" \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR"
```

## Notes

- No service token is used in this flow.
- If `cloudflared access token` fails, run `cloudflared access login` again.
- Access token and Better Auth session cookie are separate layers.
