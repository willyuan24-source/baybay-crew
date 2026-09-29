import 'dotenv/config';

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const config = {
  port: Number(env('PORT', '8787')),
  crusoe: {
    apiKey: env('CRUSOE_API_KEY'),
    baseUrl: env('CRUSOE_BASE_URL', 'https://api.inference.crusoecloud.com/v1'),
    model: env('CRUSOE_MODEL', 'moonshotai/Kimi-K2.6'),
    // one open model per agent (three different models: a cross-model review)
    models: {
      Scout: env('CRUSOE_SCOUT_MODEL', 'deepseek-ai/Deepseek-V4-Flash'),
      Planner: env('CRUSOE_PLANNER_MODEL', 'deepseek-ai/DeepSeek-V4-Pro'),
      Checker: env('CRUSOE_CHECKER_MODEL', 'google/gemma-4-31b-it'),
    },
    checkerModel: env('CRUSOE_CHECKER_MODEL', 'google/gemma-4-31b-it'),
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
    pollMs: Number(env('BAND_POLL_MS', '800')),
  },
};

export const crusoeOn = () => !!config.crusoe.apiKey;
export const neo4jOn = () => !!(config.neo4j.uri && config.neo4j.password);
export const bandOn = () => Object.values(config.band.agents).every(a => a.id && a.key);
