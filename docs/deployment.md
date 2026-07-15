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
