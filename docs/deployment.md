# Deployment

1. Install Node.js 20 or newer.
2. Provision MongoDB Atlas or a secured MongoDB server.
3. Create `.env` from `.env.example` with real values.
4. Run `npm run setup:clinic` with the private Atlas URI before enabling production mode.
5. Run `npm install`, `npm test`, `npm run check:dummy-content`, and `npm run build`.
6. Start with `npm start` or PM2 only after configuration validation passes.
7. Put the app behind HTTPS.
8. Configure the Meta webhook URL as `/api/whatsapp/webhook`.
9. Check `/api/health` for `mongoConnected: true`.
10. Create the first Super Admin.
11. Add approved WhatsApp utility template names.
12. Test booking, lookup, reschedule, cancel, opt-out, reminders, and WhatsApp logs.

Hostinger must use the repository root, Node.js 20 or newer, `npm run build` as the build command, and `npm start` as the start command. Record the stable commit before deployment. Roll back by redeploying that commit without changing or deleting MongoDB records.

The verified production origin is `https://admin.nighatmedicalcomplex.com`. When URL, CORS, timezone, or authentication-secret variables are absent, the runtime supplies secure launch defaults for this origin. Explicit long authentication secrets remain recommended because generated secrets invalidate staff sessions whenever the Node process restarts. The HTTP listener opens before Atlas initialization so a slow or blocked database connection cannot cause Hostinger's platform-level 503 page; database-backed API routes remain safely unavailable until Atlas connects.

For a web-only Hostinger launch before Meta approval, set `WHATSAPP_REQUIRED=false`. The application will serve patient booking and administration normally while WhatsApp delivery remains disabled. Set it to `true` only after all required Meta credentials have been added.

Minimum Hostinger production variables before Meta setup:

```dotenv
NODE_ENV=production
MONGODB_URI=<private Atlas URI with a rotated password>
JWT_ACCESS_SECRET=<at least 32 random characters>
JWT_REFRESH_SECRET=<at least 32 random characters>
COOKIE_SECRET=<at least 32 random characters>
ADMIN_BOOTSTRAP_TOKEN=<at least 32 random characters>
APP_BASE_URL=https://YOUR_DOMAIN
CLIENT_BASE_URL=https://YOUR_DOMAIN
API_BASE_URL=https://YOUR_DOMAIN/api
CORS_ALLOWED_ORIGINS=https://YOUR_DOMAIN
DEFAULT_TIMEZONE=Asia/Karachi
TRUST_PROXY=1
WHATSAPP_REQUIRED=false
```

Do not set a fixed `PORT` when the hosting platform supplies one. The application reads Hostinger's runtime `PORT` automatically. After changing variables, redeploy and verify `/api/health` reports both `status: "ok"` and `mongoConnected: true`.

MongoDB Atlas only accepts connections from addresses in the project's Network Access list. Add the Hostinger application server's outbound IP (or the narrowest CIDR supplied by Hostinger) before redeploying. Do not leave `0.0.0.0/0` enabled for production. Hostinger's Node.js Database Connect Wizard can also be used to connect an Atlas project and apply its variables during the next deployment.

PM2 example:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Nginx should proxy HTTPS traffic to the Node port and pass `X-Forwarded-Proto`.

Operational checks:

- Schedule MongoDB Atlas backups or run the provided backup scripts from a secured operator machine.
- Test restore into a separate database before launch.
- Rotate Node, PM2, proxy, and platform logs.
- Monitor WhatsApp failed-message logs and Meta WhatsApp Manager quality status during launch week.
- Pause non-essential sends if local failure-rate warnings appear.
