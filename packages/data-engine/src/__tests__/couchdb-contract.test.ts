/**
 * Runs the shared provider contract suite against a live CouchDB.
 *
 * Opt-in: set COUCHDB_URL (and optionally COUCHDB_USER / COUCHDB_PASSWORD)
 * to run; skipped otherwise so `npm test` stays green without infrastructure.
 *
 *   docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=password apache/couchdb:3
 *   COUCHDB_URL=http://127.0.0.1:5984 COUCHDB_USER=admin COUCHDB_PASSWORD=password npx jest couchdb-contract
 */

import { providerContractSuite } from './provider-contract.test';
import { CouchDbDataEngine } from '../providers/couchdb/couchdb-engine';

const url = process.env.COUCHDB_URL;

if (!url) {
  describe('CouchDB provider contract', () => {
    it.skip('skipped — set COUCHDB_URL to run against a live CouchDB', () => {
      /* intentionally skipped */
    });
  });
} else {
  providerContractSuite('CouchDB', () => {
    return new CouchDbDataEngine({
      provider: 'couchdb',
      connectionString: url,
      username: process.env.COUCHDB_USER || 'admin',
      password: process.env.COUCHDB_PASSWORD || 'password',
      container: 'basefyio-contract-test',
      namespace: 'projects',
      maxDocumentKb: 1024,
      maxNestingDepth: 8,
      maxArrayItems: 1000,
    });
  });
}
