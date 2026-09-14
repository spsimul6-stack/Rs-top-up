# RS Top Up — Complete Payment/Order Project

This project replaces the current browser-only demo with a real server-side order/payment flow.

## Included
- RS Top Up frontend
- Server-side product prices (customer cannot change the price sent to the server)
- SQLite database
- SSLCOMMERZ hosted checkout
- Success/fail/cancel callbacks
- IPN endpoint
- Server-side payment validation
- Amount + currency verification before marking a payment paid
- Order statuses: PENDING → PROCESSING → COMPLETED / FAILED / REFUNDED / CANCELLED
- Wallet Add Money using the same gateway
- Basic admin page/API protected by `ADMIN_KEY`

SSLCOMMERZ's current documentation requires a Store ID/password and describes the session API, IPN, and server-side validation flow. The project uses those server-side credentials; they are never put in `index.html`.

## Run locally

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Put your SSLCOMMERZ sandbox Store ID/password in `.env`.
4. Set `BASE_URL` to the URL that the payment gateway can reach. For local testing, use a public HTTPS tunnel/domain; `localhost` callbacks will not work from the gateway.
5. Run:
   npm install
   npm start
6. Open the site in a browser.

## Go live

Set:
SSLCZ_IS_LIVE=true
and use your real SSLCOMMERZ Store ID/password. Your production domain must use HTTPS and the callback/IPN URLs must be reachable.

Do not put Store ID/password or ADMIN_KEY in frontend JavaScript or GitHub public files.

## Admin

Open `/admin.html` and enter the `ADMIN_KEY` from `.env`.

## Important

The code verifies the payment with SSLCOMMERZ before changing payment_status to PAID. It does NOT automatically fulfill a game top-up because that requires the specific game/provider API and credentials. After payment is verified, the order is PROCESSING and an admin/provider integration can complete it.

The existing site's hard-coded personal payment numbers and promo-code UI were intentionally not copied into the new payment flow. Configure business contact/payment settings on the server instead.

## Database

`data.sqlite` is created automatically on first start. Back it up before deploying updates.

## Security checklist

- Use HTTPS.
- Use a strong random ADMIN_KEY.
- Keep `.env` out of Git.
- Use a real SSLCOMMERZ merchant account for production.
- Restrict admin access further (VPN/SSO/IP allowlist) for a public production deployment.
- Add rate limiting and CSRF/session protections if you later add customer login or browser-cookie authentication.
