import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth';
import modsApp from './routes/mods';
import presetsApp from './routes/presets';
import serversApp from './routes/servers';
import settingsApp from './routes/settings';
import { scheduledHandler } from './scheduled';

export type Bindings = {
  DB: D1Database;
  PROVISIONING_QUEUE: Queue;
  CURSEFORGE_API_KEY?: string;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  INTERNAL_API_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

export type Variables = {
  user: any;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'tauri://localhost',
  'https://tauri.localhost',
];

app.get('/', (c) => c.text('MSIaaS API is running.'));

app.get('/health', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').all();
    return c.json({ status: 'ok', db_connection: true, users_count: results[0].count });
  } catch (error: any) {
    return c.json({ status: 'error', db_connection: false, error: error.message }, 500);
  }
});

// Middleware: Origin Whitelist Validation (Fixes CORS Reflection Vulnerability)
app.use('/api/*', cors({
  origin: (origin, c) => {
    if (!origin) return DEFAULT_ALLOWED_ORIGINS[0];
    const customOrigins = c.env?.ALLOWED_ORIGINS
      ? c.env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim()).filter(Boolean)
      : [];
    const allowedList = [...DEFAULT_ALLOWED_ORIGINS, ...customOrigins];
    return allowedList.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Cf-Access-Jwt-Assertion',
    'X-Mock-User-Id',
    'X-Mock-Email',
    'X-Internal-Token',
    'X-File-Name',
    'Authorization',
  ],
  credentials: true,
}));

app.use('/api/*', authMiddleware);

// Routes
app.route('/api/mods', modsApp);
app.route('/api/presets', presetsApp);
app.route('/api/servers', serversApp);
app.route('/api/settings', settingsApp);

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
};
