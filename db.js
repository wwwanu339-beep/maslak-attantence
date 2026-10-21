const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Neon കണക്ഷന് SSL ആവശ്യമാണ്
  }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Neon DB കണക്ഷൻ പരാജയപ്പെട്ടു:', err.stack);
  } else {
    console.log('Neon DB വിജയകരമായി കണക്റ്റ് ചെയ്തു!');
    release();
  }
});

module.exports = pool;