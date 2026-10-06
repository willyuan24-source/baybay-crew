import 'dotenv/config';

// a blank value in .env counts as unset
const env = (k, d = '') => (process.env[k] ?? '').trim() || d;

export const config = {
  port: Number(env('PORT', '8787')) || 8787,
  // 0.0.0.0 (or ::) also serves this machine's LAN addresses and name; ALLOWED_HOSTS (comma-separated) adds other Host
  // names, e.g. a tunnel, a proxy or a port mapping ("demo.example.com", "localhost:3000") — any other Host gets 403
  host: env('HOST', '127.0.0.1'),
  allowedHosts: env('ALLOWED_HOSTS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  crusoe: {
    apiKey: env('CRUSOE_API_KEY'),
    baseUrl: env('CRUSOE_BASE_URL', 'https://api.inference.crusoecloud.com/v1'),
    // only a fallback: every agent has its own model below
    model: env('CRUSOE_MODEL', 'deepseek-ai/Deepseek-V4-Flash'),
    // one open model per agent (three different models: a cross-model review)
    models: {
      Scout: env('CRUSOE_SCOUT_MODEL', 'deepseek-ai/Deepseek-V4-Flash'),
      Planner: env('CRUSOE_PLANNER_MODEL', 'deepseek-ai/DeepSeek-V4-Pro'),
      Checker: env('CRUSOE_CHECKER_MODEL', 'google/gemma-4-31b-it'),
    },
  },
  neo4j: {
    uri: env('NEO4J_URI'),
    user: env('NEO4J_USERNAME', 'neo4j'),
    password: env('NEO4J_PASSWORD'),
    database: env('NEO4J_DATABASE', ''),
  },
  band: {
    roomId: env('BAND_ROOM_ID'),
    agents: Object.fromEntries(['BAYBAY', 'SCOUT', 'PLANNER', 'CHECKER'].map(p => [p, { id: env(`${p}_AGENT_ID`), key: env(`${p}_API_KEY`) }])),
    pollMs: Number(env('BAND_POLL_MS', '800')) || 800,
  },
};

export const crusoeOn = () => !!config.crusoe.apiKey;
export const neo4jOn = () => !!(config.neo4j.uri && config.neo4j.password);
export const bandOn = () => Object.values(config.band.agents).every(a => a.id && a.key);
