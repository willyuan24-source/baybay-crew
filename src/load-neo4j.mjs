import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import { config, neo4jOn } from './config.mjs';

/**
 * Load data/graph.json (exported from BAYLINK) into Neo4j Aura. Usage: npm run load — into a dedicated database: it replaces
 * every :Entity node (the label this project gives all its nodes) and their relationships, and it never touches nodes
 * without :Entity (it stops if any of them is linked to an :Entity node). Idempotent: run it again, get the same graph.
 */
if (!neo4jOn()) { console.error('Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD in .env first.'); process.exit(1); }
const G = JSON.parse(readFileSync(new URL('../data/graph.json', import.meta.url), 'utf8'));
const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), { disableLosslessIntegers: true });
const db = { database: config.neo4j.database || undefined };
const q = (cypher, params = {}) => driver.executeQuery(cypher, params, db);
const count = async cypher => Number((await q(cypher)).records[0].get('c'));

const clean = props => Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'object' && !Array.isArray(v))));

try {
  await driver.verifyConnectivity();
  console.log(`connected to ${config.neo4j.uri}${db.database ? ` (database ${db.database})` : ''}`);
  const ours = await count('MATCH (n:Entity) RETURN count(n) AS c');
  const others = await count('MATCH (n) WHERE NOT n:Entity RETURN count(n) AS c');
  if (others) {
    console.log(`${others} nodes without the :Entity label are not this project's: they are left untouched`);
    const linked = await count('MATCH (:Entity)-[r]-(n) WHERE NOT n:Entity RETURN count(r) AS c');
    if (linked) throw new Error(`${linked} relationships link :Entity nodes to those other nodes, and replacing the :Entity nodes would delete them. Load into a dedicated, empty database instead.`);
  }
  console.log(`replacing ${ours} :Entity nodes with the ${G.nodes.length} nodes and ${G.rels.length} relationships of data/graph.json`);
  await q('CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (n:Entity) REQUIRE n.key IS UNIQUE');
  for (const l of ['Event', 'Venue', 'Place', 'Neighborhood', 'Station', 'Line', 'Offer', 'Opening', 'City', 'Category']) await q(`CREATE INDEX ${l.toLowerCase()}_id IF NOT EXISTS FOR (n:${l}) ON (n.id)`);
  let deleted = 0;
  for (;;) { const c = await count('MATCH (n:Entity) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS c'); deleted += c; if (!c) break; }
  console.log('cleared', deleted);
  const byLabel = new Map();
  for (const n of G.nodes) (byLabel.get(n.label) ?? byLabel.set(n.label, []).get(n.label)).push({ key: n.id, props: clean(n.props) });
  for (const [label, rows] of byLabel) {
    for (let i = 0; i < rows.length; i += 500) await q(`UNWIND $rows AS row MERGE (n:Entity {key: row.key}) SET n += row.props, n:${label}`, { rows: rows.slice(i, i + 500) });
    console.log(label, rows.length);
  }
  const byType = new Map();
  for (const r of G.rels) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)).push({ from: r.from, to: r.to, props: clean(r.props ?? {}) });
  for (const [type, rows] of byType) {
    for (let i = 0; i < rows.length; i += 1000) await q(`UNWIND $rows AS row MATCH (a:Entity {key: row.from}), (b:Entity {key: row.to}) MERGE (a)-[r:${type}]->(b) SET r += row.props`, { rows: rows.slice(i, i + 1000) });
    console.log(type, rows.length);
  }
  const s = (await q('MATCH (n:Entity) WITH count(n) AS nodes OPTIONAL MATCH (:Entity)-[r]->(:Entity) RETURN nodes, count(r) AS rels')).records[0];
  const unique = new Set(G.rels.map(r => `${r.from}|${r.type}|${r.to}`)).size;
  console.log(`loaded ${Number(s.get('nodes'))} nodes · ${Number(s.get('rels'))} relationships (data/graph.json has ${G.rels.length} relationship rows; MERGE keeps one per pair and type: ${unique})`);
} catch (e) {
  console.error('load failed:', e.message);
  process.exitCode = 1;
} finally {
  await driver.close();
}
