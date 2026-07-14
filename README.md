# dtp-wa-channel

Datipay WhatsApp channel service (DTP-WA-001). v0 = webhook receiver + echo.
Zero dependencies — Node >= 22 standard library only. `node src/index.js`.

## Env
| var | source |
|---|---|
| WA_VERIFY_TOKEN | any string you choose; must match Meta webhook config |
| WA_APP_SECRET | Meta App Settings > Basic > App Secret |
| WA_ACCESS_TOKEN | WhatsApp API Setup page (temporary token for v0) |
| WA_PHONE_NUMBER_ID | WhatsApp API Setup page |

## Deploy (triberix)
Cluster pulls this repo at pod start (same pattern as hsi-web, no build step).
Manifests in `deploy/`. Update secret + `kubectl -n datipay rollout restart deployment dtp-wa-channel` to ship.

## Meta webhook config
Callback URL: `https://wa.datipay.com/webhook` · Verify token: value of WA_VERIFY_TOKEN · Subscribe to `messages`.
