'use strict';
const initSqlJs = require('sql.js');
const fs   = require('fs');
const path = require('path');
const P    = path.join(__dirname, 'data', 'dividends.db');
(async () => {
  const SQL = await initSqlJs();
  const db  = new SQL.Database(fs.existsSync(P) ? fs.readFileSync(P) : null);
  db.run('DELETE FROM dividend_cache');
  fs.writeFileSync(P, db.export());
  db.close();
  console.log('dividend_cache cleared');
})();
