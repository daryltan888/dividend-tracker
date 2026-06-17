'use strict';
const axios   = require('./node_modules/axios');
const cheerio = require('./node_modules/cheerio');

async function test() {
  const r = await axios.get('https://www.dividends.sg/view/OV8', {
    timeout: 15000,
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' }
  });
  const $ = cheerio.load(r.data);

  let table = null;
  $('table').each((_, el) => {
    if (table) return;
    const hdr = $(el).find('thead').text() || $(el).find('tr').first().text() || '';
    if (/Ex Date/i.test(hdr)) table = el;
  });
  if (!table) { console.log('No dividend table found'); return; }

  const $t = $(table);
  const headers = $t.find('thead th').map((_, e) => $(e).text().trim()).get();
  console.log('Headers:', headers);
  console.log('\nAll tbody rows (td count + raw text):');
  $t.find('tbody tr').each((i, row) => {
    const tds = $(row).find('td');
    const cells = tds.map((_, c) => {
      const rs = $(c).attr('rowspan');
      return `"${$(c).text().trim()}"${rs ? `[rs=${rs}]` : ''}`;
    }).get();
    console.log(`  row ${i}: [${tds.length}] ${cells.join(' | ')}`);
  });
}

test().catch(e => console.error('ERR:', e.message));
