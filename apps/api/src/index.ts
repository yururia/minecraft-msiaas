import { Hono } from 'hono';
import { cors } from 'hono/cors';
// cache-buster: 2026-05-26T21:32:31
import { authMiddleware } from './middleware/auth';
import modsApp from './routes/mods';
import presetsApp from './routes/presets';
import serversApp from './routes/servers';
import settingsApp from './routes/settings';

export type Bindings = {
  DB: D1Database;
  PROVISIONING_QUEUE: Queue;
  CURSEFORGE_API_KEY?: string;
};

type Variables = {
  user: any;
};

const app = new Hono<{ Bindings: Bindings, Variables: Variables }>();

app.get('/', (c) => c.text('MSIaaS API is running.'));

app.get('/health', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').all();
    return c.json({ status: 'ok', db_connection: true, users_count: results[0].count });
  } catch (error: any) {
    return c.json({ status: 'error', db_connection: false, error: error.message }, 500);
  }
});

// Middleware
app.use('/api/*', cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Cf-Access-Jwt-Assertion', 'X-Mock-User-Id', 'X-Mock-Email', 'Authorization', 'X-File-Name'],
  credentials: true,
}));
app.use('/api/*', authMiddleware);

// Routes
app.route('/api/mods', modsApp);
app.route('/api/presets', presetsApp);
app.route('/api/servers', serversApp);
app.route('/api/settings', settingsApp);

import { scheduledHandler } from './scheduled';

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};
